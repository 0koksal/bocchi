/**
 * Pre-Import Service
 *
 * Imports skin .fantome/.zip files into cslol_installed/ immediately after download,
 * so they're ready to use without delay when the user clicks Apply.
 *
 * The import step (mod-tools.exe import) is the slowest part of the pipeline (~3-5s per skin).
 * By doing it eagerly after download, the Apply flow only needs overlay + inject.
 */
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { app, BrowserWindow } from 'electron'
import { settingsService } from './settingsService'
import { repairModFile } from './modRepairService'

interface ImportJob {
  skinPath: string       // e.g., %APPDATA%/bocchi/downloaded-skins/Ahri/Spirit Blossom Ahri.fantome
  baseName: string       // e.g., "Spirit Blossom Ahri"
  championName: string   // e.g., "Ahri"
}

interface ImportStatus {
  total: number
  completed: number
  inProgress: string | null
  failures: string[]
}

class PreImportService {
  private installedPath: string
  private downloadedSkinsPath: string
  private queue: ImportJob[] = []
  private isProcessing = false
  private status: ImportStatus = { total: 0, completed: 0, inProgress: null, failures: [] }
  private importTimeout = 120000 // 2 min per skin

  constructor() {
    const userData = app.getPath('userData')
    this.installedPath = path.join(userData, 'cslol_installed')
    this.downloadedSkinsPath = path.join(userData, 'downloaded-skins')
  }

  /**
   * Scan downloaded-skins for files not yet imported and queue them.
   * Call this on app startup to resume where we left off.
   */
  async resumeImports(): Promise<void> {
    console.log('[PreImport] Scanning for un-imported skins...')

    try {
      const champions = await fs.readdir(this.downloadedSkinsPath).catch(() => [] as string[])
      let queued = 0

      for (const champion of champions) {
        const champDir = path.join(this.downloadedSkinsPath, champion)
        const stat = await fs.stat(champDir).catch(() => null)
        if (!stat || !stat.isDirectory()) continue

        const files = await fs.readdir(champDir).catch(() => [] as string[])
        for (const file of files) {
          if (!/\.(zip|fantome)$/i.test(file)) continue
          if (file.endsWith('.meta.json')) continue

          const ext = path.extname(file)
          const baseName = path.basename(file, ext).trim()

          // Check if already imported
          if (await this.isAlreadyImported(baseName)) continue

          // Queue it
          const skinPath = path.join(champDir, file)
          this.queue.push({ skinPath, baseName, championName: champion })
          queued++
        }
      }

      if (queued > 0) {
        this.status.total += queued
        console.log(`[PreImport] Queued ${queued} un-imported skins for background import`)
        this.broadcastStatus()
        if (!this.isProcessing) {
          this.processQueue()
        }
      } else {
        console.log('[PreImport] All downloaded skins are already imported')
      }
    } catch (err) {
      console.error('[PreImport] Failed to scan for un-imported skins:', err)
    }
  }

