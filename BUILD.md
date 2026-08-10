# Build From Source

If you don't trust pre-built executables, you can build Bocchi yourself from source.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- [pnpm](https://pnpm.io/installation) package manager

## Steps

```bash
# 1. Clone the repository
git clone https://github.com/0koksal/bocchi.git
cd bocchi

# 2. Install dependencies
pnpm install

# 3. Approve build scripts (select electron and electron-overlay-window)
pnpm approve-builds

# 4. Re-install to run approved build scripts
pnpm install

# 5. Build the application
npm run build:win
```

The built files will be in the `dist/` folder:
- **Installer:** `dist/Bocchi-1.24.17-setup.exe`
- **Portable:** `dist/win-unpacked/Bocchi.exe`

## Troubleshooting

### Electron failed to install
If you get "Electron failed to install correctly", the mirror in `.npmrc` might be unreachable. Remove or comment out the `electron_mirror` line in `.npmrc` and run:
```bash
pnpm install
```

### electron-overlay-window build error (Visual Studio not found)
This is optional — the app works without it. If you want overlay support, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

### Running in dev mode
```bash
npm run dev
```
This starts the app with hot-reload. Changes to renderer files (UI) update instantly without restarting.
