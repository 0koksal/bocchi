import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import {
  fetchLatestVersion,
  fetchChampionData as fetchFromApis,
  applyRemoteVariants,
  CHAMPION_DATA_REVISION,
  type Champion,
  type Skin
} from './championFetcher'
import { remoteVariantsService } from './remoteVariantsService'
import { sunshineCatalogService } from './sunshineCatalogService'
import { projectSunshineChampion } from './sunshineCatalog'

export type { Champion, Skin }

interface CachedFile {
  version: string
  champions: Champion[]
  dataRevision?: number
  /** Fingerprint of the remote variants active when this data was built */
  variantsHash?: string
}

export class ChampionDataService {
  private cachedData: Map<string, { version: string; champions: Champion[] }> = new Map()
  private championIdCache: Map<string, Map<number, Champion>> = new Map()
  private championNameCache: Map<string, Map<string, Champion>> = new Map()
  private pendingLoads: Map<string, Promise<{ version: string; champions: Champion[] } | null>> =
    new Map()

  private projectedData = new Map<
    string,
    { raw: unknown; snapshot: unknown; data: { version: string; champions: Champion[] } }
  >()

  private getCurrentData(language: string) {
    const raw =
      this.cachedData.get(language) ??
      this.cachedData.get('en_US') ??
      this.cachedData.values().next().value
    if (!raw) return undefined
    const snapshot = sunshineCatalogService.isActive()
      ? sunshineCatalogService.current()
      : undefined
    if (sunshineCatalogService.isActive() && !snapshot) return undefined
    const previous = this.projectedData.get(language)
    if (previous?.raw === raw && previous.snapshot === snapshot) return previous.data
    const data = snapshot
      ? {
          ...raw,
          champions: raw.champions.map((c) =>
            projectSunshineChampion(c, snapshot.catalog, snapshot.classic)
          )
        }
      : raw
    this.projectedData.set(language, { raw, snapshot, data })
    this.clearIdCache()
    return data
  }

  public async loadChampionData(
    language = 'en_US'
  ): Promise<{ version: string; champions: Champion[] } | null> {
    if (sunshineCatalogService.isActive()) await sunshineCatalogService.load()
    await this.loadRawChampionData(language)
    return this.getCurrentData(language) ?? null
  }

  private getCacheDir(): string {
    return path.join(app.getPath('userData'), 'champion-data')
  }

  private getCacheFilePath(language: string): string {
    return path.join(this.getCacheDir(), `champion-data-${language}.json`)
  }

