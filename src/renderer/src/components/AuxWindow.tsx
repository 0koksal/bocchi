import { useState, useEffect, useCallback } from 'react'

declare global {
  interface Window {
    auxApi: {
      closeAuxWindow: () => void
      minimizeAuxWindow: () => void
      pinAuxWindow: (pin: boolean) => void
      setAuxOpacity: (opacity: number) => void
      dodgeChampSelect: () => Promise<{ success: boolean; error?: string }>
      getChampSelectPlayers: () => Promise<{
        success: boolean
        players?: { summonerName: string; championId: number; teamId: number }[]
        error?: string
      }>
      getCurrentSummoner: () => Promise<{
        success: boolean
        summonerName?: string
        region?: string
        error?: string
      }>
      onPhaseChanged: (callback: (data: { phase: string; previousPhase: string }) => void) => () => void
      onChampSelectUpdate: (callback: (session: any) => void) => () => void
      onThemeChanged: (callback: (data: { cssVariables: string; isDark: boolean }) => void) => () => void
      getAuxSettings: () => Promise<any>
      setAuxSettings: (settings: any) => Promise<void>
      getCurrentPhase: () => Promise<string>
      getAutoSettings: () => Promise<{ autoPickEnabled: boolean; autoBanEnabled: boolean; autoAcceptEnabled: boolean; autoPickChampions: number[]; autoBanChampions: number[] }>
      setAutoPick: (enabled: boolean) => Promise<void>
      setAutoBan: (enabled: boolean) => Promise<void>
      setAutoAccept: (enabled: boolean) => Promise<void>
      setAutoPickChampions: (championIds: number[]) => Promise<void>
      setAutoBanChampions: (championIds: number[]) => Promise<void>
      getAllChampions: () => Promise<{ success: boolean; champions: { id: number; name: string }[] }>
      getOwnedChampions: () => Promise<{ success: boolean; champions: { id: number; name: string }[] }>
    }
  }
}

