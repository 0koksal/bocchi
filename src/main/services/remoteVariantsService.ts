import axios from 'axios'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { app } from 'electron'
import { DEFAULT_REPO_ONLY_VARIANTS, type VariantsMap } from './championFetcher'

export interface RemoteVariant {
  id: number
  name: string
  parentSkinNum: number
  colors: string[]
  /** Full skin ID of the repo folder holding the {id}.png preview, if it differs from the parent skin */
  parentFolderId?: number
}

export interface ActiveVariants {
  variants: VariantsMap
  /** Fingerprint of the remote variants; champion data caches are invalidated when this changes */
  hash: string
  source: 'remote' | 'cache' | 'default'
}

// variants.md in the Bocchi repo root acts as remote config: editing it on GitHub
// updates every user's chroma wheels without releasing a new app version
const VARIANTS_RAW_URL = 'https://raw.githubusercontent.com/0koksal/bocchi/main/variants.md'
const FETCH_TIMEOUT_MS = 5000

class RemoteVariantsService {
  private active: ActiveVariants | null = null
  private pending: Promise<ActiveVariants> | null = null

  private getCacheFilePath(): string {
    return path.join(app.getPath('userData'), 'remote-variants-cache.json')
  }

  private computeHash(text: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16)
  }

  private parseVariantsMarkdown(markdown: string): VariantsMap | null {
    try {
      // Scope to the "## Variants" heading so JSON examples elsewhere in the
      // file's documentation can't shadow the real config
      const sectionMatch = markdown.match(/## Variants\b([\s\S]*?)(?=\n## |$)/)
      const scoped = sectionMatch ? sectionMatch[1] : markdown
      const match = scoped.match(/```json\s*([\s\S]*?)```/)
      if (!match) return null
      const list = JSON.parse(match[1])
      if (!Array.isArray(list)) return null

      const map: VariantsMap = {}
      for (const entry of list) {
        const championId = Number(entry?.championId)
        if (!Number.isInteger(championId) || !Array.isArray(entry?.variants)) continue

        const variants: RemoteVariant[] = []
        for (const v of entry.variants) {
          const id = Number(v?.id)
          const parentSkinNum = Number(v?.parentSkinNum)
          if (!Number.isInteger(id) || !Number.isInteger(parentSkinNum)) continue
          const variant: RemoteVariant = {
            id,
            name: typeof v?.name === 'string' ? v.name : `Variant ${id}`,
            parentSkinNum,
            colors: Array.isArray(v?.colors)
              ? v.colors.filter((c: unknown) => typeof c === 'string')
              : []
          }
          const parentFolderId = Number(v?.parentFolderId)
          if (Number.isInteger(parentFolderId)) {
            variant.parentFolderId = parentFolderId
          }
          variants.push(variant)
        }
        // An entry with "variants": [] is a valid override: it means
        // "no variants for this champion" and also suppresses auto-detection
        map[championId] = variants
      }
      return Object.keys(map).length > 0 ? map : null
    } catch {
      return null
    }
  }

  private async readDiskCache(): Promise<{ data: ActiveVariants; fetchedAt: number } | null> {
    try {
      const filePath = this.getCacheFilePath()
      if (!existsSync(filePath)) return null
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed?.data?.variants || typeof parsed?.fetchedAt !== 'number') return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeDiskCache(data: ActiveVariants): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.getCacheFilePath()), { recursive: true })
      await fs.writeFile(
        this.getCacheFilePath(),
        JSON.stringify({ data, fetchedAt: Date.now() }),
        'utf-8'
      )
    } catch (err) {
      console.warn('[RemoteVariants] Failed to write disk cache:', err)
    }
  }

  /**
   * Returns the currently active variants. The remote variants.md wins per
   * champion; falls back to the disk cache, then to the built-in defaults.
   */
  async getActiveVariants(): Promise<ActiveVariants> {
    if (this.active) return this.active
    if (this.pending) return this.pending
    this.pending = this.resolve().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async resolve(): Promise<ActiveVariants> {
    // Always check the live file on launch (once per session, thanks to the
    // in-memory cache) so pushed variants.md changes propagate immediately
    try {
      // Cache-buster query: raw.githubusercontent's CDN can otherwise serve a
      // stale copy for ~5 minutes after a push, delaying propagation
      const resp = await axios.get(VARIANTS_RAW_URL, {
        timeout: FETCH_TIMEOUT_MS,
        params: { t: Date.now() }
      })
      const parsed = this.parseVariantsMarkdown(resp.data)
      if (parsed) {
        const merged: VariantsMap = { ...DEFAULT_REPO_ONLY_VARIANTS }
        for (const [championId, variants] of Object.entries(parsed)) {
          merged[Number(championId)] = variants
        }
        const result: ActiveVariants = {
          variants: merged,
          hash: this.computeHash(JSON.stringify(parsed)),
          source: 'remote'
        }
        this.active = result
        await this.writeDiskCache(result)
        console.log(
          `[RemoteVariants] Loaded variants from GitHub (${Object.keys(parsed).length} champions, hash ${result.hash})`
        )
        return result
      }
      console.warn('[RemoteVariants] variants.md has no parsable json block, using defaults')
    } catch (err) {
      console.warn(
        '[RemoteVariants] Failed to fetch variants.md, using cached/default variants:',
        err instanceof Error ? err.message : err
      )
    }

    // Offline fallback: the last successfully fetched copy beats the built-in defaults
    const disk = await this.readDiskCache()
    if (disk) {
      this.active = disk.data
      return disk.data
    }
    this.active = { variants: DEFAULT_REPO_ONLY_VARIANTS, hash: '', source: 'default' }
    return this.active
  }

  /** Hash the active champion data was built with (empty string = built-in defaults) */
  getCurrentHash(): string {
    return this.active?.hash ?? ''
  }
}

// Export singleton instance
export const remoteVariantsService = new RemoteVariantsService()
