import axios from 'axios'
import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { settingsService } from './settingsService'
import {
  catalogRoot,
  isClassicCatalog,
  isSunshineCatalog,
  isSunshineRepository,
  selectedRepository,
  type SunshineCatalog,
  type ClassicCatalog
} from './sunshineCatalog'

interface Snapshot {
  catalog: SunshineCatalog
  classic: ClassicCatalog | null
}

export class SunshineCatalogService {
  private entries = new Map<
    string,
    { snapshot?: Snapshot; refreshAt: number; pending?: Promise<Snapshot> }
  >()

  getRepository() {
    return selectedRepository(settingsService.get('repositorySettings'))
  }

  isActive(): boolean {
    return isSunshineRepository(this.getRepository())
  }

  current(): Snapshot | undefined {
    return this.entries.get(catalogRoot(this.getRepository()))?.snapshot
  }

  async load(force = false): Promise<Snapshot> {
    const root = catalogRoot(this.getRepository())
    let entry = this.entries.get(root)
    if (!entry) {
      entry = { refreshAt: 0 }
      this.entries.set(root, entry)
    }
    if (entry.pending) return entry.pending
    if (!force && entry.snapshot && Date.now() < entry.refreshAt) return entry.snapshot
    const state = entry
    const cachePath = path.join(
      app.getPath('userData'),
      'champion-data',
      `sunshine-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`
    )
    state.pending = (async () => {
      if (!state.snapshot) {
        try {
          const saved = JSON.parse(await fs.readFile(cachePath, 'utf8'))
          if (isSunshineCatalog(saved.catalog)) {
            state.snapshot = {
              catalog: saved.catalog,
              classic: isClassicCatalog(saved.classic) ? saved.classic : null
            }
          }
        } catch {
          /* A missing cache is normal on the first launch. */
        }
      }
      try {
        const [regular, classic] = await Promise.all([
          axios.get(`${root}/index.json`, {
            timeout: 15000,
            headers: { 'Cache-Control': 'no-cache' }
          }),
          axios.get(`${root}/classic/index.json`, { timeout: 15000 }).catch(() => null)
        ])
        if (!isSunshineCatalog(regular.data)) throw new Error('Invalid Sunshine skin catalog')
        state.snapshot = {
          catalog: regular.data,
          classic: isClassicCatalog(classic?.data)
            ? classic.data
            : (state.snapshot?.classic ?? null)
        }
        state.refreshAt = Date.now() + 5 * 60_000
        try {
          await fs.mkdir(path.dirname(cachePath), { recursive: true })
          await fs.writeFile(cachePath, JSON.stringify(state.snapshot), 'utf8')
        } catch (error) {
          console.warn('[Sunshine] Could not save catalog cache:', error)
        }
      } catch (error) {
        state.refreshAt = Date.now() + 30_000
        if (!state.snapshot)
          throw new Error(
            'Sunshine catalog unavailable. Connect to the internet and refresh champion data.',
            { cause: error }
          )
        console.warn('[Sunshine] Using last valid catalog:', error)
      }
      return state.snapshot
    })()
    try {
      return await state.pending
    } finally {
      state.pending = undefined
    }
  }
}

export const sunshineCatalogService = new SunshineCatalogService()