  private async ensureCacheDir(): Promise<void> {
    const dir = this.getCacheDir()
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true })
    }
  }

  private async loadFromDisk(language: string): Promise<CachedFile | null> {
    try {
      const filePath = this.getCacheFilePath(language)
      if (!existsSync(filePath)) return null
      const raw = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(raw) as CachedFile
    } catch {
      return null
    }
  }

  private async saveToDisk(language: string, data: CachedFile): Promise<void> {
    try {
      await this.ensureCacheDir()
      const filePath = this.getCacheFilePath(language)
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8')
    } catch (err) {
      console.error('Failed to save champion data to disk:', err)
    }
  }

  public async fetchAndSaveChampionData(
    language: string = 'en_US'
  ): Promise<{ success: boolean; message: string; championCount?: number }> {
    try {
      if (sunshineCatalogService.isActive()) await sunshineCatalogService.load(true)
      // Clear caches
      this.cachedData.delete(language)
      this.championIdCache.delete(language)
      this.championNameCache.delete(language)

      console.log(`[ChampionData] Fetching data for ${language} from APIs...`)

      // Load remote variants first so the fetched data includes them
      const active = sunshineCatalogService.isActive()
        ? { variants: {}, hash: 'sunshine' }
        : await remoteVariantsService.getActiveVariants()
      applyRemoteVariants(active.variants)

      const data = await fetchFromApis(language)
      const dataWithRevision: CachedFile = {
        ...data,
        dataRevision: CHAMPION_DATA_REVISION,
        variantsHash: active.hash
      }

      // Cache in memory
      this.cachedData.set(language, dataWithRevision)

      // Save to disk
      await this.saveToDisk(language, dataWithRevision)

      console.log(
        `[ChampionData] Fetched ${data.champions.length} champions (v${data.version}) for ${language}`
      )

      return {
        success: true,
        message: `Successfully fetched data for ${data.champions.length} champions`,
        championCount: data.champions.length
      }
    } catch (error) {
      console.error('Error fetching champion data:', error)
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch champion data'
      }
    }
  }

  private async loadRawChampionData(
    language: string = 'en_US'
  ): Promise<{ version: string; champions: Champion[] } | null> {
    // Check memory cache
    const cached = this.cachedData.get(language)
    if (cached) return cached

    // Deduplicate concurrent loads for the same language
    const pending = this.pendingLoads.get(language)
    if (pending) return pending

    const loadPromise = this.loadChampionDataInternal(language)
    this.pendingLoads.set(language, loadPromise)

    try {
      return await loadPromise
    } finally {
      this.pendingLoads.delete(language)
    }
  }

  private async loadChampionDataInternal(
    language: string
  ): Promise<{ version: string; champions: Champion[] } | null> {
    // Check disk cache
    const diskData = await this.loadFromDisk(language)

    // Load remote variants before any data is used; a changed variants.md
    // invalidates the cache so users get new chroma wheels without an app update
    const active = sunshineCatalogService.isActive()
      ? { variants: {}, hash: 'sunshine' }
      : await remoteVariantsService.getActiveVariants()
    applyRemoteVariants(active.variants)

    if (diskData) {
      // Always check if version/revision/variants are still current (force update to latest)
      try {
        const latestVersion = await fetchLatestVersion()
        if (
          diskData.version === latestVersion &&
          diskData.dataRevision === CHAMPION_DATA_REVISION &&
          diskData.variantsHash === active.hash
        ) {
          this.cachedData.set(language, diskData)
          console.log(
            `[ChampionData] Loaded ${language} from disk cache (v${diskData.version}) - already latest`
          )
          return diskData
        }
        console.log(
          `[ChampionData] Disk cache outdated (v${diskData.version}, revision ${diskData.dataRevision ?? 0}, variants ${diskData.variantsHash ?? 'none'} vs ${active.hash || 'none'}), fetching latest...`
        )
        // Fetch fresh data with the latest version
        const result = await this.fetchAndSaveChampionData(language)
        if (result.success) {
          return this.cachedData.get(language) || null
        }
        // If fetch fails, use disk cache as fallback
        console.warn(`[ChampionData] Failed to fetch latest, using disk cache for ${language}`)
        this.cachedData.set(language, diskData)
        return diskData
      } catch {
        // If version check fails (no network), use disk cache
        this.cachedData.set(language, diskData)
        console.log(`[ChampionData] Version check failed, using disk cache for ${language}`)
        return diskData
      }
    }

    // No disk cache, fetch fresh data
    const result = await this.fetchAndSaveChampionData(language)
    if (result.success) {
      return this.cachedData.get(language) || null
    }

    return null
  }

  public async getChampionById(
    championId: string,
    language: string = 'en_US'
  ): Promise<Champion | null> {
    const data = await this.loadChampionData(language)
    if (!data) return null
    return (
      data.champions.find((c) => c.id.toString() === championId || c.key === championId) || null
    )
  }

  public async getChampionByKey(
    championKey: string,
    language: string = 'en_US'
  ): Promise<Champion | null> {
    return this.getChampionById(championKey, language)
  }

  public async checkForUpdates(language: string = 'en_US'): Promise<boolean> {
    try {
      const currentData = this.cachedData.get(language)
      if (!currentData) return true
      const latestVersion = await fetchLatestVersion()
      return currentData.version !== latestVersion
    } catch {
      return true
    }
  }

  public async fetchAllLanguages(): Promise<{ success: boolean; message: string }> {
    // This is no longer needed since we only fetch the user's current language
    // Keep for backward compat but just return success
    return { success: true, message: 'Use fetchAndSaveChampionData with a specific language' }
  }

  private buildChampionIdCache(language: string, champions: Champion[]): void {
    const idCache = new Map<number, Champion>()
    const nameCache = new Map<string, Champion>()

    champions.forEach((champion) => {
      idCache.set(champion.id, champion)
      nameCache.set(champion.name.toLowerCase(), champion)
      nameCache.set(champion.key.toLowerCase(), champion)
      if (champion.nameEn) {
        nameCache.set(champion.nameEn.toLowerCase(), champion)
      }
    })

    this.championIdCache.set(language, idCache)
    this.championNameCache.set(language, nameCache)
  }

  public async getChampionByNumericId(
    championId: number,
    language: string = 'en_US'
  ): Promise<Champion | null> {
    const data = await this.loadChampionData(language)
    if (!data) return null

    if (!this.championIdCache.has(language)) {
      this.buildChampionIdCache(language, data.champions)
    }

    return this.championIdCache.get(language)?.get(championId) || null
  }

  public async getSkinByIds(
    championId: number,
    skinId: string,
    language: string = 'en_US'
  ): Promise<Skin | null> {
    const champion = await this.getChampionByNumericId(championId, language)
    if (!champion) return null
    return champion.skins.find((s) => s.id === skinId || s.num.toString() === skinId) || null
  }

  public async getChampionNameById(
    championId: number,
    language: string = 'en_US'
  ): Promise<string | null> {
    const champion = await this.getChampionByNumericId(championId, language)
    return champion ? champion.name : null
  }

  public clearIdCache(): void {
    this.championIdCache.clear()
    this.championNameCache.clear()
  }

  public getChampionByNameSync(championName: string, language: string = 'en_US'): Champion | null {
    const data = this.getCurrentData(language)
    if (!data) return null

    if (!this.championNameCache.has(language)) {
      this.buildChampionIdCache(language, data.champions)
    }

    return this.championNameCache.get(language)?.get(championName.toLowerCase()) || null
  }

  public getChampionByIdSync(championId: number, language: string = 'en_US'): Champion | null {
    const data = this.getCurrentData(language)
    if (!data) {
      console.warn(
        `[ChampionData] getChampionByIdSync: No data loaded for language ${language}. Champion ID: ${championId}`
      )
      return null
    }

    if (!this.championIdCache.has(language)) {
      this.buildChampionIdCache(language, data.champions)
    }

    const champion = this.championIdCache.get(language)?.get(championId) || null
    if (!champion) {
      console.warn(
        `[ChampionData] getChampionByIdSync: Champion not found for ID ${championId}, language ${language}`
      )
    }

    return champion
  }
}

// Singleton instance
export const championDataService = new ChampionDataService()
