import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import WebSocket from 'ws'
import { app } from 'electron'
import axios from 'axios'
import { exec } from 'child_process'
import { promisify } from 'util'
import { GamePathService } from './gamePathService'

interface LCUCredentials {
  protocol: string
  address: string
  port: number
  username: string
  password: string
  rcPort?: string
  rcPassword?: string
}

interface LCUConnectionOptions {
  pollInterval?: number
  maxRetries?: number
}

export class LCUConnector extends EventEmitter {
  private credentials: LCUCredentials | null = null
  private ws: WebSocket | null = null
  private connected: boolean = false
  private pollInterval: NodeJS.Timeout | null = null
  private subscriptions: Set<string> = new Set()
  private axiosInstance: any = null
  private rcAxiosInstance: any = null  // Riot Client API (separate port/auth)
  private cachedLockfilePath: string | null = null
  private lockfileCacheExpiry: number = 0
  private readonly lockfileCacheDuration = 30000 // 30 seconds

  constructor(options: LCUConnectionOptions = {}) {
    super()
    // Options currently not used but kept for future extensibility
    void options
  }

  async connect(): Promise<boolean> {
    try {
      // Try to find and read the lockfile
      const credentials = await this.findLockfile()
      if (!credentials) {
        // Don't emit error for auto-connect attempts
        if (!this.autoConnectInterval) {
          console.log('LCU: League client lockfile not found')
          this.emit('error', new Error('League client not found'))
        }
        return false
      }

      // If RC creds weren't found via the process (e.g. lockfile path was used),
      // fetch them separately so the lobby revealer can reach the Riot Client API
      if (!credentials.rcPort || !credentials.rcPassword) {
        console.log('LCU: Attempting to find Riot Client credentials...')
        const rcCreds = await this.findRiotClientCredentials()
        if (rcCreds) {
          credentials.rcPort = rcCreds.rcPort
          credentials.rcPassword = rcCreds.rcPassword
        } else {
          console.log('LCU: Riot Client credentials NOT found')
        }
      }

      this.credentials = credentials

      // Create axios instance with credentials
      this.axiosInstance = axios.create({
        baseURL: `https://${credentials.address}:${credentials.port}`,
        auth: {
          username: credentials.username,
          password: credentials.password
        },
        httpsAgent: new https.Agent({
          rejectUnauthorized: false
        }),
        timeout: 5000
      })

      // Create Riot Client axios instance if RC credentials are available
      if (credentials.rcPort && credentials.rcPassword) {
        this.rcAxiosInstance = axios.create({
          baseURL: `https://127.0.0.1:${credentials.rcPort}`,
          auth: {
            username: 'riot',
            password: credentials.rcPassword
          },
          httpsAgent: new https.Agent({
            rejectUnauthorized: false
          }),
          timeout: 5000
        })
        console.log(`LCU: Riot Client API available on port ${credentials.rcPort}`)
      } else {
        this.rcAxiosInstance = null
      }

      // Test connection with a simple API call
      const isConnected = await this.testConnection()
      if (!isConnected) {
        // Don't emit error for auto-connect attempts
        if (!this.autoConnectInterval) {
          this.emit('error', new Error('Failed to connect to League client'))
        }
        return false
      }

      // Establish WebSocket connection
      await this.connectWebSocket()

      this.connected = true
      this.emit('connected', credentials)

      // Start monitoring for client disconnection
      this.startPolling()

      return true
    } catch {
      // Only emit error if not auto-connecting
      if (!this.autoConnectInterval) {
        this.emit('error', new Error('Failed to connect to League client'))
      }
      return false
    }
  }

  disconnect(): void {
    this.stopPolling()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.connected = false
    this.credentials = null
    this.axiosInstance = null
    this.subscriptions.clear()

    this.emit('disconnected')
  }

  async subscribe(eventName: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }

    const message = JSON.stringify([5, eventName])

    this.ws.send(message)
    this.subscriptions.add(eventName)

