import { app } from 'electron'
import net from 'net'
import { v4 as uuidv4 } from 'uuid'

const CLIENT_ID = '1537808426544144504'

// Localized strings for Discord RPC
const RPC_STRINGS: Record<string, { browsing: string; inGame: string; skinsActive: (n: number) => string }> = {
  en_US: { browsing: 'Browsing Skins', inGame: 'In Game', skinsActive: (n) => `${n} skin${n > 1 ? 's' : ''} active` },
  tr_TR: { browsing: 'Skinlere Göz Atıyor', inGame: 'Oyunda', skinsActive: (n) => `${n} skin aktif` },
  de_DE: { browsing: 'Skins durchsuchen', inGame: 'Im Spiel', skinsActive: (n) => `${n} Skin${n > 1 ? 's' : ''} aktiv` },
  fr_FR: { browsing: 'Parcourir les skins', inGame: 'En jeu', skinsActive: (n) => `${n} skin${n > 1 ? 's' : ''} actif${n > 1 ? 's' : ''}` },
  es_ES: { browsing: 'Explorando skins', inGame: 'En partida', skinsActive: (n) => `${n} skin${n > 1 ? 's' : ''} activo${n > 1 ? 's' : ''}` },
  pt_BR: { browsing: 'Navegando skins', inGame: 'Em jogo', skinsActive: (n) => `${n} skin${n > 1 ? 's' : ''} ativo${n > 1 ? 's' : ''}` },
  ru_RU: { browsing: 'Просмотр скинов', inGame: 'В игре', skinsActive: (n) => `${n} скин${n > 1 ? 'ов' : ''} активно` },
  ko_KR: { browsing: '스킨 탐색 중', inGame: '게임 중', skinsActive: (n) => `${n}개 스킨 활성` },
  ja_JP: { browsing: 'スキン閲覧中', inGame: 'ゲーム中', skinsActive: (n) => `${n}個のスキンが有効` },
  zh_CN: { browsing: '浏览皮肤', inGame: '游戏中', skinsActive: (n) => `${n}个皮肤已激活` },
  pl_PL: { browsing: 'Przeglądanie skinów', inGame: 'W grze', skinsActive: (n) => `${n} skin${n > 1 ? 'ów' : ''} aktywnych` },
  it_IT: { browsing: 'Sfogliando le skin', inGame: 'In gioco', skinsActive: (n) => `${n} skin attiv${n > 1 ? 'e' : 'a'}` },
  vi_VN: { browsing: 'Đang xem skin', inGame: 'Trong trận', skinsActive: (n) => `${n} skin đang hoạt động` },
}

interface RpcPayload {
  cmd: string
  args?: any
  evt?: string | null
  nonce?: string
}

export class DiscordRpcService {
  private socket: net.Socket | null = null
  private connected = false
  private startTimestamp: number = Date.now()
  private currentDetails = 'Browsing Skins'
  private currentState = ''
  private activeSkinCount = 0
  private language = 'en_US'

  private getStrings() {
    // Try exact match first, then base language (e.g., es_AR → es_ES, zh_TW → zh_CN)
    if (RPC_STRINGS[this.language]) return RPC_STRINGS[this.language]
    const baseLanguage = Object.keys(RPC_STRINGS).find(
      (key) => key.substring(0, 2) === this.language.substring(0, 2)
    )
    return RPC_STRINGS[baseLanguage || 'en_US']
  }

  setLanguage(lang: string): void {
    this.language = lang
    // Re-update presence with new language if connected
    if (this.connected) {
      if (this.activeSkinCount > 0) {
        this.setInGame(this.activeSkinCount)
      } else {
        this.setBrowsing()
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return

    const pipePath = this.getIpcPath()
    if (!pipePath) return

    return new Promise((resolve) => {
      this.socket = net.createConnection(pipePath, () => {
        this.handshake()
        resolve()
      })

      this.socket.on('data', (data) => {
        try {
          // Skip 8-byte header
          const payload = JSON.parse(data.slice(8).toString())
          if (payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
            this.connected = true
            console.log('[DiscordRPC] Connected')
            this.updatePresence()
          }
        } catch {
          // Ignore parse errors
        }
      })

      this.socket.on('error', (err) => {
        console.warn('[DiscordRPC] Connection failed:', err.message)
        this.connected = false
        this.socket = null
        resolve()
      })

      this.socket.on('close', () => {
        this.connected = false
        this.socket = null
      })

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!this.connected) {
          this.socket?.destroy()
          this.socket = null
          resolve()
        }
      }, 5000)
    })
  }

  private getIpcPath(): string | null {
    if (process.platform === 'win32') {
      return '\\\\?\\pipe\\discord-ipc-0'
    }
    const tempDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'
    return `${tempDir}/discord-ipc-0`
  }

  private handshake(): void {
    const payload = JSON.stringify({ v: 1, client_id: CLIENT_ID })
    const header = Buffer.alloc(8)
    header.writeInt32LE(0, 0) // opcode 0 = handshake
    header.writeInt32LE(Buffer.byteLength(payload), 4)
    this.socket?.write(Buffer.concat([header, Buffer.from(payload)]))
  }

  private send(payload: RpcPayload): void {
    if (!this.socket || !this.connected) return
    const data = JSON.stringify(payload)
    const header = Buffer.alloc(8)
    header.writeInt32LE(1, 0) // opcode 1 = frame
    header.writeInt32LE(Buffer.byteLength(data), 4)
    this.socket.write(Buffer.concat([header, Buffer.from(data)]))
  }

  updatePresence(details?: string, state?: string, skinCount?: number): void {
    if (details !== undefined) this.currentDetails = details
    if (state !== undefined) this.currentState = state
    if (skinCount !== undefined) this.activeSkinCount = skinCount

    if (!this.connected) return

    this.send({
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: {
          details: this.currentDetails,
          state: this.currentState || (this.activeSkinCount > 0 ? `${this.activeSkinCount} skin${this.activeSkinCount > 1 ? 's' : ''} active` : undefined),
          timestamps: {
            start: this.startTimestamp
          },
          assets: {
            large_image: 'bocchi_logo',
            large_text: `Bocchi v${app.getVersion()}`,
          },
          buttons: [
            { label: 'Get Bocchi', url: 'https://github.com/0koksal/bocchi' },
            { label: 'Join Discord', url: 'https://discord.gg/FVxNNhzNcP' }
          ]
        }
      },
      nonce: uuidv4()
    })
  }

  setInGame(skinCount: number): void {
    const strings = this.getStrings()
    this.updatePresence(strings.inGame, strings.skinsActive(skinCount), skinCount)
  }

  setBrowsing(): void {
    const strings = this.getStrings()
    this.updatePresence(strings.browsing, '', 0)
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
      this.connected = false
    }
  }
}

export const discordRpcService = new DiscordRpcService()
