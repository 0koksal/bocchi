import { BrowserWindow, app, session } from 'electron'
import axios from 'axios'
import { injectEntryIntoZip } from '../utils/modPreview'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Opens a website in an embedded window for imports that need human
 * verification (e.g. Cloudflare Turnstile on divineskins.gg).
 *
 * For DivineSkins the flow is automated: a small window shows only the
 * download page, the user just ticks the Cloudflare verification box, then:
 *  1. an injected fetch/XHR interceptor captures the signed download URL
 *     that the site fetches from api.divineskins.gg/.../download-url
 *  2. the (now enabled) Download button is clicked automatically
 *  3. the main process downloads the file, hands it to the import flow
 *     and closes the window
 * A will-download hook remains as a fallback for any other site.
 */
class WebImportService {
  private tempDir: string
  private win: BrowserWindow | null = null

  constructor() {
    this.tempDir = path.join(app.getPath('temp'), 'bocchi-url-imports')
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.tempDir, { recursive: true })
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  open(url: string, onFileDownloaded: (filePath: string) => void): void {
    // Focus the existing window if it's already open
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus()
      return
    }

    const isDivineSkins = /(^|\.)divineskins\.gg$/i.test(new URL(url).hostname)

    // DivineSkins: always start on the original mod page — NSFW mods need their
    // age gate passed there first, then the injected script navigates to /download
    void isDivineSkins

    // Persistent partition so verification cookies survive between imports
    const ses = session.fromPartition('persist:web-import')

