import fs from 'fs'
import path from 'path'
import { app } from 'electron'

class LoggerService {
  private logDir: string
  private logFile: string
  private stream: fs.WriteStream | null = null
  private originalConsoleLog: typeof console.log
  private originalConsoleError: typeof console.error
  private originalConsoleWarn: typeof console.warn

  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs')
    this.logFile = path.join(this.logDir, `bocchi-${this.getDateString()}.log`)
    this.originalConsoleLog = console.log
    this.originalConsoleError = console.error
    this.originalConsoleWarn = console.warn
  }

  initialize(): void {
    // Create logs directory
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }

    // Clean old logs (keep last 5 days)
    this.cleanOldLogs()

    // Open write stream
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' })

    // Write session header
    this.writeRaw(`\n${'='.repeat(80)}`)
    this.writeRaw(`[SESSION START] ${new Date().toISOString()} | Bocchi v${app.getVersion()} | ${process.platform} ${process.arch}`)
    this.writeRaw(`${'='.repeat(80)}\n`)

    // Override console methods to also write to file
    console.log = (...args: any[]) => {
      this.originalConsoleLog.apply(console, args)
      this.write('INFO', args)
    }

    console.error = (...args: any[]) => {
      this.originalConsoleError.apply(console, args)
      this.write('ERROR', args)
    }

    console.warn = (...args: any[]) => {
      this.originalConsoleWarn.apply(console, args)
      this.write('WARN', args)
    }

    // Catch uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.write('FATAL', [`Uncaught Exception: ${error.message}\n${error.stack}`])
    })

    process.on('unhandledRejection', (reason) => {
      this.write('FATAL', [`Unhandled Rejection: ${reason}`])
    })
  }

  private write(level: string, args: any[]): void {
    if (!this.stream) return
    const timestamp = new Date().toISOString()
    const message = args
      .map((arg) => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2)
          } catch {
            return String(arg)
          }
        }
        return String(arg)
      })
      .join(' ')
    this.stream.write(`[${timestamp}] [${level}] ${message}\n`)
  }

  private writeRaw(message: string): void {
    if (!this.stream) return
    this.stream.write(message + '\n')
  }

  private getDateString(): string {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }

  private cleanOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir)
      const now = Date.now()
      const fiveDaysMs = 5 * 24 * 60 * 60 * 1000

      for (const file of files) {
        if (!file.startsWith('bocchi-') || !file.endsWith('.log')) continue
        const filePath = path.join(this.logDir, file)
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > fiveDaysMs) {
          fs.unlinkSync(filePath)
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  getLogPath(): string {
    return this.logFile
  }

  getLogDir(): string {
    return this.logDir
  }

  close(): void {
    if (this.stream) {
      this.writeRaw(`\n[SESSION END] ${new Date().toISOString()}\n`)
      this.stream.end()
      this.stream = null
    }
  }
}

export const loggerService = new LoggerService()