    return true
  }

  async unsubscribe(eventName: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }

    const message = JSON.stringify([6, eventName])
    this.ws.send(message)
    this.subscriptions.delete(eventName)

    return true
  }

  async request(method: string, endpoint: string, data?: any): Promise<any> {
    if (!this.axiosInstance) {
      throw new Error('Not connected to LCU')
    }

    try {
      const response = await this.axiosInstance.request({
        method,
        url: endpoint,
        data
      })
      return response.data
    } catch (error: any) {
      if (error.response) {
        // Suppress 404 errors for champ-select endpoint as they're expected when not in champ select
        const isChampSelectEndpoint = endpoint.includes('/lol-champ-select/')
        const is404Error = error.response.status === 404

        if (!isChampSelectEndpoint || !is404Error) {
          console.error(`LCU: HTTP ${error.response.status} for ${endpoint}:`, error.response.data)
        }

        // Include httpStatus in the error for easier handling
        const err: any = new Error(`LCU request failed: ${error.response.status}`)
        err.httpStatus = error.response.status
        throw err
      } else if (error.request) {
        console.error('LCU: No response from server:', error.message)
        throw new Error('No response from League client')
      } else {
        console.error('LCU: Request setup error:', error.message)
        throw error
      }
    }
  }

  async getGameflowPhase(): Promise<string> {
    try {
      const phase = await this.request('GET', '/lol-gameflow/v1/gameflow-phase')
      return phase || 'None'
    } catch {
      return 'None'
    }
  }

  /**
   * Send a raw request to LCU without JSON serialization.
   * Used for endpoints that expect raw text bodies (like the dodge quitV2 endpoint).
   */
  async rawRequest(method: string, endpoint: string, body?: string): Promise<string> {
    if (!this.axiosInstance) {
      throw new Error('Not connected to LCU')
    }

    try {
      const response = await this.axiosInstance.request({
        method,
        url: endpoint,
        data: body,
        headers: body ? {} : undefined,
        transformRequest: [(data: any) => data] // prevent axios from JSON-stringifying
      })
      return response.data
    } catch (error: any) {
      if (error.response) {
        throw new Error(`LCU ${error.response.status}: ${error.response.data || error.response.statusText}`)
      }
      throw error
    }
  }

  /**
   * Request against the Riot Client's own REST API (separate port from LCU).
   * Used for /chat/v5/participants which returns all players including streamer mode.
   */
  async rcRequest(method: string, endpoint: string): Promise<any> {
    if (!this.rcAxiosInstance) {
      throw new Error('Riot Client API not available')
    }
    const response = await this.rcAxiosInstance.request({ method, url: endpoint })
    return response.data
  }

  hasRiotClientConnection(): boolean {
    return this.rcAxiosInstance !== null
  }

  async getGameflowSession(): Promise<any> {
    try {
      const session = await this.request('GET', '/lol-gameflow/v1/session')
      return session
    } catch {
      return null
    }
  }

  async getChampSelectSession(): Promise<any> {
    try {
      return await this.request('GET', '/lol-champ-select/v1/session')
    } catch {
      return null
    }
  }

  async getLobbySession(): Promise<any> {
    try {
      return await this.request('GET', '/lol-lobby/v2/lobby')
    } catch {
      return null
    }
  }

  async performChampSelectAction(actionId: number, championId: number): Promise<any> {
    try {
      return await this.request('PATCH', `/lol-champ-select/v1/session/actions/${actionId}`, {
        championId,
        completed: true
      })
    } catch (error) {
      console.error('[LCUConnector] Failed to perform champ select action:', error)
      throw error
    }
  }

  async getOwnedChampions(): Promise<any> {
    try {
      return await this.request('GET', '/lol-champions/v1/owned-champions-minimal')
    } catch (error) {
      console.error('[LCUConnector] Failed to get owned champions:', error)
      return []
    }
  }

  async getAllChampions(): Promise<any> {
    try {
      return await this.request('GET', '/lol-game-data/assets/v1/champion-summary.json')
    } catch (error) {
      console.error('[LCUConnector] Failed to get all champions:', error)
      return []
    }
  }

  async getMatchmakingSearchState(): Promise<any> {
    try {
      return await this.request('GET', '/lol-lobby/v2/lobby/matchmaking/search-state')
    } catch {
      return null
    }
  }

  async getLobbyData(): Promise<any> {
    try {
      return await this.request('GET', '/lol-lobby/v2/lobby')
    } catch {
      return null
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private async findLockfile(): Promise<LCUCredentials | null> {
    // Check cache first
    if (this.cachedLockfilePath && Date.now() < this.lockfileCacheExpiry) {
      try {
        const lockfileContent = await fs.promises.readFile(this.cachedLockfilePath, 'utf-8')
        const credentials = this.parseLockfileContent(lockfileContent)
        if (credentials) {
          return credentials
        }
      } catch {
        // Cache invalid, clear and continue
        this.cachedLockfilePath = null
      }
    }

    const possiblePaths: string[] = []

    // Use the centralized GamePathService
    try {
      const gamePathService = GamePathService.getInstance()
      const lockfilePath = await gamePathService.getLockfilePath()

      if (lockfilePath) {
        possiblePaths.push(lockfilePath)
        console.log('LCU: Using detected lockfile path:', lockfilePath)
      }
    } catch (error) {
      console.error('Failed to get lockfile path from GamePathService:', error)
    }

    // Add common fallback paths if detection failed
    if (possiblePaths.length === 0) {
      const fallbackPaths = [
        'C:\\Riot Games\\League of Legends\\lockfile',
        'D:\\Riot Games\\League of Legends\\lockfile',
        'E:\\Riot Games\\League of Legends\\lockfile',
        'F:\\Riot Games\\League of Legends\\lockfile',
        'G:\\Riot Games\\League of Legends\\lockfile',
        'H:\\Riot Games\\League of Legends\\lockfile',
        'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
        'C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile',
        'D:\\Program Files\\Riot Games\\League of Legends\\lockfile',
        'D:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile',
        '/Applications/League of Legends.app/Contents/LoL/lockfile',
        path.join(app.getPath('home'), 'Riot Games/League of Legends/lockfile')
      ]

      possiblePaths.push(...fallbackPaths)
    }

    for (const lockfilePath of possiblePaths) {
      try {
        const lockfileContent = await fs.promises.readFile(lockfilePath, 'utf-8')
        const credentials = this.parseLockfileContent(lockfileContent)

        if (credentials) {
          // Cache successful path
          this.cachedLockfilePath = lockfilePath
          this.lockfileCacheExpiry = Date.now() + this.lockfileCacheDuration
          return credentials
        }
      } catch {
        // Continue to next path
      }
    }

    // Try to find using process
    return this.findLockfileFromProcess()
  }

  private parseLockfileContent(content: string): LCUCredentials | null {
    const parts = content.split(':')
    if (parts.length < 5) return null

    const [, , port, password, protocol] = parts
    return {
      protocol: protocol?.trim() || 'https',
      address: '127.0.0.1',
      port: parseInt(port, 10),
      username: 'riot',
      password: password.trim()
    }
  }

  /**
   * Extract Riot Client API credentials from the running process command line.
   * These live on a separate port from the LCU and are needed for the
   * /chat/v5/participants endpoint used by the lobby revealer.
   */
  private async findRiotClientCredentials(): Promise<{ rcPort: string; rcPassword: string } | null> {
    if (process.platform !== 'win32') return null

    const execAsync = promisify(exec)

    // Get a process's command line. Try WMIC first (older Windows), then
    // fall back to PowerShell CIM (Windows 11 24H2+ removed WMIC).
    const getCommandLine = async (procName: string): Promise<string> => {
      // WMIC
      try {
        const { stdout } = await execAsync(
          `wmic process where "name='${procName}'" get CommandLine /format:list`
        )
        if (stdout && stdout.trim()) return stdout
      } catch {
        // WMIC missing, try PowerShell
      }
      // PowerShell CIM fallback
      try {
        const { stdout } = await execAsync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${procName}'\\" | Select-Object -ExpandProperty CommandLine"`
        )
        if (stdout && stdout.trim()) return stdout
      } catch {
        // PowerShell also failed
      }
      return ''
    }

    // The League client process carries the RC creds as --riotclient-* args
    const leagueCmd = await getCommandLine('LeagueClientUx.exe')
    if (leagueCmd) {
      const rcPort = leagueCmd.match(/--riotclient-app-port=(\d+)/)?.[1]
      const rcPassword = leagueCmd.match(/--riotclient-auth-token=([a-zA-Z0-9_-]+)/)?.[1]
      if (rcPort && rcPassword) {
        console.log(`LCU: Found Riot Client creds via LeagueClientUx.exe (port ${rcPort})`)
        return { rcPort, rcPassword }
      }
    }

    // The Riot Client's own process carries --app-port + --remoting-auth-token
    for (const procName of ['RiotClientServices.exe', 'RiotClientUx.exe']) {
      const cmd = await getCommandLine(procName)
      if (!cmd) continue
      const rcPort = cmd.match(/--app-port=(\d+)/)?.[1]
      const rcPassword = cmd.match(/--remoting-auth-token=([a-zA-Z0-9_-]+)/)?.[1]
      if (rcPort && rcPassword) {
        console.log(`LCU: Found Riot Client creds via ${procName} (port ${rcPort})`)
        return { rcPort, rcPassword }
      }
    }

    return null
  }

  private async findLockfileFromProcess(): Promise<LCUCredentials | null> {
    if (process.platform === 'win32') {
      try {
        const execAsync = promisify(exec)

        // Use WMIC to find the League client process and its command line
        const { stdout } = await execAsync(
          'wmic process where "name=\'LeagueClientUx.exe\'" get CommandLine /format:list'
        )

        if (stdout) {
          // Extract port and auth token from command line
          const portMatch = stdout.match(/--app-port=(\d+)/)
          const tokenMatch = stdout.match(/--remoting-auth-token=([a-zA-Z0-9_-]+)/)

          if (portMatch && tokenMatch) {
            return {
              protocol: 'https',
              address: '127.0.0.1',
              port: parseInt(portMatch[1], 10),
              username: 'riot',
              password: tokenMatch[1],
              rcPort: stdout.match(/--riotclient-app-port=(\d+)/)?.[1],
              rcPassword: stdout.match(/--riotclient-auth-token=([a-zA-Z0-9_-]+)/)?.[1]
            }
          }
        }
      } catch {
        // Failed to find process, continue
      }
    }

    return null
  }

  private async testConnection(): Promise<boolean> {
    try {
      await this.request('GET', '/lol-summoner/v1/current-summoner')
      return true
    } catch {
      return false
    }
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.credentials) {
      throw new Error('No credentials available')
    }

    const wsUrl = `wss://${this.credentials.address}:${this.credentials.port}/`
    const auth = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString(
      'base64'
    )

    this.ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Basic ${auth}`
      },
      rejectUnauthorized: false
    })

    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket not initialized'))

      this.ws.on('open', () => {
        resolve()
      })

      this.ws.on('message', (data) => {
        try {
          const messageStr = data.toString()
          // Skip empty messages
          if (!messageStr || messageStr.trim() === '') {
            return
          }

          const message = JSON.parse(messageStr)
          if (Array.isArray(message) && message.length >= 3) {
            const [opcode, eventName, eventData] = message
            if (opcode === 8 && eventName) {
              // Log champion select events
              if (eventName.includes('lol-champ-select')) {
                // Champion select event received
              }

              this.emit('event', eventName, eventData)

              // Emit specific events
              if (eventName === 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase') {
                this.emit('gameflow-phase', eventData?.data)
              } else if (eventName === 'OnJsonApiEvent_lol-champ-select_v1_session') {
                this.emit('champ-select-session', eventData?.data)
              } else if (eventName === 'OnJsonApiEvent_lol-lobby_v2_lobby') {
                this.emit('lobby-session', eventData?.data)
              }
            }
          }
        } catch (error) {
          // Only log if it's not an empty message error
          if (error instanceof Error && error.message !== 'Unexpected end of JSON input') {
            console.error('Failed to parse WebSocket message:', error)
          }
        }
      })

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error)
        this.emit('error', error)
      })

      this.ws.on('close', () => {
        this.handleDisconnection()
      })
    })
  }

  private startPolling(): void {
    let lastHeartbeat = Date.now()

    // Track WebSocket activity
    if (this.ws) {
      this.ws.on('message', () => {
        lastHeartbeat = Date.now()
      })

      this.ws.on('ping', () => {
        lastHeartbeat = Date.now()
      })
    }

    // Only test if truly stale (10 seconds without activity)
    this.pollInterval = setInterval(async () => {
      const timeSinceLastHeartbeat = Date.now() - lastHeartbeat

      if (timeSinceLastHeartbeat > 10000) {
        // Only make HTTP call if WebSocket seems dead
        const connected = await this.testConnection()
        if (!connected) {
          this.handleDisconnection()
        }
      }
    }, 5000) // Check every 5s, but only HTTP call if stale
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  private handleDisconnection(): void {
    const wasConnected = this.connected
    this.disconnect()

    if (wasConnected) {
      // Attempt to reconnect
      setTimeout(() => {
        this.connect()
      }, 5000)
    }
  }

  // Start polling for League client
  startAutoConnect(interval: number = 5000): void {
    this.stopAutoConnect()

    // Try immediate connection
    this.connect()

    // Set up polling
    this.autoConnectInterval = setInterval(() => {
      if (!this.connected) {
        this.connect()
      }
    }, interval)
  }

  stopAutoConnect(): void {
    if (this.autoConnectInterval) {
      clearInterval(this.autoConnectInterval)
      this.autoConnectInterval = null
    }
  }

  private autoConnectInterval: NodeJS.Timeout | null = null
}

// Singleton instance
export const lcuConnector = new LCUConnector()