export function AuxWindow() {
  const [phase, setPhase] = useState<string>('None')
  const [isPinned, setIsPinned] = useState(true)
  const [dodging, setDodging] = useState(false)
  const [dodgeStatus, setDodgeStatus] = useState<string | null>(null)
  const [players, setPlayers] = useState<{ summonerName: string; championId: number; teamId: number }[]>([])
  const [region, setRegion] = useState<string>('euw')
  const [autoPickEnabled, setAutoPickEnabled] = useState(false)
  const [autoBanEnabled, setAutoBanEnabled] = useState(false)
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(false)
  const [autoPickChampions, setAutoPickChampions] = useState<number[]>([])
  const [autoBanChampions, setAutoBanChampions] = useState<number[]>([])
  const [allChampions, setAllChampions] = useState<{ id: number; name: string }[]>([])
  const [ownedChampions, setOwnedChampions] = useState<{ id: number; name: string }[]>([])

  const applyThemeToAux = (cssVariables: string, isDark: boolean) => {
    let styleEl = document.getElementById('aux-theme-variables')
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'aux-theme-variables'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = `:root {\n  ${cssVariables}\n}`
    document.documentElement.setAttribute('data-theme-mode', isDark ? 'dark' : 'light')
    if (isDark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  useEffect(() => {
    const unsubPhase = window.auxApi.onPhaseChanged((data) => {
      setPhase(data.phase)
      if (data.phase === 'ChampSelect') {
        setDodgeStatus(null)
        fetchPlayers()
      }
    })

    const unsubChampSelect = window.auxApi.onChampSelectUpdate(() => {
      fetchPlayers()
    })

    // Listen for theme changes from main window
    const unsubTheme = window.auxApi.onThemeChanged((data) => {
      applyThemeToAux(data.cssVariables, data.isDark)
    })

    fetchPlayers()
    fetchRegion()
    fetchAutoSettings()

    // Fetch initial phase (window might have opened mid-game)
    window.auxApi.getCurrentPhase().then((currentPhase) => {
      if (currentPhase && currentPhase !== 'None') {
        setPhase(currentPhase)
        if (currentPhase === 'ChampSelect') {
          fetchPlayers()
        }
      }
    })

    return () => {
      unsubPhase()
      unsubChampSelect()
      unsubTheme()
    }
  }, [])

  const fetchPlayers = useCallback(async () => {
    try {
      const result = await window.auxApi.getChampSelectPlayers()
      if (result.success && result.players) {
        setPlayers(result.players)
      }
    } catch {
      // Not in champ select
    }
  }, [])

  const fetchRegion = useCallback(async () => {
    try {
      const result = await window.auxApi.getCurrentSummoner()
      if (result.success && result.region) {
        setRegion(result.region)
      }
    } catch {}
  }, [])

  const fetchAutoSettings = useCallback(async () => {
    try {
      const settings = await window.auxApi.getAutoSettings()
      setAutoPickEnabled(settings.autoPickEnabled)
      setAutoBanEnabled(settings.autoBanEnabled)
      setAutoAcceptEnabled(settings.autoAcceptEnabled)
      setAutoPickChampions(settings.autoPickChampions || [])
      setAutoBanChampions(settings.autoBanChampions || [])
    } catch {}
    // Load champion list
    try {
      const result = await window.auxApi.getAllChampions()
      if (result.success && result.champions) {
        // Filter out classic champions (id >= 60000) and duplicates
        const seen = new Set<string>()
        const filtered = result.champions
          .filter((c: any) => c.id > 0 && c.id < 60000)
          .filter((c: any) => {
            const key = c.name.toLowerCase()
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
        setAllChampions(filtered)
      }
    } catch {}
    // Load owned champions for pick
    try {
      const result = await window.auxApi.getOwnedChampions()
      if (result.success && result.champions) {
        const seen = new Set<string>()
        const filtered = result.champions
          .filter((c: any) => c.id > 0 && c.id < 60000)
          .filter((c: any) => {
            const key = c.name.toLowerCase()
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
        setOwnedChampions(filtered)
      }
    } catch {}
  }, [])

  const handleDodge = async () => {
    setDodging(true)
    setDodgeStatus(null)
    try {
      const result = await window.auxApi.dodgeChampSelect()
      if (result.success) {
        setDodgeStatus('Dodged!')
      } else {
        setDodgeStatus(result.error || 'Failed')
      }
    } catch {
      setDodgeStatus('Error')
    }
    setDodging(false)
  }

  const handlePin = () => {
    const newPinned = !isPinned
    setIsPinned(newPinned)
    window.auxApi.pinAuxWindow(newPinned)
  }

  const handleAutoPickToggle = async () => {
    const newValue = !autoPickEnabled
    setAutoPickEnabled(newValue)
    await window.auxApi.setAutoPick(newValue)
  }

  const handleAutoBanToggle = async () => {
    const newValue = !autoBanEnabled
    setAutoBanEnabled(newValue)
    await window.auxApi.setAutoBan(newValue)
  }

  const handleAutoAcceptToggle = async () => {
    const newValue = !autoAcceptEnabled
    setAutoAcceptEnabled(newValue)
    await window.auxApi.setAutoAccept(newValue)
  }

  const handlePickChampionChange = async (index: number, championId: number) => {
    const newList = [...autoPickChampions]
    newList[index] = championId
    setAutoPickChampions(newList)
    await window.auxApi.setAutoPickChampions(newList.filter((id) => id > 0))
  }

  const handleBanChampionChange = async (index: number, championId: number) => {
    const newList = [...autoBanChampions]
    newList[index] = championId
    setAutoBanChampions(newList)
    await window.auxApi.setAutoBanChampions(newList.filter((id) => id > 0))
  }

  const addPickSlot = () => {
    if (autoPickChampions.length < 5) {
      setAutoPickChampions([...autoPickChampions, 0])
    }
  }

  const removePickSlot = (index: number) => {
    const newList = autoPickChampions.filter((_, i) => i !== index)
    setAutoPickChampions(newList)
    window.auxApi.setAutoPickChampions(newList.filter((id) => id > 0))
  }

  const addBanSlot = () => {
    if (autoBanChampions.length < 5) {
      setAutoBanChampions([...autoBanChampions, 0])
    }
  }

  const removeBanSlot = (index: number) => {
    const newList = autoBanChampions.filter((_, i) => i !== index)
    setAutoBanChampions(newList)
    window.auxApi.setAutoBanChampions(newList.filter((id) => id > 0))
  }

  const openOpgg = () => {
    const names = players.map((p) => p.summonerName).filter(Boolean)
    if (names.length === 0) return

    const regionMap: Record<string, string> = {
      'NA1': 'na', 'EUW1': 'euw', 'EUW': 'euw', 'EUNE': 'eune', 'EUN1': 'eune',
      'KR': 'kr', 'BR1': 'br', 'BR': 'br', 'JP1': 'jp', 'LA1': 'lan', 'LA2': 'las',
      'OC1': 'oce', 'TR1': 'tr', 'TR': 'tr', 'RU': 'ru', 'PH2': 'ph', 'SG2': 'sg',
      'TH2': 'th', 'TW2': 'tw', 'VN2': 'vn'
    }

    const opggRegion = regionMap[region.toUpperCase()] || region.toLowerCase()
    const url = `https://www.op.gg/multisearch/${opggRegion}?summoners=${encodeURIComponent(names.join(','))}`
    window.open(url, '_blank')
  }

  const openPorofessor = () => {
    const names = players.map((p) => p.summonerName).filter(Boolean)
    if (names.length === 0) return

    const regionMap: Record<string, string> = {
      'NA1': 'na', 'EUW1': 'euw', 'EUW': 'euw', 'EUNE': 'eune', 'EUN1': 'eune',
      'KR': 'kr', 'BR1': 'br', 'BR': 'br', 'JP1': 'jp', 'LA1': 'lan', 'LA2': 'las',
      'OC1': 'oce', 'TR1': 'tr', 'TR': 'tr', 'RU': 'ru'
    }

    const poroRegion = regionMap[region.toUpperCase()] || region.toLowerCase()
    // Porofessor multisearch uses comma-separated names
    const url = `https://www.porofessor.gg/pregame/${poroRegion}/${encodeURIComponent(names.join(','))}`
    window.open(url, '_blank')
  }

  const isInChampSelect = phase === 'ChampSelect'
  const isConnected = phase !== 'None'
  const hasPlayers = players.length > 0

  return (
    <div className="aux-container">
      {/* Title bar */}
      <div className="aux-titlebar">
        <span className="aux-titlebar-title">Bocchi Mini</span>
        <div className="aux-titlebar-controls">
          <button
            className={`aux-titlebar-btn ${isPinned ? 'pinned' : ''}`}
            onClick={handlePin}
            title={isPinned ? 'Unpin from top' : 'Pin on top'}
          >
            <svg className="pin-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
            </svg>
          </button>
          <button
            className="aux-titlebar-btn"
            onClick={() => window.auxApi.minimizeAuxWindow()}
            title="Minimize"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="aux-titlebar-btn close"
            onClick={() => window.auxApi.closeAuxWindow()}
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="aux-content">
        {/* Phase indicator */}
        <div className="aux-phase-badge">
          <span className={`aux-phase-dot ${isInChampSelect ? 'champselect' : isConnected ? 'active' : ''}`} />
          <span>{isInChampSelect ? 'Champion Select' : isConnected ? phase : 'Waiting for client...'}</span>
        </div>

        {/* Only show actions when connected to League Client */}
        {isConnected ? (
          <>
            {/* Dodge button */}
            <button
              className="aux-btn dodge"
              onClick={handleDodge}
              disabled={!isInChampSelect || dodging}
            >
              <svg className="aux-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              {dodging ? 'Dodging...' : 'Dodge'}
            </button>
            {dodgeStatus && (
              <div className="aux-status">{dodgeStatus}</div>
            )}

            {/* Lobby Reveal section */}
            <div className="aux-section-label">Lobby Reveal</div>
            <div className="aux-reveal-buttons">
              <button
                className="aux-btn opgg"
                onClick={openOpgg}
                disabled={!hasPlayers}
              >
                <svg className="aux-btn-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 001.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 00-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 005.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                </svg>
                OP.GG Multi
              </button>
              <button
                className="aux-btn poro"
                onClick={openPorofessor}
                disabled={!hasPlayers}
              >
                <svg className="aux-btn-icon" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                </svg>
                Porofessor
              </button>
            </div>

            {/* Auto Pick / Auto Ban section */}
            <div className="aux-section-label">Auto Pick / Ban</div>
            <div className="aux-toggle-group">
              <div className="aux-toggle-row">
                <span className="aux-toggle-label">Auto Accept</span>
                <button
                  className={`aux-toggle ${autoAcceptEnabled ? 'active' : ''}`}
                  onClick={handleAutoAcceptToggle}
                >
                  <span className="aux-toggle-knob" />
                </button>
              </div>
              <div className="aux-toggle-row">
                <span className="aux-toggle-label">Auto Pick</span>
                <button
                  className={`aux-toggle ${autoPickEnabled ? 'active' : ''}`}
                  onClick={handleAutoPickToggle}
                >
                  <span className="aux-toggle-knob" />
                </button>
              </div>
              {autoPickEnabled && (
                <div className="aux-champion-list">
                  {autoPickChampions.map((champId, index) => (
                    <div key={index} className="aux-champion-row">
                      <span className="aux-champion-index">{index + 1}.</span>
                      <select
                        className="aux-champion-select"
                        value={champId}
                        onChange={(e) => handlePickChampionChange(index, parseInt(e.target.value))}
                      >
                        <option value={0}>Select champion</option>
                        {ownedChampions.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button className="aux-champion-remove" onClick={() => removePickSlot(index)}>×</button>
                    </div>
                  ))}
                  {autoPickChampions.length < 5 && (
                    <button className="aux-add-champion" onClick={addPickSlot}>+ Add Champion</button>
                  )}
                </div>
              )}
              <div className="aux-toggle-row">
                <span className="aux-toggle-label">Auto Ban</span>
                <button
                  className={`aux-toggle ${autoBanEnabled ? 'active' : ''}`}
                  onClick={handleAutoBanToggle}
                >
                  <span className="aux-toggle-knob" />
                </button>
              </div>
              {autoBanEnabled && (
                <div className="aux-champion-list">
                  {autoBanChampions.map((champId, index) => (
                    <div key={index} className="aux-champion-row">
                      <span className="aux-champion-index">{index + 1}.</span>
                      <select
                        className="aux-champion-select"
                        value={champId}
                        onChange={(e) => handleBanChampionChange(index, parseInt(e.target.value))}
                      >
                        <option value={0}>Select champion</option>
                        {allChampions.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button className="aux-champion-remove" onClick={() => removeBanSlot(index)}>×</button>
                    </div>
                  ))}
                  {autoBanChampions.length < 5 && (
                    <button className="aux-add-champion" onClick={addBanSlot}>+ Add Champion</button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          /* Empty state when not connected */
          <div className="aux-empty-state">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
            <span>Waiting for League Client</span>
          </div>
        )}
      </div>
    </div>
  )
}