  /**
   * Send pre-import status to all renderer windows.
   */
  private broadcastStatus(): void {
    const status = this.getStatus()
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('preimport:status', status)
      }
    })
  }

  /**
   * Check if a skin has already been imported into cslol_installed.
   * Looks for any folder matching the baseName pattern with a valid META/info.json.
   */
  async isAlreadyImported(baseName: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.installedPath)
      for (const entry of entries) {
        // Match mod_X_baseName pattern
        const match = entry.match(/^mod_\d+_(.+)$/)
        if (match && match[1] === baseName) {
          // Verify it has META/info.json
          const metaPath = path.join(this.installedPath, entry, 'META', 'info.json')
          try {
            await fs.access(metaPath)
            return true
          } catch {
            // Corrupted import, will reimport
          }
        }
      }
    } catch {
      // cslol_installed doesn't exist yet
    }
    return false
  }

  /**
   * Remove any imported copies (mod_preimport_X / mod_N_X) of a skin from
   * cslol_installed so the next apply re-imports it from the repaired file.
   */
  private async removeImportedCopies(baseName: string): Promise<void> {
    try {
      const entries = await fs.readdir(this.installedPath).catch(() => [] as string[])
      for (const entry of entries) {
        const match = entry.match(/^mod_(?:\d+|preimport)_(.+)$/)
        if (match && match[1] === baseName) {
          await fs.rm(path.join(this.installedPath, entry), { recursive: true, force: true })
          console.log(`[PreImport] Removed stale imported copy: ${entry}`)
        }
      }
    } catch {
      // cslol_installed missing — nothing to clean
    }
  }

  /**
   * Queue a skin for pre-import after download.
   * Skips if already imported.
   */
  async queueImport(skinPath: string, championName: string): Promise<void> {
    const ext = path.extname(skinPath)
    const baseName = path.basename(skinPath, ext).trim()

    // Auto-repair outdated bin property types (16.17 Hashpocalypse) at selection
    // time, so mods added before this fix get corrected too. A repaired file makes
    // any previously imported copy stale, so it is dropped and re-imported.
    try {
      const repair = await repairModFile(skinPath)
      if (repair.repaired > 0) {
        console.log(
          `[PreImport] Auto-repaired ${repair.repaired} bin property type(s) in ${baseName}`
        )
        await this.removeImportedCopies(baseName)
      }
    } catch (repairError) {
      console.warn('[PreImport] Auto-repair failed for ' + baseName + ':', repairError)
    }

    // Skip if already imported
    if (await this.isAlreadyImported(baseName)) {
      console.log(`[PreImport] Already imported: ${baseName}`)
      return
    }

    // Skip if already in queue
    if (this.queue.some((j) => j.baseName === baseName)) {
      return
    }

    this.queue.push({ skinPath, baseName, championName })
    this.status.total++
    console.log(`[PreImport] Queued: ${baseName} (${this.queue.length} in queue)`)
    this.broadcastStatus()

    // Start processing if not already running
    if (!this.isProcessing) {
      this.processQueue()
    }
  }

  /**
   * Process the import queue with concurrency.
   * Runs up to CONCURRENCY imports in parallel.
   */
  private static readonly CONCURRENCY = 4

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    // Ensure installed directory exists
    await fs.mkdir(this.installedPath, { recursive: true })

    const runWorker = async (): Promise<void> => {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        this.status.inProgress = job.baseName

        try {
          await this.importSkin(job)
          this.status.completed++
          console.log(`[PreImport] Imported: ${job.baseName}`)
          this.broadcastStatus()
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          this.status.failures.push(`${job.baseName}: ${errMsg}`)
          console.error(`[PreImport] Failed to import ${job.baseName}:`, errMsg)
          this.broadcastStatus()
        }
      }
    }

    // Launch workers
    const workers: Promise<void>[] = []
    for (let i = 0; i < PreImportService.CONCURRENCY; i++) {
      workers.push(runWorker())
    }
    await Promise.all(workers)

    this.status.inProgress = null
    this.isProcessing = false
    this.broadcastStatus()
  }

  /**
   * Import a single skin using mod-tools.exe.
   * Uses a stable name like mod_preimport_BaseName so it doesn't conflict
   * with numbered mod_0_X, mod_1_X names used during Apply.
   */
  private async importSkin(job: ImportJob): Promise<void> {
    // Auto-repair outdated bin property types (16.17 Hashpocalypse) before importing,
    // so mods added before this fix also get corrected when they are selected
    try {
      const repair = await repairModFile(job.skinPath)
      if (repair.repaired > 0) {
        console.log(
          `[PreImport] Auto-repaired ${repair.repaired} bin property type(s) in ${job.baseName}`
        )
      }
    } catch (repairError) {
      console.warn('[PreImport] Auto-repair failed for ' + job.baseName + ':', repairError)
    }

    const modToolsPath = this.getModToolsExePath()
    if (!modToolsPath) {
      throw new Error('Mod tools not found')
    }

    const gamePath = settingsService.get('gamePath') as string
    if (!gamePath) {
      throw new Error('Game path not set')
    }

    // Use a stable folder name that won't conflict with applyPreset's mod_N_ naming
    const targetName = `mod_preimport_${job.baseName}`
    const targetPath = path.join(this.installedPath, targetName)

    // If target already exists (partial import), clean it up
    try {
      await fs.rm(targetPath, { recursive: true, force: true })
    } catch {}

    const args = [
      'import',
      path.normalize(job.skinPath),
      path.normalize(targetPath),
      `--game:${path.normalize(gamePath)}`,
      '--noTFT'
    ]

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(modToolsPath, args)
      let stderr = ''

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error(`Import timed out for ${job.baseName}`))
      }, this.importTimeout)

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter((l: string) => l.trim())
        lines.forEach((line: string) => {
          console.log(`[PreImport:${job.baseName}] ${line.trim()}`)
        })
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`mod-tools import exited with code ${code}: ${stderr.slice(0, 200)}`))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /**
   * Find the pre-imported folder for a skin baseName.
   * Returns the folder name if found, null otherwise.
   */
  async findPreImported(baseName: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(this.installedPath)
      // Check for pre-import pattern first
      const preImportName = `mod_preimport_${baseName}`
      if (entries.includes(preImportName)) {
        const metaPath = path.join(this.installedPath, preImportName, 'META', 'info.json')
        try {
          await fs.access(metaPath)
          return preImportName
        } catch {}
      }
      // Also check for any mod_N_ pattern (from previous applies)
      for (const entry of entries) {
        const match = entry.match(/^mod_\d+_(.+)$/)
        if (match && match[1] === baseName) {
          const metaPath = path.join(this.installedPath, entry, 'META', 'info.json')
          try {
            await fs.access(metaPath)
            return entry
          } catch {}
        }
      }
    } catch {}
    return null
  }

  /**
   * Get the current import queue status.
   */
  getStatus(): ImportStatus {
    return { ...this.status }
  }

  /**
   * Get the number of pending imports.
   */
  get pendingCount(): number {
    return this.queue.length
  }

  private getModToolsExePath(): string | null {
    const toolsPath = settingsService.getModToolsPath()
    if (!toolsPath) return null
    return path.join(toolsPath, 'mod-tools.exe')
  }
}

export const preImportService = new PreImportService()
