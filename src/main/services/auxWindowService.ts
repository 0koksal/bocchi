import { BrowserWindow, ipcMain, shell, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { settingsService } from './settingsService'
import { lcuConnector } from './lcuConnector'
import { gameflowMonitor } from './gameflowMonitor'

class AuxWindowService {
  private auxWindow: BrowserWindow | null = null
  private autoShowEnabled = true
  private currentPhase = 'None'

  initialize(_mainWindow: BrowserWindow): void {
    this.autoShowEnabled = settingsService.get('auxAutoShow') !== false
    this.setupIpcHandlers()
    this.setupGameflowListeners()
  }

  private setupGameflowListeners(): void {
    // Listen for phase changes to auto-show/hide
    gameflowMonitor.on('phase-changed', (phase: string, previousPhase: string) => {
      this.currentPhase = phase

      // Forward to aux window
      if (this.auxWindow && !this.auxWindow.isDestroyed()) {
        this.auxWindow.webContents.send('aux:phase-changed', { phase, previousPhase })
      }

      // Auto-show on ChampSelect
      if (this.autoShowEnabled && phase === 'ChampSelect') {
        this.showWindow()
      }

      // Auto-hide when leaving ChampSelect (if auto-show is on)
      if (this.autoShowEnabled && previousPhase === 'ChampSelect' && phase !== 'ChampSelect') {
        this.hideWindow()
      }
    })

    // Forward champ-select session updates to aux window
    lcuConnector.on('champ-select-session', (session: any) => {
      if (this.auxWindow && !this.auxWindow.isDestroyed()) {
        this.auxWindow.webContents.send('aux:champ-select-update', session)
      }
    })
  }

  /**
   * Forward theme CSS to the aux window. Called from main window when theme changes.
   */
  forwardTheme(cssVariables: string, isDark: boolean): void {
    if (this.auxWindow && !this.auxWindow.isDestroyed()) {
      this.auxWindow.webContents.send('aux:theme-changed', { cssVariables, isDark })
    }
  }

  private setupIpcHandlers(): void {
    // Window controls
    ipcMain.on('aux:close', () => {
      this.hideWindow()
    })

    ipcMain.on('aux:minimize', () => {
      if (this.auxWindow && !this.auxWindow.isDestroyed()) {
        this.auxWindow.minimize()
      }
    })

    ipcMain.on('aux:pin', (_, pin: boolean) => {
      if (this.auxWindow && !this.auxWindow.isDestroyed()) {
        this.auxWindow.setAlwaysOnTop(pin, 'floating')
      }
    })

    ipcMain.on('aux:set-opacity', (_, opacity: number) => {
      if (this.auxWindow && !this.auxWindow.isDestroyed()) {
        this.auxWindow.setOpacity(Math.max(0.3, Math.min(1, opacity)))
      }
    })

    // Dodge champ select
    ipcMain.handle('aux:dodge', async () => {
      try {
        if (!lcuConnector.isConnected()) {
          return { success: false, error: 'Not connected to League Client' }
        }

        // Same endpoint and body as PenguLoader dodge plugins use
        const endpoint =
          '/lol-login/v1/session/invoke?destination=lcdsServiceProxy&method=call&args=["","teambuilder-draft","quitV2",""]'
        const body = '["","teambuilder-draft","quitV2",""]'

        // Try multiple times like the plugin does (it sends 10 attempts)
        let lastError = ''
        for (let i = 0; i < 10; i++) {
          try {
            await lcuConnector.rawRequest('POST', endpoint, body)
            return { success: true }
          } catch (err: any) {
            lastError = err.message || 'Unknown error'
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }

        // Fallback: try cancel-champ-select (for custom games)
        try {
          await lcuConnector.request('POST', '/lol-lobby/v1/lobby/custom/cancel-champ-select', null)
          return { success: true }
        } catch {
          return { success: false, error: lastError }
        }
      } catch (err: any) {
        return { success: false, error: err.message || 'Unknown error' }
      }
    })

    // Get champ select players for lobby reveal
    ipcMain.handle('aux:get-champ-select-players', async () => {
      try {
        if (!lcuConnector.isConnected()) {
          return { success: false, error: 'Not connected' }
        }

        // Get champ select session
        const session = await lcuConnector.request('GET', '/lol-champ-select/v1/session')
        if (!session || !session.myTeam) {
          return { success: false, error: 'Not in champ select' }
        }

        // Get summoner names for all players in the game
        const allPlayers = [...(session.myTeam || []), ...(session.theirTeam || [])]
        const players: { summonerName: string; championId: number; teamId: number }[] = []

        for (const player of allPlayers) {
          if (!player.summonerId || player.summonerId === 0) continue

          try {
            const summoner = await lcuConnector.request(
              'GET',
              `/lol-summoner/v1/summoners/${player.summonerId}`
            )
            players.push({
              summonerName: summoner.gameName
                ? `${summoner.gameName}#${summoner.tagLine}`
                : summoner.displayName || summoner.internalName || `Player ${player.summonerId}`,
              championId: player.championId || player.championPickIntent || 0,
              teamId: player.team || 0
            })
          } catch {
            // If we can't get summoner info, try with cellId
            players.push({
              summonerName: `Player ${player.cellId || player.summonerId}`,
              championId: player.championId || 0,
              teamId: player.team || 0
            })
          }
        }

        return { success: true, players }
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to get players' }
      }
    })

    // Get current summoner (for region detection)
    ipcMain.handle('aux:get-current-summoner', async () => {
      try {
        if (!lcuConnector.isConnected()) {
          return { success: false, error: 'Not connected' }
        }

        const summoner = await lcuConnector.request('GET', '/lol-summoner/v1/current-summoner')
        // Try to get region from platform config
        let region = 'EUW1'
        try {
          const regionData = await lcuConnector.request('GET', '/riotclient/region-locale')
          region = regionData.region || regionData.webRegion || 'EUW1'
        } catch {
          // fallback
        }

        return {
          success: true,
          summonerName: summoner.gameName
            ? `${summoner.gameName}#${summoner.tagLine}`
            : summoner.displayName,
          region
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // Settings
    ipcMain.handle('aux:get-settings', () => {
      return {
        autoShow: settingsService.get('auxAutoShow') !== false,
        opacity: settingsService.get('auxOpacity') || 1,
        pinned: settingsService.get('auxPinned') !== false
      }
    })

    ipcMain.handle('aux:set-settings', (_, settings: any) => {
      if (settings.autoShow !== undefined) {
        settingsService.set('auxAutoShow', settings.autoShow)
        this.autoShowEnabled = settings.autoShow
      }
      if (settings.opacity !== undefined) {
        settingsService.set('auxOpacity', settings.opacity)
      }
      if (settings.pinned !== undefined) {
        settingsService.set('auxPinned', settings.pinned)
      }
    })

    // Get current phase (for when window opens mid-game)
    ipcMain.handle('aux:get-current-phase', () => {
      return this.currentPhase
    })

    // Forward theme from main renderer to aux window
    ipcMain.on('aux:forward-theme', (_, data: { cssVariables: string; isDark: boolean }) => {
      this.forwardTheme(data.cssVariables, data.isDark)
    })

    // Toggle from main window
    ipcMain.handle('aux:toggle', () => {
      if (this.auxWindow && !this.auxWindow.isDestroyed() && this.auxWindow.isVisible()) {
        this.hideWindow()
      } else {
        this.showWindow()
      }
      return { visible: this.auxWindow?.isVisible() || false }
    })

    ipcMain.handle('aux:is-visible', () => {
      return this.auxWindow && !this.auxWindow.isDestroyed() && this.auxWindow.isVisible()
    })

    // Auto Pick / Auto Ban toggles
    ipcMain.handle('aux:get-auto-settings', () => {
      return {
        autoPickEnabled: settingsService.get('autoPickEnabled') || false,
        autoBanEnabled: settingsService.get('autoBanEnabled') || false,
        autoAcceptEnabled: settingsService.get('autoAcceptEnabled') || false,
        autoPickChampions: settingsService.get('autoPickChampions') || [],
        autoBanChampions: settingsService.get('autoBanChampions') || []
      }
    })

    ipcMain.handle('aux:set-auto-pick', (_, enabled: boolean) => {
      settingsService.set('autoPickEnabled', enabled)
      if (this.getMainWindow()) {
        this.getMainWindow()!.webContents.send('settings-changed', 'autoPickEnabled', enabled)
      }
    })

    ipcMain.handle('aux:set-auto-ban', (_, enabled: boolean) => {
      settingsService.set('autoBanEnabled', enabled)
      if (this.getMainWindow()) {
        this.getMainWindow()!.webContents.send('settings-changed', 'autoBanEnabled', enabled)
      }
    })

    ipcMain.handle('aux:set-auto-accept', (_, enabled: boolean) => {
      settingsService.set('autoAcceptEnabled', enabled)
      if (this.getMainWindow()) {
        this.getMainWindow()!.webContents.send('settings-changed', 'autoAcceptEnabled', enabled)
      }
    })

    ipcMain.handle('aux:set-auto-pick-champions', async (_, championIds: number[]) => {
      settingsService.set('autoPickChampions', championIds)
      // Notify main window
      if (this.getMainWindow()) {
        this.getMainWindow()!.webContents.send('settings-changed', 'autoPickChampions', championIds)
      }
      try {
        const { autoBanPickService } = await import('./autoBanPickService')
        autoBanPickService.setPickChampions(championIds)
      } catch {}
    })

    ipcMain.handle('aux:set-auto-ban-champions', async (_, championIds: number[]) => {
      settingsService.set('autoBanChampions', championIds)
      // Notify main window
      if (this.getMainWindow()) {
        this.getMainWindow()!.webContents.send('settings-changed', 'autoBanChampions', championIds)
      }
      try {
        const { autoBanPickService } = await import('./autoBanPickService')
        autoBanPickService.setBanChampions(championIds)
      } catch {}
    })

    ipcMain.handle('aux:get-all-champions', async () => {
      try {
        const champions = await lcuConnector.getAllChampions()
        return { success: true, champions }
      } catch {
        return { success: false, champions: [] }
      }
    })

    ipcMain.handle('aux:get-owned-champions', async () => {
      try {
        const champions = await lcuConnector.getOwnedChampions()
        return { success: true, champions }
      } catch {
        return { success: false, champions: [] }
      }
    })
  }

  private getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows()
    return windows.find((w) => w !== this.auxWindow && !w.isDestroyed()) || null
  }

  showWindow(): void {
    if (!this.auxWindow || this.auxWindow.isDestroyed()) {
      this.createWindow()
    } else {
      this.auxWindow.show()
    }
  }

  hideWindow(): void {
    if (this.auxWindow && !this.auxWindow.isDestroyed()) {
      this.auxWindow.hide()
    }
  }

  private createWindow(): void {
    // Position near bottom-right of the screen
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    const savedBounds = settingsService.get('auxWindowBounds') as
      | { x: number; y: number; width: number; height: number }
      | undefined

    // Reset saved bounds if they're from old smaller window
    const useSavedBounds = savedBounds && savedBounds.width >= 280 && savedBounds.height >= 350

    const windowWidth = 320
    const windowHeight = 500

    this.auxWindow = new BrowserWindow({
      width: useSavedBounds ? savedBounds.width : windowWidth,
      height: useSavedBounds ? savedBounds.height : windowHeight,
      x: useSavedBounds ? savedBounds.x : screenWidth - windowWidth - 20,
      y: useSavedBounds ? savedBounds.y : screenHeight - windowHeight - 60,
      show: false,
      frame: false,
      resizable: true,
      minimizable: true,
      maximizable: false,
      alwaysOnTop: settingsService.get('auxPinned') !== false,
      skipTaskbar: false,
      title: 'Bocchi Mini',
      minWidth: 320,
      minHeight: 500,
      maxWidth: 500,
      maxHeight: 700,
      backgroundColor: '#1e2030',
      roundedCorners: true,
      webPreferences: {
        preload: join(__dirname, '../preload/aux.js'),
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    // Load the aux page
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.auxWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/auxWindow.html`)
    } else {
      this.auxWindow.loadFile(join(__dirname, '../renderer/auxWindow.html'))
    }

    this.auxWindow.on('ready-to-show', () => {
      this.auxWindow?.show()
      // Set opacity from settings
      const opacity = settingsService.get('auxOpacity') || 1
      this.auxWindow?.setOpacity(opacity as number)

      // Send current phase so the window doesn't start stale
      if (this.currentPhase !== 'None') {
        this.auxWindow?.webContents.send('aux:phase-changed', {
          phase: this.currentPhase,
          previousPhase: 'None'
        })
      }
    })

    // Persist window position
    const savePosition = (): void => {
      if (this.auxWindow && !this.auxWindow.isDestroyed()) {
        const bounds = this.auxWindow.getBounds()
        settingsService.set('auxWindowBounds', bounds)
      }
    }

    this.auxWindow.on('moved', savePosition)
    this.auxWindow.on('resized', savePosition)

    this.auxWindow.on('closed', () => {
      this.auxWindow = null
    })

    // Open external links in browser
    this.auxWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  destroy(): void {
    if (this.auxWindow && !this.auxWindow.isDestroyed()) {
      this.auxWindow.destroy()
      this.auxWindow = null
    }
  }
}

export const auxWindowService = new AuxWindowService()
