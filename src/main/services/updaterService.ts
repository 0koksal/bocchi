import { autoUpdater, CancellationToken } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import axios from 'axios'
import * as fs from 'fs'
import * as path from 'path'

export class UpdaterService {
  private mainWindow: BrowserWindow | null = null
  private updateInfo: any = null
  private cancellationToken: CancellationToken | null = null

  constructor() {
    autoUpdater.autoDownload = false
    autoUpdater.autoRunAppAfterInstall = true

    this.setupEventListeners()
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window
  }

  private setupEventListeners() {
    autoUpdater.on('checking-for-update', () => {
      this.sendToWindow('update-checking')
    })

    autoUpdater.on('update-available', (info) => {
      this.updateInfo = info
      this.sendToWindow('update-available', info)
    })

    autoUpdater.on('update-not-available', () => {
      this.sendToWindow('update-not-available')
    })

    autoUpdater.on('error', (err) => {
      this.sendToWindow('update-error', err.message)
    })

    autoUpdater.on('download-progress', (progressObj) => {
      this.sendToWindow('update-download-progress', progressObj)
    })

    autoUpdater.on('update-downloaded', () => {
      this.sendToWindow('update-downloaded')
      // Clean old files so the new version starts fresh
      this.cleanBeforeUpdate()
      // Immediately quit and install
      autoUpdater.quitAndInstall(true, true)
    })
  }

  private sendToWindow(channel: string, data?: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  async checkForUpdates() {
    // Skip update check in development mode
    // if (is.dev) {
    //   console.log('Skipping update check in development mode')
    //   return null
    // }

    try {
      const result = await autoUpdater.checkForUpdates()
      return result
    } catch (error) {
      console.error('Error checking for updates:', error)
      throw error
    }
  }

  async downloadUpdate() {
    try {
      this.cancellationToken = new CancellationToken()
      await autoUpdater.downloadUpdate(this.cancellationToken)
    } catch (error) {
      console.error('Error downloading update:', error)
      throw error
    }
  }

  cancelUpdate() {
    if (this.cancellationToken) {
      this.cancellationToken.cancel()
      this.cancellationToken = null
    }
  }

  quitAndInstall() {
    autoUpdater.quitAndInstall()
  }

  /**
   * Clean old app data before installing an update so the new version starts fresh.
   * This fixes upgrade issues where stale files from old versions cause problems.
   * Downloaded skins and user settings are preserved.
   */
  private cleanBeforeUpdate() {
    const userData = app.getPath('userData')

    // Remove cslol-tools (new version will re-download with LTK patcher)
    const cslolToolsPath = path.join(userData, 'cslol-tools')
    try {
      fs.rmSync(cslolToolsPath, { recursive: true, force: true })
      console.log('[Updater] Cleaned cslol-tools')
    } catch {
      // May not exist
    }

    // Remove imported mods cache (will be re-imported)
    const installedPath = path.join(userData, 'cslol_installed')
    try {
      fs.rmSync(installedPath, { recursive: true, force: true })
      console.log('[Updater] Cleaned cslol_installed')
    } catch {
      // May not exist
    }

    // Remove overlay profiles (will be re-created)
    const profilesPath = path.join(userData, 'profiles')
    try {
      fs.rmSync(profilesPath, { recursive: true, force: true })
      console.log('[Updater] Cleaned profiles')
    } catch {
      // May not exist
    }

    // Remove version files so tools get re-downloaded
    const versionFile = path.join(userData, 'cslol-tools-version.txt')
    try {
      fs.rmSync(versionFile, { force: true })
      console.log('[Updater] Cleaned version file')
    } catch {
      // May not exist
    }

    console.log('[Updater] Pre-update cleanup complete')
  }

  async getChangelog(): Promise<string | null> {
    try {
      // Always fetch latest changes.md from our repo's main branch
      const url = `https://raw.githubusercontent.com/0koksal/bocchi/main/changes.md`
      const response = await axios.get(url)
      return response.data
    } catch (error) {
      console.error('Error fetching changelog:', error)
      return null
    }
  }

  getUpdateInfo() {
    return this.updateInfo
  }
}
