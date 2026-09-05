# Switching from cslol-dll.dll to LTK Patcher for League of Legends Skin Injection

## Overview

This document explains how Bocchi switched its injection system from the legacy `cslol-dll.dll` (loaded via `mod-tools.exe runoverlay`) to the **LTK Patcher** (`ltk_patcher_host.exe` + `ltk_patcher_dll.dll`). The LTK Patcher is the same injection engine used by [LTK Manager](https://github.com/LeagueToolkit/ltk-manager) and [cslol-go](https://github.com/LeagueToolkit/cslol-manager).

## Why Switch

| Problem with old system | How LTK Patcher fixes it |
|---|---|
| `mod-tools.exe runoverlay` is a monolithic process that handles both game scanning and DLL injection internally — no control over timing | LTK Patcher is a dedicated injection host with a structured stdin/stdout protocol and explicit state machine |
| Required users to provide/download `cslol-dll.dll` separately | LTK Patcher binaries are self-contained — just download two files |
| Some users experienced the game window being displaced to the bottom-right corner during injection | LTK Patcher hooks `CreateFileA` and the trust check only — never touches window positioning APIs |
| Slower game loading because `runoverlay` includes WAD integrity scanning | LTK Patcher supports `config flags 4` to disable WAD scanning, which is needed for skin mods anyway |

## Architecture

### Old System (cslol-dll.dll)
```
Bocchi → mod-tools.exe import (import skins)
       → mod-tools.exe mkoverlay (build overlay WADs)
       → mod-tools.exe runoverlay (scan for game + inject DLL)
           ↳ internally loads cslol-dll.dll into League process
           ↳ blocks until game exits
           ↳ no control over injection timing
```

### New System (LTK Patcher)
```
Bocchi → mod-tools.exe import (import skins) — unchanged
       → mod-tools.exe mkoverlay (build overlay WADs) — unchanged
       → ltk_patcher_host.exe (persistent process, controlled via stdin)
           ↳ receives config commands
           ↳ scans for League of Legends.exe
           ↳ injects ltk_patcher_dll.dll into the game process
           ↳ hooks CreateFileA to redirect file reads to overlay WADs
           ↳ hooks CRYPTO_free to bypass trust/integrity checks
           ↳ reports status via stdout
           ↳ waits for game exit, then scans for next game
```

## Binary Sources

Both binaries are downloaded from the LTK Manager repository on GitHub:

```
https://raw.githubusercontent.com/LeagueToolkit/ltk-manager/main/src-tauri/resources/ltk_patcher_host.exe
https://raw.githubusercontent.com/LeagueToolkit/ltk-manager/main/src-tauri/resources/ltk_patcher_dll.dll
```

These are the same binaries LTK Manager ships with. They are updated when the LTK team pushes to `main`.

Place both files in the same directory (e.g. alongside `mod-tools.exe`). The host automatically finds the DLL in its own directory.

## Protocol

The LTK Patcher Host communicates via **stdin** (commands) and **stdout/stderr** (status).

### Commands (send via stdin, each followed by `\n`)

| Command | Description |
|---|---|
| `config loglevel 16` | Set log verbosity (16 = info level) |
| `config flags 4` | **Critical:** Disable WAD integrity scanning. Without this flag, the patcher detects skin mods as "skinhack" and disables the overlay |
| `config prefix {path}/` | Set the overlay directory path. Must use forward slashes and end with `/` |
| `start scan` | Begin scanning for `League of Legends.exe`. The host will inject when it finds the game |
| `stop` | Gracefully stop the host process |

### Status Output (read from stdout)

Each line is a space-separated message:

| Pattern | Meaning |
|---|---|
| `ok {message}` | A config command was accepted |
| `error {message}` | A config command failed |
| `status {id} injecting` | Scanning for the game process |
| `status {id} attached` | Game found, DLL injected |
| `status {id} waiting` | Hooked and active, waiting for game to exit |
| `status {id} exited` | Game exited, will scan for next game |
| `status {id} failed {reason}` | Injection failed |
| `dll {message}` | Telemetry from the injected DLL (log only, don't show to user) |

### Stderr

The host writes its own log lines to stderr. These are useful for debugging but should not be shown to the user. Example:
```
0.000034000s  INFO ltk_patcher_host: host starting (normal mode)
0.002285500s  INFO ltk_patcher_host::worker: session started: scanning for game
1.841378900s  INFO ltk_patcher_host::worker: game found; hook installed tid=5796 pid=23252
```

### DLL Log Lines (from stderr, prefixed with DLL info)

After injection, the DLL logs through the host's stderr:
```
1.9318267 23252 5796 INFO ltk_patcher_dll::entry: init in process
1.9585330 23252 5796 INFO ltk_patcher_dll::hooks::trust::imp: patched CRYPTO_free
1.9585330 23252 5796 INFO ltk_patcher_dll::hooks::fsov::imp: patched CreateFileA
1.9585330 23252 5796 INFO ltk_patcher_dll::entry: init done
```

## Implementation Example (TypeScript/Electron)

### nativeInjector.ts

```typescript
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import { BrowserWindow } from 'electron'

let hostProcess: ChildProcess | null = null
let isRunning = false

/**
 * Start the LTK patcher host for injection.
 *
 * @param overlayPath - Path to the overlay directory (output of mkoverlay)
 * @param mainWindow - BrowserWindow for sending status updates to renderer
 * @param onStopped - Callback when the host process exits
 */
export function startInjection(
  overlayPath: string,
  mainWindow: BrowserWindow | null,
  onStopped?: () => void
): void {
  if (isRunning) return

  const toolsPath = '/path/to/your/tools/directory'
  const hostExe = path.join(toolsPath, 'ltk_patcher_host.exe')

  // Normalize overlay path: forward slashes, must end with /
  let prefix = path.resolve(overlayPath).replace(/\\/g, '/')
  if (!prefix.endsWith('/')) prefix += '/'

  isRunning = true

  hostProcess = spawn(hostExe, [], {
    cwd: path.dirname(hostExe),  // DLL must be in same directory
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  })

  // Send configuration commands
  const stdin = hostProcess.stdin!
  stdin.write('config loglevel 16\n')
  stdin.write('config flags 4\n')      // CRITICAL: disable WAD scan
  stdin.write(`config prefix ${prefix}\n`)
  stdin.write('start scan\n')

  // Read stdout for status updates
  hostProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(l => l.trim())
    for (const line of lines) {
      const parts = line.trim().split(' ')
      switch (parts[0]) {
        case 'ok':
          console.log(`[Patcher] Config accepted: ${parts.slice(1).join(' ')}`)
          break
        case 'error':
          console.error(`[Patcher] Error: ${parts.slice(1).join(' ')}`)
          break
        case 'status': {
          const state = parts[2]
          if (state === 'injecting') console.log('[Patcher] Waiting for game...')
          if (state === 'attached')  console.log('[Patcher] Game found, injected!')
          if (state === 'waiting')   console.log('[Patcher] Hooked, waiting for game exit')
          if (state === 'exited')    console.log('[Patcher] Game exited, waiting for next')
          if (state === 'failed')    console.error(`[Patcher] Failed: ${parts.slice(3).join(' ')}`)
          break
        }
        case 'dll':
          // DLL telemetry — log internally, don't show to user
          console.log(`[Patcher:DLL] ${parts.slice(1).join(' ')}`)
          break
      }
    }
  })

  // Stderr is the host's own log — useful for debugging
  hostProcess.stderr?.on('data', (data: Buffer) => {
    console.debug(`[Patcher:stderr] ${data.toString().trim()}`)
  })

  hostProcess.on('exit', (code) => {
    console.log(`[Patcher] Exited with code ${code}`)
    isRunning = false
    hostProcess = null
    onStopped?.()
  })
}

/**
 * Stop the LTK patcher host.
 */
export function stopInjection(): void {
  if (!hostProcess || !isRunning) return

  try {
    hostProcess.stdin?.write('stop\n')
    // Give it 1 second to exit gracefully, then force kill
    setTimeout(() => {
      if (hostProcess && !hostProcess.killed) {
        hostProcess.kill()
      }
    }, 1000)
  } catch {
    try { hostProcess.kill() } catch {}
  }

  isRunning = false
}

export function isInjectionRunning(): boolean {
  return isRunning && hostProcess !== null && !hostProcess.killed
}
```

### Usage in your apply/inject flow

```typescript
// 1. Import skins (unchanged — still uses mod-tools.exe)
await execTool('mod-tools.exe', ['import', skinPath, installedPath, `--game:${gamePath}`])

// 2. Build overlay (unchanged — still uses mod-tools.exe)
await execTool('mod-tools.exe', ['mkoverlay', installedPath, profilePath, `--game:${gamePath}`, `--mods:${modNames}`])

// 3. Start injection (NEW — replaces mod-tools.exe runoverlay)
startInjection(profilePath, mainWindow, () => {
  console.log('Injection stopped')
})

// To stop later:
stopInjection()
```

### Downloading the binaries

```typescript
const LTK_BASE_URL = 'https://raw.githubusercontent.com/LeagueToolkit/ltk-manager/main/src-tauri/resources'

// Download after cslol-tools are installed
const hostResponse = await axios.get(`${LTK_BASE_URL}/ltk_patcher_host.exe`, {
  responseType: 'arraybuffer'
})
await fs.promises.writeFile(path.join(toolsPath, 'ltk_patcher_host.exe'), Buffer.from(hostResponse.data))

const dllResponse = await axios.get(`${LTK_BASE_URL}/ltk_patcher_dll.dll`, {
  responseType: 'arraybuffer'
})
await fs.promises.writeFile(path.join(toolsPath, 'ltk_patcher_dll.dll'), Buffer.from(dllResponse.data))
```

## Critical Notes

### `config flags 4` is mandatory for skin mods

Without this flag, the LTK Patcher performs a WAD integrity scan after injection. It will detect that skin mod WADs don't match the originals and **disable the entire overlay**, logging:

```
ERROR ltk_patcher_dll::verify: WAD scan failed status with c0000229 for champion.wad.client
ERROR ltk_patcher_dll::verify: overlay verification failed, disabling overlay
```

Setting `config flags 4` disables this check. This is the same flag cslol-go uses.

### `cslol-dll.dll` is still needed

Don't delete `cslol-dll.dll` from the tools directory. It's still required by `mod-tools.exe import` — the import command links against it. Without it, import fails with exit code `0xC0000135` (missing DLL). Only the **injection** step is replaced by LTK Patcher.

### Overlay path format

The `config prefix` path must:
- Use **forward slashes** (`/` not `\`)
- **End with** `/`
- Be an **absolute path**

Example: `C:/Users/name/AppData/Roaming/bocchi/profiles/preset_temp_123/`

### The host is persistent

After the game exits, the host doesn't quit. It goes back to scanning for the next game. This means you can play multiple games without restarting the patcher. Send `stop` when the user wants to stop the patcher.

### Fallback

If LTK Patcher binaries are missing, fall back to `mod-tools.exe runoverlay` which uses the legacy `cslol-dll.dll` injection. This ensures the app still works if the download fails.

## File Summary

| File | Purpose | Source |
|---|---|---|
| `ltk_patcher_host.exe` | The injection host process — spawned by your app, controlled via stdin | LTK Manager repo |
| `ltk_patcher_dll.dll` | The DLL injected into League — hooks CreateFileA and CRYPTO_free | LTK Manager repo |
| `mod-tools.exe` | Still used for `import` and `mkoverlay` commands | cslol-manager releases |
| `cslol-dll.dll` | Still needed by mod-tools.exe import (NOT used for injection anymore) | cslol-manager releases |