    // DivineSkins only needs the Turnstile widget visible — keep the window compact
    this.win = new BrowserWindow({
      width: isDivineSkins ? 1260 : 1200,
      height: isDivineSkins ? 950 : 850,
      title: isDivineSkins ? 'Bocchi — DivineSkins Verification' : 'Bocchi — Web Import',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    let resolved = false

    const finishWithFile = async (filePath: string) => {
      if (resolved) return
      resolved = true
      const win = this.win

      // DivineSkins: grab the mod thumbnail from the live DOM before closing,
      // saved next to the file so the import uses it as the preview image
      if (isDivineSkins && win && !win.isDestroyed()) {
        try {
          const thumbSrc = await win.webContents
            .executeJavaScript(
              `(function() {
                const img = document.querySelector('img[src*="divine-cdn"], img[src*="thumbnails"]')
                return img ? img.src : null
              })()`,
              true
            )
            .catch(() => null)
          if (thumbSrc && /^https?:/.test(thumbSrc)) {
            const resp = await axios.get(thumbSrc, { responseType: 'arraybuffer', timeout: 30000 })
            // Embed the preview INSIDE the archive so it is removed with the mod
            await injectEntryIntoZip(filePath, 'IMAGE/preview.webp', Buffer.from(resp.data))
          }
        } catch (err) {
          console.warn('[WebImport] Failed to grab DivineSkins thumbnail:', err)
        }
      }

      // Rename the file to the mod's display name from the page title
      // ("Download bordeaux red Akali | Divine Skins" -> "bordeaux red Akali")
      try {
        const pageTitle = win && !win.isDestroyed()
          ? await win.webContents.executeJavaScript("document.title", true).catch(() => null)
          : null
        if (pageTitle && typeof pageTitle === "string") {
          let name = pageTitle.replace(/^\s*Download\s+/i, '').replace(/\s*\|\s*Divine.*$/i, '').trim()
          name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
          if (name && win && !win.isDestroyed()) {
            const ext = filePath.slice(filePath.lastIndexOf("."))
            const dir = filePath.slice(0, filePath.lastIndexOf(path.sep))
            let candidate = dir + path.sep + name + ext
            let n = 2
            for (;;) {
              try {
                await fs.promises.access(candidate)
                candidate = dir + path.sep + name + " (" + n + ")" + ext
                n++
              } catch {
                break
              }
            }
            await fs.promises.rename(filePath, candidate)
            console.log('[WebImport] Renamed download to:', name + ext)
            filePath = candidate
          }
        }
      } catch (err) {
        console.warn('[WebImport] Pretty-name rename failed:', err)
      }

      const finalPath = filePath
      onFileDownloaded(finalPath)
      if (win && !win.isDestroyed()) {
        win.close()
      }
    }

    // Fallback: intercept any download started inside the embedded window
    ses.on('will-download', (_event, item) => {
      try {
        const filename = item.getFilename() || `web-import-${Date.now()}.zip`
        const savePath = path.join(this.tempDir, `${Date.now()}-${filename}`)
        fs.mkdirSync(this.tempDir, { recursive: true })
        item.setSavePath(savePath)

        item.once('done', (_e, state) => {
          if (state === 'completed' && fs.existsSync(savePath)) {
            void finishWithFile(savePath)
          }
        })
      } catch (err) {
        console.error('[WebImport] Failed to handle download:', err)
      }
    })

    this.win.on('closed', () => {
      this.win = null
    })

    if (isDivineSkins) {
      // Suppress the normal window download when we auto-click the button —
      // the main process downloads the captured signed URL itself instead
      let capturedUrl: string | null = null
      const pollCapture = async () => {
        const deadline = Date.now() + 5 * 60 * 1000
        while (Date.now() < deadline && this.win && !this.win.isDestroyed() && !resolved) {
          try {
            if (this.win && !this.win.isDestroyed() && this.win.webContents && !this.win.webContents.isDestroyed()) {
              const found = await this.win.webContents
                .executeJavaScript('window.__bocchiDownloadUrl || null', true)
                .catch(() => null)
              if (found && typeof found === 'string') {
                capturedUrl = found
                break
              }
            }
          } catch {
            // Window closing
          }
          await new Promise((r) => setTimeout(r, 1000))
        }

        if (capturedUrl && !resolved) {
          try {
            const resp = await axios.get(capturedUrl!, {
              responseType: 'stream',
              timeout: 60000,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            })
            const disposition: string = resp.headers['content-disposition'] || ''
            const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
            let filename = match?.[1]?.replace(/['"]/g, '') || `divineskins-${Date.now()}.fantome`
            if (!/\.(zip|fantome|wad|client)$/i.test(filename)) filename += '.fantome'
            const savePath = path.join(this.tempDir, `${Date.now()}-${filename}`)
            const writer = fs.createWriteStream(savePath)
            await new Promise<void>((resolve, reject) => {
              resp.data.pipe(writer)
              resp.data.on('error', reject)
              writer.on('finish', resolve)
              writer.on('error', reject)
            })
            await finishWithFile(savePath)
          } catch (err) {
            console.error('[WebImport] Failed to download captured DivineSkins file:', err)
          }
        }
      }
      void pollCapture()

      this.win.webContents.on('did-finish-load', () => {
        // Inject an interceptor for the download-url API response, plus an
        // auto-clicker for the Download button once verification enables it
        this.win?.webContents
          .executeJavaScript(
            `(function() {
              window.__bocchiDownloadUrl = null;
              const capture = function(text) {
                try {
                  const j = JSON.parse(text);
                  if (j && typeof j.url === 'string') { window.__bocchiDownloadUrl = j.url; return; }
                  if (j && typeof j.downloadUrl === 'string') { window.__bocchiDownloadUrl = j.downloadUrl; return; }
                  const s = JSON.stringify(j);
                  const m = s.match(/https?:[^"]+\\.(?:fantome|zip|modpkg)[^"]*/i);
                  if (m) window.__bocchiDownloadUrl = m[0];
                } catch (e) {}
              };
              if (window.fetch && !window.__bocchiPatched) {
                window.__bocchiPatched = true;
                const origFetch = window.fetch;
                window.fetch = async function() {
                  const res = await origFetch.apply(this, arguments);
                  try {
                    const u = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
                    if (u.includes('/download-url')) { res.clone().text().then(capture); }
                  } catch (e) {}
                  return res;
                };
                const origOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(m, u) {
                  this.__bocchiUrl = u;
                  return origOpen.apply(this, arguments);
                };
                const origSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.send = function() {
                  this.addEventListener('load', function() {
                    try {
                      if (this.__bocchiUrl && String(this.__bocchiUrl).includes('/download-url')) { capture(this.responseText); }
                    } catch (e) {}
                  });
                  return origSend.apply(this, arguments);
                };
              }
              if (!window.__bocchiAutoClick) {
                window.__bocchiAutoClick = setInterval(function() {
                  if (window.__bocchiDownloadUrl) { clearInterval(window.__bocchiAutoClick); return; }
                  const clickables = Array.from(document.querySelectorAll('button, a'));
                  const onDownloadPage = location.pathname.indexOf('/download/') === 0;
                  if (!onDownloadPage) {
                    // Mod page: pass the NSFW age gate if present, then go to /download
                    for (const b of clickables) {
                      const t = (b.textContent || '').trim().toLowerCase();
                      if (/^(verify age|verify)$/.test(t) && b.offsetParent !== null) { b.click(); return; }
                    }
                    if (!window.__bocchiNavigating) {
                      window.__bocchiNavigating = true;
                      const parts = location.pathname.split('/').filter(Boolean);
                      if (parts.length >= 2) { location.href = '/download/' + parts.join('/'); }
                    }
                    return;
                  }
                  // Download page: click the Download button only when there is
                  // exactly one choice — with multiple versions, let the user pick
                  const downloadButtons = clickables.filter(function(b) {
                    const t = (b.textContent || '').trim().toLowerCase();
                    return t === 'download' && !b.disabled && b.offsetParent !== null && b.tagName === 'BUTTON';
                  });
                  if (downloadButtons.length === 1) { downloadButtons[0].click(); }
                }, 1500);
              }
            })()`,
            true
          )
          .catch(() => {})

        // Strip the page down to the essentials: ad overlay + clutter selectors
        // taken from the user's tested uBlock Origin rules
        this.win?.webContents
          .insertCSS(
            `
            .backdrop-blur-sm.font-manrope.p-4.bg-black\\/70.overflow-y-auto.justify-center.items-center.flex.z-\\[70\\].inset-0.fixed,
            .transition-colors.mb-8.md\\:p-5.p-4.rounded-xl.hover\\:border-\\[\\#25222F\\].border-\\[\\#191722\\].border.bg-\\[\\#121119\\],
            .justify-center.flex.min-h-\\[96px\\].w-full.z-10.relative,
            .text-center.md\\:mb-20.mb-16.md\\:gap-8.gap-7.items-center.flex-col.flex,
            div.justify-center.flex.mb-8:nth-of-type(7),
            .font-manrope.z-\\[65\\].left-4.fixed.group,
            .z-50.overflow-hidden.relative.rounded-\\[5px\\].bg-\\[\\#111016\\].w-full,
            .md\\:mb-10.mb-8,
            .justify-center.flex.mt-8,
            .mb-6.gap-3.items-center.flex,
            .gap-6.flex-col.flex.pb-12.pt-8.lg\\:px-8.sm\\:px-6.px-4.max-w-\\[1309px\\].mx-auto.z-10.relative,
            .lg\\:px-8.sm\\:px-6.pb-20.px-4.max-w-\\[1309px\\].w-full.mx-auto,
            iframe[src*="doubleclick"], iframe[src*="adservice"], iframe[src*="googlesyndication"],
            ins.adsbygoogle, [id*="div-gpt-ad"], [class*="ad-container"], [class*="advertisement"] {
              display: none !important;
            }
            body {
              background: #0b0612 !important;
            }
            `,
            { cssOrigin: 'user' }
          )
          .catch(() => {})
      })

      // Start on the original mod page — the injected script handles the NSFW
      // age gate there, then navigates to the /download page itself
      this.win.loadURL(url)
      return
    }

    this.win.loadURL(url)
  }
}

export const webImportService = new WebImportService()
