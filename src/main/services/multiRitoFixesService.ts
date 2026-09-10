import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { ToolsDownloader } from './toolsDownloader'

export interface FixResult {
  success: boolean
  error?: string
  output?: string
}

export class MultiRitoFixesService {
  private toolsDownloader: ToolsDownloader

  constructor() {
    this.toolsDownloader = new ToolsDownloader()
  }

  async ensureToolExists(): Promise<void> {
    const exists = await this.toolsDownloader.checkMultiRitoFixesExist()
    if (!exists) {
      throw new Error('Hematite tool not found. Please download it first.')
    }
  }

  async fixMod(modPath: string, onProgress?: (message: string) => void): Promise<FixResult> {
    try {
      await this.ensureToolExists()

      try {
        await fs.access(modPath)
      } catch {
        return { success: false, error: 'Mod file not found' }
      }

      const toolPath = this.toolsDownloader.getMultiRitoFixesPath()

      return new Promise<FixResult>((resolve) => {
        const process = spawn(toolPath, [modPath], {
          windowsHide: true
        })

        // Hematite waits for "Press Enter to exit..." — auto-confirm immediately
        process.stdin?.write('\n')
        process.stdin?.end()

        let stdout = ''
        let stderr = ''

        process.stdout.on('data', (data) => {
          const output = data.toString()
          stdout += output
          if (onProgress) {
            const lines = output.split('\n').filter((line) => line.trim())
            for (const line of lines) {
              if (
                line.includes('Processing') ||
                line.includes('Fixing') ||
                line.includes('Converting') ||
                line.includes('Migrating') ||
                line.includes('migrat')
              ) {
                onProgress(line.trim())
              }
            }
          }
        })

        process.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        process.on('error', (error) => {
          safeResolve({
            success: false,
            error: `Failed to run Hematite: ${error.message}`
          })
        })

        let resolved = false
        const safeResolve = (result: FixResult) => {
          if (!resolved) {
            resolved = true
            resolve(result)
          }
        }

        process.on('close', async (code) => {
          if (code === 0) {
            // Hematite puts the fixed file in a "Hematite-Fixed" folder next to the original.
            // Move it back over the original so Bocchi doesn't see a duplicate.
            try {
              const dir = path.dirname(modPath)
              const fileName = path.basename(modPath)
              const fixedPath = path.join(dir, 'Hematite-Fixed', fileName)

              let fixedExists = false
              try {
                await fs.access(fixedPath)
                fixedExists = true
              } catch {
                // Hematite found nothing to fix — original is already correct
              }

              if (fixedExists) {
                await fs.copyFile(fixedPath, modPath)
                await fs.rm(path.join(dir, 'Hematite-Fixed'), { recursive: true, force: true })
                console.log('[Hematite] Replaced original with fixed file, cleaned up Hematite-Fixed folder')
              }
            } catch (cleanupError) {
              console.warn('[Hematite] Could not replace original with fixed file:', cleanupError)
            }

            safeResolve({ success: true, output: stdout })
          } else {
            let errorMessage = 'Fix process failed'
            if (stderr) {
              errorMessage = stderr.trim()
            } else if (stdout.includes('error') || stdout.includes('Error') || stdout.includes('failed')) {
              const lines = stdout.split('\n')
              const errorLine = lines.find(
                (line) => line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')
              )
              if (errorLine) errorMessage = errorLine.trim()
            }
            safeResolve({ success: false, error: errorMessage, output: stdout })
          }
        })

        setTimeout(() => {
          if (!process.killed) {
            process.kill()
            safeResolve({ success: false, error: 'Fix process timed out after 60 seconds' })
          }
        }, 60000)
      })
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  async fixModWithDownload(
    modPath: string,
    onProgress?: (message: string) => void,
    onDownloadProgress?: (progress: number) => void
  ): Promise<FixResult> {
    try {
      const exists = await this.toolsDownloader.checkMultiRitoFixesExist()

      if (!exists) {
        onProgress?.('Downloading Hematite tool...')
        await this.toolsDownloader.downloadMultiRitoFixes(onDownloadProgress)
      } else {
        const needsUpdate = await this.toolsDownloader.checkMultiRitoFixesUpdate()
        if (needsUpdate) {
          onProgress?.('Updating Hematite tool...')
          await this.toolsDownloader.downloadMultiRitoFixes(onDownloadProgress)
        }
      }

      onProgress?.('Fixing mod issues...')
      return await this.fixMod(modPath, onProgress)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  isValidModFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath).toLowerCase()

    if (fileName.endsWith('.wad.client')) return true
    if (ext === '.wad') return true
    if (ext === '.zip') return true
    if (ext === '.fantome') return true

    return false
  }
}

export const multiRitoFixesService = new MultiRitoFixesService()
