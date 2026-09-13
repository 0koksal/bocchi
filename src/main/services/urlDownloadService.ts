import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { zipHasImage, injectEntryIntoZip } from '../utils/modPreview'

interface DownloadResult {
  success: boolean
  filePath?: string
  error?: string
}

export class UrlDownloadService {
  private tempDir: string

  constructor() {
    this.tempDir = path.join(app.getPath('temp'), 'bocchi-url-imports')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true })
  }

  async downloadFromUrl(url: string): Promise<DownloadResult> {
    try {
      // Validate URL
      new URL(url) // This will throw if invalid URL

      // Check if it's a direct download URL
      if (this.isDirectDownloadUrl(url)) {
        return await this.downloadDirectUrl(url)
      }

      // Runeforge mod page link: resolve the latest release artifact automatically
      const runeforgePageMatch = url.match(
        /^https?:\/\/([a-z0-9-]+\.)*runeforge\.dev\/mods\/([a-f0-9-]+)(\/releases)?\/?$/i
      )
      if (runeforgePageMatch) {
        return await this.downloadRuneforgeLatest(runeforgePageMatch[2])
      }

      return {
        success: false,
        error:
          'Invalid URL. Please provide a direct download link to a mod file (.zip, .fantome, .wad)'
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to download from URL'
      }
    }
  }

  private async downloadDirectUrl(url: string): Promise<DownloadResult> {
    try {
      // First, make a HEAD request to get the actual filename from headers
      let filename = 'download.zip'
      try {
        const headResponse = await axios.head(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          maxRedirects: 5
        })

        // Try to get filename from Content-Disposition header
        const contentDisposition = headResponse.headers['content-disposition']
        if (contentDisposition) {
          const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
          if (filenameMatch && filenameMatch[1]) {
            filename = filenameMatch[1].replace(/['"]/g, '')
          }
        }

        // If no filename in headers, try the final redirect URL (e.g. Runeforge
        // /download links 302 to a signed R2 URL whose ?filename= param or path
        // ends with the real .fantome filename)
        if (filename === 'download.zip') {
          const finalUrl: string | undefined =
            (headResponse.request as any)?.res?.responseUrl ||
            (headResponse.request as any)?.responseUrl
          if (finalUrl) {
            try {
              const finalObj = new URL(finalUrl)
              // Prefer the ?filename= query param (clean name, no storage prefixes)
              const queryFilename = finalObj.searchParams.get('filename')
              if (queryFilename && /\.(zip|fantome|wad|client|modpkg)$/i.test(queryFilename)) {
                filename = queryFilename
              } else {
                const finalBase = decodeURIComponent(path.basename(finalObj.pathname))
                if (finalBase && /\.(zip|fantome|wad|client|modpkg)$/i.test(finalBase)) {
                  filename = finalBase
                }
              }
            } catch {
              // Ignore malformed redirect URL
            }
          }
        }

        // If no filename in headers, try to extract from URL
        if (filename === 'download.zip') {
          const urlPath = new URL(url).pathname
          const baseName = path.basename(urlPath)
          // Only use basename if it has a valid extension
          if (baseName && /\.(zip|fantome|wad|client|modpkg)$/i.test(baseName)) {
            filename = baseName
          }
        }
      } catch {
        // If HEAD request fails, continue with default filename
      }

      // Ensure the filename has a proper extension for mod files
      if (!filename.match(/\.(zip|fantome|wad|client|modpkg)$/i)) {
        // Default to .zip if no valid extension
        filename = filename.includes('.') ? filename : `${filename}.zip`
      }

      const timestamp = Date.now()
      const tempFileName = `${timestamp}-${filename}`
      const tempFilePath = path.join(this.tempDir, tempFileName)

      // Recreate the temp dir if the user deleted it mid-session
      await fs.mkdir(this.tempDir, { recursive: true })

      // Download the file
      const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        maxRedirects: 5,
        timeout: 60000 // 60 second timeout
      })

      // Save to temp file
      const writer = createWriteStream(tempFilePath)
      await pipeline(response.data, writer)

      console.log(`Downloaded file to: ${tempFilePath}`)
      console.log(`File name: ${tempFileName}`)

      // Rename the temp file to the site's display name FIRST so the preview
      // scrape below saves its sibling file next to the final filename
      let finalPath = tempFilePath
      const modIdMatch = url.match(/runeforge\.dev\/mods\/([a-f0-9-]+)/i)
      if (modIdMatch) {
        const prettyName = await this.scrapeRuneforgeModName(modIdMatch[1])
        if (prettyName) {
          finalPath = await this.renameWithPrettyName(tempFilePath, prettyName)
        }
      }

      // If the archive has no preview image, scrape one from the source page
      await this.scrapePreviewIfNeeded(finalPath, url)

      return {
        success: true,
        filePath: finalPath
      }

      return {
        success: true,
        filePath: tempFilePath
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          return { success: false, error: 'File not found (404)' }
        }
        if (error.code === 'ECONNABORTED') {
          return { success: false, error: 'Download timeout - file may be too large' }
        }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to download file'
      }
    }
  }

  /**
   * Resolves the latest release artifact from a Runeforge mod page and downloads it.
   * The /releases page SSR embeds asset download links
   * (/mods/{id}/releases/{releaseId}/artifacts/{artifactId}/download), newest first.
   */
  private async downloadRuneforgeLatest(modId: string): Promise<DownloadResult> {
    try {
      const releasesUrl = `https://runeforge.dev/mods/${modId}/releases`
      const resp = await axios.get(releasesUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html'
        },
        timeout: 15000
      })
      const link = String(resp.data).match(
        /\/mods\/[a-f0-9-]+\/releases\/[a-f0-9-]+\/artifacts\/[a-f0-9-]+\/download/i
      )
      if (!link) {
        return {
          success: false,
          error: 'Could not find a downloadable release on this Runeforge mod page'
        }
      }
      return await this.downloadDirectUrl(`https://runeforge.dev${link[0]}`)
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return { success: false, error: 'Runeforge mod not found (404)' }
      }
      return {
        success: false,
        error:
          error instanceof Error ? `Failed to resolve Runeforge release: ${error.message}` : 'Failed to resolve Runeforge release'
      }
    }
  }

  private isDirectDownloadUrl(url: string): boolean {
    const supportedExtensions = ['.zip', '.fantome', '.wad', '.wad.client']
    const lowercaseUrl = url.toLowerCase()
    if (supportedExtensions.some((ext) => lowercaseUrl.includes(ext))) {
      return true
    }
    // Runeforge release download links (302-redirect to the .fantome file)
    return /^https?:\/\/([a-z0-9-]+\.)*runeforge\.dev\/mods\/[a-f0-9-]+\/releases\/[a-f0-9-]+(\/artifacts\/[a-f0-9-]+)?\/download\/?$/i.test(
      url
    )
  }

  /** Sanitizes a display name for use as a file name */
  private sanitizeModFileName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim().replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 80)
  }

  /** Renames a temp download file to a display name, uniquifying if taken */
  private async renameWithPrettyName(filePath: string, prettyName: string): Promise<string> {
    try {
      const clean = this.sanitizeModFileName(prettyName)
      if (!clean) return filePath
      const dir = path.dirname(filePath)
      const ext = path.extname(filePath)
      let candidate = path.join(dir, clean + ext)
      let n = 2
      for (;;) {
        try {
          await fs.access(candidate)
          candidate = path.join(dir, `${clean} (${n})${ext}`)
          n++
        } catch {
          break
        }
      }
      await fs.rename(filePath, candidate)
      console.log(`[UrlDownload] Renamed download to: ${path.basename(candidate)}`)
      return candidate
    } catch (error) {
      console.warn('[UrlDownload] Pretty-name rename failed:', error)
      return filePath
    }
  }

  /** Scrapes the mod display name from Runeforge page HTML */
  private async scrapeRuneforgeModName(modId: string): Promise<string | null> {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html'
    }
    const pages = [
      `https://runeforge.dev/mods/${modId}`,
      `https://runeforge.dev/mods/${modId}/releases`
    ]
    for (const pageUrl of pages) {
      try {
        const resp = await axios.get(pageUrl, { headers, timeout: 15000 })
        const html = String(resp.data)
        const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
        if (og && og[1].trim()) return og[1].replace(/\s*\|\s*Runeforge\s*$/i, '').trim()
        const title = html.match(/<title>([^<]+)<\/title>/i)
        if (title) return title[1].replace(/\s*\|\s*Runeforge\s*$/i, '').trim()
        const heading = html.match(/font-display[^"]*"[^>]*>([^<]{2,100})</i)
        if (heading) return heading[1].trim()
      } catch {
        // Try next page
      }
    }
    return null
  }

  /**
   * If the downloaded archive contains no preview image and the source is a
   * known site (Runeforge), scrape the mod thumbnail from the page and save it
   * next to the file; the import picks it up as the preview image.
   */
  private async scrapePreviewIfNeeded(filePath: string, sourceUrl: string): Promise<void> {
    try {
      if (await zipHasImage(filePath)) return

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html'
      }

      if (/runeforge\.dev/i.test(sourceUrl)) {
        const modIdMatch = sourceUrl.match(/runeforge\.dev\/mods\/([a-f0-9-]+)/i)
        if (!modIdMatch) return
        const pages = [
          `https://runeforge.dev/mods/${modIdMatch[1]}`,
          `https://runeforge.dev/mods/${modIdMatch[1]}/releases`
        ]
        for (const pageUrl of pages) {
          try {
            const resp = await axios.get(pageUrl, { headers, timeout: 15000 })
            const match = String(resp.data).match(
              /https?:[^"'\s]*r2-images-prod\.runeforge\.dev\/[^"'\s]+\.(?:png|webp|jpe?g)/i
            )
            if (match) {
              const imgResp = await axios.get(match[0], {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: { 'User-Agent': headers['User-Agent'] }
              })
              // Embed the scraped preview INSIDE the archive so it is removed
              // together with the mod file
              await injectEntryIntoZip(filePath, 'IMAGE/preview.webp', Buffer.from(imgResp.data))
              console.log('[UrlDownload] Scraped preview image from Runeforge page')
              return
            }
          } catch {
            // Try next page
          }
        }
      }
    } catch (error) {
      console.warn('[UrlDownload] Preview scrape failed:', error instanceof Error ? error.message : error)
    }
  }

  async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir)
      const now = Date.now()
      const maxAge = 24 * 60 * 60 * 1000 // 24 hours

      for (const file of files) {
        const filePath = path.join(this.tempDir, file)
        const stats = await fs.stat(filePath)
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath)
        }
      }
    } catch (error) {
      console.error('Failed to cleanup temp files:', error)
    }
  }
}

export const urlDownloadService = new UrlDownloadService()
