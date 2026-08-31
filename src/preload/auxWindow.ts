import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// Auxiliary window API - minimal, focused on dodge and lobby reveal
const auxApi = {
  // Window controls
  closeAuxWindow: () => ipcRenderer.send('aux:close'),
  minimizeAuxWindow: () => ipcRenderer.send('aux:minimize'),
  pinAuxWindow: (pin: boolean) => ipcRenderer.send('aux:pin', pin),
  setAuxOpacity: (opacity: number) => ipcRenderer.send('aux:set-opacity', opacity),

  // Dodge
  dodgeChampSelect: () => ipcRenderer.invoke('aux:dodge'),

  // Lobby reveal - get summoner names from current champ select
  getChampSelectPlayers: () => ipcRenderer.invoke('aux:get-champ-select-players'),

  // Get current summoner for region detection
  getCurrentSummoner: () => ipcRenderer.invoke('aux:get-current-summoner'),

  // Phase events
  onPhaseChanged: (callback: (data: { phase: string; previousPhase: string }) => void) => {
    const handler = (_: IpcRendererEvent, data: { phase: string; previousPhase: string }) =>
      callback(data)
    ipcRenderer.on('aux:phase-changed', handler)
    return () => ipcRenderer.removeListener('aux:phase-changed', handler)
  },

  // Champ select session updates
  onChampSelectUpdate: (callback: (session: any) => void) => {
    const handler = (_: IpcRendererEvent, session: any) => callback(session)
    ipcRenderer.on('aux:champ-select-update', handler)
    return () => ipcRenderer.removeListener('aux:champ-select-update', handler)
  },

  // Theme sync
  onThemeChanged: (callback: (data: { cssVariables: string; isDark: boolean }) => void) => {
    const handler = (_: IpcRendererEvent, data: { cssVariables: string; isDark: boolean }) =>
      callback(data)
    ipcRenderer.on('aux:theme-changed', handler)
    return () => ipcRenderer.removeListener('aux:theme-changed', handler)
  },

  // Get settings
  getAuxSettings: () => ipcRenderer.invoke('aux:get-settings'),
  setAuxSettings: (settings: any) => ipcRenderer.invoke('aux:set-settings', settings),

  // Get current phase (for initial state)
  getCurrentPhase: () => ipcRenderer.invoke('aux:get-current-phase'),

  // Auto Pick / Auto Ban / Auto Accept
  getAutoSettings: () => ipcRenderer.invoke('aux:get-auto-settings'),
  setAutoPick: (enabled: boolean) => ipcRenderer.invoke('aux:set-auto-pick', enabled),
  setAutoBan: (enabled: boolean) => ipcRenderer.invoke('aux:set-auto-ban', enabled),
  setAutoAccept: (enabled: boolean) => ipcRenderer.invoke('aux:set-auto-accept', enabled),
  setAutoPickChampions: (championIds: number[]) => ipcRenderer.invoke('aux:set-auto-pick-champions', championIds),
  setAutoBanChampions: (championIds: number[]) => ipcRenderer.invoke('aux:set-auto-ban-champions', championIds),
  getAllChampions: () => ipcRenderer.invoke('aux:get-all-champions'),
  getOwnedChampions: () => ipcRenderer.invoke('aux:get-owned-champions')
}

contextBridge.exposeInMainWorld('auxApi', auxApi)
