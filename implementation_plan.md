# Plan to Remove In-Game Electron Window Overlay

Remove the in-game Electron window overlay (`electron-overlay-window`) component from Bocchi. This eliminates the background Win32 window attachment hook (`OverlayController.attachByTitle`) that causes League of Legends to shrink and shift into the bottom-right corner on high DPI scaling (>100%) monitors, while keeping skin injection (`mod-tools`) fully functional.

## Proposed Changes

### Configuration & Dependencies

#### [MODIFY] [package.json](file:///c:/Users/koksal/Desktop/bocchiforcli/package.json)
- Remove `"electron-overlay-window"` dependency.

#### [MODIFY] [electron.vite.config.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/electron.vite.config.ts)
- Remove `overlay` input target from `preload` and `renderer` Rollup bundle options.

---

### Main Process & Preload

#### [DELETE] [overlayWindowManager.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/main/services/overlayWindowManager.ts)
- Delete the overlay window manager service.

#### [DELETE] [overlay.types.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/main/types/overlay.types.ts)
- Delete overlay type definitions.

#### [MODIFY] [index.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/main/index.ts)
- Remove `overlayWindowManager` imports, IPC handlers (`create-overlay`, `destroy-overlay`, `set-overlay-auto-selected-skin`), and overlay initialization/display logic.

#### [DELETE] [overlay.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/preload/overlay.ts)
#### [DELETE] [overlay.d.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/preload/overlay.d.ts)
- Remove overlay preload scripts.

#### [MODIFY] [index.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/preload/index.ts)
#### [MODIFY] [index.d.ts](file:///c:/Users/koksal/Desktop/bocchiforcli/src/preload/index.d.ts)
- Remove `createOverlay`, `destroyOverlay`, `setOverlayAutoSelectedSkin` from the IPC renderer API bridge.

---

### Renderer & UI

#### [DELETE] [overlay.html](file:///c:/Users/koksal/Desktop/bocchiforcli/src/renderer/overlay.html)
#### [DELETE] [overlay directory](file:///c:/Users/koksal/Desktop/bocchiforcli/src/renderer/src/overlay)
- Remove the overlay HTML page and React app components (`App.tsx`, `AutoSelectedSkin.tsx`, `useOverlayData.ts`, `main.tsx`).

#### [MODIFY] [App.tsx](file:///c:/Users/koksal/Desktop/bocchiforcli/src/renderer/src/App.tsx)
- Remove IPC calls sending skin data to overlay and overlay skin listener hooks.

#### [MODIFY] [main.css](file:///c:/Users/koksal/Desktop/bocchiforcli/src/renderer/src/assets/main.css)
- Clean up `.overlay-window` CSS utility rules.

---

## Verification Plan

### Automated Tests
- Run `npm run typecheck` to verify TypeScript builds cleanly with zero missing references or types.
- Run `npm run build` to verify the Vite/Electron build succeeds without the overlay bundle input.

### Manual Verification
- Launch dev mode (`npm run dev`) and test champion selection and skin injection to ensure skins apply without launching `electron-overlay-window`.
