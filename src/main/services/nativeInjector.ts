/**
 * LTK Patcher Host Injector
 *
 * Uses ltk_patcher_host.exe (the LTK Patcher) for game injection.
 * This is the same patcher used by LTK Manager and cslol-go.
 *
 * Protocol: spawn the host process, send config commands via stdin,
 * read status updates from stdout. The host handles game detection
 * and injection automatically.
 *
 * Commands (sent via stdin):
 *   config loglevel 16
 *   config flags 0
 *   config prefix {overlayPath}/
 *   start scan
 *   stop
 *
 * Status output (read from stdout):
 *   status {id} injecting    - waiting for game
 *   status {id} attached     - game found, hooking
 *   status {id} waiting      - hooked, waiting for game exit
 *   status {id} exited       - game exited
 *   ok {msg}                 - success response
 *   error {msg}              - error response
 *   dll {msg}                - DLL telemetry
 */
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import { BrowserWindow } from 'electron'
import { settingsService } from './settingsService'

let hostProcess: ChildProcess | null = null
let isRunning = false

/**
 * Start the LTK patcher host for injection.
 *
 * @param overlayPath - Path to the overlay directory (the profile path from mkoverlay)
 * @param mainWindow - BrowserWindow for sending status updates
 * @param onStopped - Callback when the host process exits
 */
export function startInjection(
  overlayPath: string,
  mainWindow: BrowserWindow | null,
  onStopped?: () => void
): void {
  if (isRunning) {
    console.warn('[LTKPatcher] Already running')
    return
  }

  const toolsPath = settingsService.getModToolsPath()
  if (!toolsPath) {
    throw new Error('Mod tools path not set')
  }

  const hostExe = path.join(toolsPath, 'ltk_patcher_host.exe')
  const dllPath = path.join(toolsPath, 'ltk_patcher_dll.dll')

  // Check if LTK patcher exists
  try {
    require('fs').accessSync(hostExe)
    require('fs').accessSync(dllPath)
  } catch {
    throw new Error('LTK Patcher not found. Please re-download tools.')
  }

  // Normalize the overlay prefix path (must end with /)
  let prefix = path.resolve(overlayPath).replace(/\\/g, '/')
  if (!prefix.endsWith('/')) prefix += '/'

  console.log(`[LTKPatcher] Starting host: ${hostExe}`)
  console.log(`[LTKPatcher] Overlay prefix: ${prefix}`)

  isRunning = true

  hostProcess = spawn(hostExe, [], {
    cwd: path.dirname(hostExe),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  })

  const sendStatus = (msg: string) => {
    console.log(`[LTKPatcher] ${msg}`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('patcher-status', msg)
    }
  }

  // Send configuration commands
  const stdin = hostProcess.stdin!
  stdin.write('config loglevel 16\n')
  stdin.write('config flags 4\n')  // flag 4 = disable WAD scan (needed for skin mods)
  stdin.write(`config prefix ${prefix}\n`)
  stdin.write('start scan\n')

  sendStatus('Waiting for game to start...')

  // Read stdout for status updates
  hostProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter((l: string) => l.trim())
    for (const line of lines) {
      const trimmed = line.trim()
      parsePatcherLine(trimmed, sendStatus)
    }
  })

  hostProcess.stderr?.on('data', (data: Buffer) => {
    const output = data.toString().trim()
    if (output) {
      console.error(`[LTKPatcher:stderr] ${output}`)
    }
  })

  hostProcess.on('exit', (code) => {
    console.log(`[LTKPatcher] Host process exited with code ${code}`)
    isRunning = false
    hostProcess = null
    onStopped?.()
  })

  hostProcess.on('error', (err) => {
    console.error(`[LTKPatcher] Host process error:`, err)
    isRunning = false
    hostProcess = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('patcher-error', err.message)
    }
    onStopped?.()
  })
}

/**
 * Parse a line from the patcher host stdout.
 */
function parsePatcherLine(line: string, sendStatus: (msg: string) => void): void {
  const parts = line.split(' ')
  const keyword = parts[0]

  switch (keyword) {
    case 'ok':
      sendStatus(`[Host] ${parts.slice(1).join(' ')}`)
      break
    case 'error':
      sendStatus(`[Host Error] ${parts.slice(1).join(' ')}`)
      break
    case 'status': {
      const state = parts[2]
      switch (state) {
        case 'injecting':
          sendStatus('Waiting for game to start...')
          break
        case 'injected':
        case 'hooked':
        case 'attached':
          sendStatus('Game found!')
          break
        case 'waiting':
          sendStatus('Hooked! Waiting for game to exit...')
          break
        case 'exited':
          sendStatus('Game exited. Waiting for next game...')
          break
        case 'failed':
          sendStatus(`Patcher error: ${parts.slice(3).join(' ')}`)
          break
        default:
          sendStatus(`Status: ${state}`)
      }
      break
    }
    case 'dll':
      // DLL telemetry - log but don't show to user
      console.log(`[LTKPatcher:DLL] ${parts.slice(1).join(' ')}`)
      break
    default:
      if (line) sendStatus(line)
  }
}

/**
 * Stop the LTK patcher host.
 */
export function stopInjection(): void {
  if (!hostProcess || !isRunning) return

  console.log('[LTKPatcher] Stopping...')

  try {
    // Send stop command
    hostProcess.stdin?.write('stop\n')

    // Give it 1 second to exit gracefully
    setTimeout(() => {
      if (hostProcess && !hostProcess.killed) {
        console.log('[LTKPatcher] Force killing...')
        hostProcess.kill()
      }
    }, 1000)
  } catch {
    // Force kill
    try { hostProcess.kill() } catch {}
  }

  isRunning = false
}

/**
 * Check if the patcher is currently running.
 */
export function isInjectionRunning(): boolean {
  return isRunning && hostProcess !== null && !hostProcess.killed
}
