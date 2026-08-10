import axios from 'axios'
import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import {
  SkinRepository,
  RepositorySettings,
  DEFAULT_REPOSITORY,
  DEFAULT_REPOSITORY_STRUCTURE,
  RepositoryDetectionResult
} from '../types/repository.types'
import { settingsService } from './settingsService'
import { championDataService } from './championDataService'
import { repositoryDetector } from './repositoryDetector'

export class RepositoryService {
  private static instance: RepositoryService
  private repositories: SkinRepository[] = []
  private activeRepositoryId: string = DEFAULT_REPOSITORY.id

  // skin_ids.json: maps skin/chroma ID → repo name
  private skinIdsMap: Map<string, string> = new Map()
  private skinIdsReverseMap: Map<string, string> = new Map()
  private skinIdsFetchPromise: Promise<void> | null = null

  private constructor() {
    this.loadRepositories()
    // Fetch skin IDs in background
    this.fetchSkinIds()
  }

  static getInstance(): RepositoryService {
    if (!RepositoryService.instance) {
      RepositoryService.instance = new RepositoryService()
    }
    return RepositoryService.instance
  }

  // ========== Skin IDs Map ==========

  /**
   * Fetches skin_ids.json from the LeagueSkins repo and caches it
   */
  async fetchSkinIds(): Promise<void> {
    if (this.skinIdsFetchPromise) return this.skinIdsFetchPromise

    this.skinIdsFetchPromise = this.fetchSkinIdsInternal()
    try {
      await this.skinIdsFetchPromise
    } finally {
      this.skinIdsFetchPromise = null
    }
  }

  private async fetchSkinIdsInternal(): Promise<void> {
    const cacheDir = path.join(app.getPath('userData'), 'champion-data')
    const cachePath = path.join(cacheDir, 'skin-ids.json')

    // Try loading from disk cache first
    try {
      if (existsSync(cachePath)) {
        const raw = await fs.readFile(cachePath, 'utf-8')
        const data = JSON.parse(raw) as Record<string, string>
        this.buildSkinIdsMaps(data)
        console.log(`[SkinIds] Loaded ${this.skinIdsMap.size} entries from disk cache`)
      }
    } catch {
      // Cache read failed, will fetch from network
    }

    // Fetch fresh data from GitHub
    try {
      const url =
        'https://raw.githubusercontent.com/Alban1911/LeagueSkins/refs/heads/main/resources/default/skin_ids.json'
      const response = await axios.get<Record<string, string>>(url, { timeout: 15000 })
      const data = response.data
      this.buildSkinIdsMaps(data)

      // Save to disk
      try {
        if (!existsSync(cacheDir)) {
          await fs.mkdir(cacheDir, { recursive: true })
        }
        await fs.writeFile(cachePath, JSON.stringify(data), 'utf-8')
      } catch (err) {
        console.error('[SkinIds] Failed to save to disk:', err)
      }

      console.log(`[SkinIds] Fetched ${this.skinIdsMap.size} entries from GitHub`)
    } catch (err) {
      if (this.skinIdsMap.size > 0) {
        console.warn('[SkinIds] Network fetch failed, using disk cache')
      } else {
        console.error('[SkinIds] Failed to fetch skin_ids.json:', err)
      }
    }
  }

  private buildSkinIdsMaps(data: Record<string, string>): void {
    this.skinIdsMap.clear()
    this.skinIdsReverseMap.clear()
    for (const [id, name] of Object.entries(data)) {
      this.skinIdsMap.set(id, name)
      this.skinIdsReverseMap.set(name, id)
      // Also store normalized version (without invalid filename chars)
      const normalized = name.replace(/[:/\\*?"<>|]/g, '')
      if (normalized !== name) {
        this.skinIdsReverseMap.set(normalized, id)
      }
    }
  }

  getSkinNameById(id: string): string | null {
    return this.skinIdsMap.get(id) || null
  }

  getSkinIdByName(name: string): string | null {
    return this.skinIdsReverseMap.get(name) || null
  }

  async ensureSkinIds(): Promise<void> {
    if (this.skinIdsMap.size === 0) {
      await this.fetchSkinIds()
    }
  }

  // ========== Multi-Repository Management ==========

  private loadRepositories(): void {
    try {
      const settings = settingsService.get('repositorySettings') as RepositorySettings
      if (settings) {
        const storedRepositories = Array.isArray(settings.repositories) ? settings.repositories : []
        this.repositories =
          storedRepositories.length > 0 ? storedRepositories : [{ ...DEFAULT_REPOSITORY }]
        this.activeRepositoryId = settings.activeRepositoryId || DEFAULT_REPOSITORY.id

        // Handle migration from lol-skins to LeagueSkins default
        const defaultChanged = this.migrateDefaultRepository()

        // Migrate repositories without structure field
        this.migrateRepositories()

        if (defaultChanged) {
          this.saveRepositories()
        }
      } else {
        // Initialize with default repository
        this.repositories = [{ ...DEFAULT_REPOSITORY }]
        this.activeRepositoryId = DEFAULT_REPOSITORY.id
        this.saveRepositories()
      }
    } catch (error) {
      console.error('Failed to load repositories:', error)
      this.repositories = [DEFAULT_REPOSITORY]
      this.activeRepositoryId = DEFAULT_REPOSITORY.id
    }
  }

  private migrateRepositories(): void {
    let migrated = false

    this.repositories = this.repositories.map((repo) => {
      if (!repo.structure || !repo.structure.type) {
        migrated = true
        return {
          ...repo,
          structure: {
            type: 'name-based' as const,
            skinsPath: repo.structure?.skinsPath || 'skins',
            chromaPattern: repo.structure?.chromaPattern,
            autoDetected: false
          }
        }
      }
      return repo
    })

    if (migrated) {
      this.saveRepositories()
    }

    // Auto-detect repositories that weren't auto-detected yet (async in background)
    this.autoDetectUndetectedRepositories()
  }

  private migrateDefaultRepository(): boolean {
    let hasChanges = false

    // Remove legacy default from darkseal-org/lol-skins
    const filteredRepositories: SkinRepository[] = []
    for (const repo of this.repositories) {
      const isLegacyDefault =
        repo.id === 'darkseal-default' ||
        (repo.isDefault && repo.owner === 'darkseal-org' && repo.repo === 'lol-skins')

      if (isLegacyDefault) {
        hasChanges = true
        if (this.activeRepositoryId === repo.id) {
          this.activeRepositoryId = DEFAULT_REPOSITORY.id
        }
        continue
      }

      filteredRepositories.push(repo)
    }
    this.repositories = filteredRepositories

    // Find existing LeagueSkins repositories
    const leagueSkinsEntries = this.repositories.filter((repo) =>
      this.isLeagueSkinsRepository(repo)
    )

    let defaultRepositoryIndex = -1

    if (leagueSkinsEntries.length > 0) {
      hasChanges = true

      const primaryEntry =
        leagueSkinsEntries.find((repo) => repo.isDefault) ?? leagueSkinsEntries[0]

      this.repositories = this.repositories.filter((repo) => {
        if (!this.isLeagueSkinsRepository(repo)) {
          return true
        }
        return repo === primaryEntry
      })

      defaultRepositoryIndex = this.repositories.findIndex((repo) => repo === primaryEntry)

      if (this.activeRepositoryId === primaryEntry.id) {
        this.activeRepositoryId = DEFAULT_REPOSITORY.id
      }

      const normalizedStructure = {
        type: 'id-based' as const,
        skinsPath: primaryEntry.structure?.skinsPath || 'skins',
        chromaPattern: primaryEntry.structure?.chromaPattern,
        autoDetected: true
      }

      const normalizedRepo: SkinRepository = {
        ...DEFAULT_REPOSITORY,
        branch: primaryEntry.branch || DEFAULT_REPOSITORY.branch,
        structure: normalizedStructure,
        lastChecked: primaryEntry.lastChecked,
        status: primaryEntry.status || DEFAULT_REPOSITORY.status
      }

      if (defaultRepositoryIndex !== -1) {
        this.repositories[defaultRepositoryIndex] = normalizedRepo
      } else {
        this.repositories.unshift(normalizedRepo)
      }
    }

    // Ensure default repository exists
    if (leagueSkinsEntries.length === 0) {
      if (!this.repositories.find((repo) => repo.id === DEFAULT_REPOSITORY.id)) {
        this.repositories.unshift({ ...DEFAULT_REPOSITORY })
        hasChanges = true
      }
    }

    // Ensure active repository points to a valid entry
    if (!this.repositories.find((repo) => repo.id === this.activeRepositoryId)) {
      this.activeRepositoryId = DEFAULT_REPOSITORY.id
      hasChanges = true
    }

    return hasChanges
  }

  private isLeagueSkinsRepository(repo: SkinRepository): boolean {
    return (
      repo.owner?.toLowerCase() === DEFAULT_REPOSITORY.owner.toLowerCase() &&
      repo.repo?.toLowerCase() === DEFAULT_REPOSITORY.repo.toLowerCase()
    )
  }

  private async autoDetectUndetectedRepositories(): Promise<void> {
    const undetectedRepos = this.repositories.filter(
      (repo) => repo.structure && !repo.structure.autoDetected && !repo.isDefault
    )

    if (undetectedRepos.length === 0) return

    for (const repo of undetectedRepos) {
      try {
        const detection = await repositoryDetector.detectRepositoryStructure(
          repo.owner,
          repo.repo,
          repo.branch,
          repo.structure?.skinsPath
        )

        this.updateRepository(repo.id, {
          structure: {
            type: detection.type,
            skinsPath: detection.skinsPath,
            autoDetected: true
          }
        })

        console.log(
          `✓ Detected ${repo.owner}/${repo.repo} as ${detection.type} (${detection.confidence}% confidence)`
        )
      } catch (error) {
        console.error(`Failed to auto-detect ${repo.owner}/${repo.repo}:`, error)
        this.updateRepository(repo.id, {
          structure: {
            ...(repo.structure || { type: 'name-based', skinsPath: 'skins' }),
            autoDetected: true
          }
        })
      }
    }
  }

  private saveRepositories(): void {
    try {
      const settings: RepositorySettings = {
        repositories: this.repositories,
        activeRepositoryId: this.activeRepositoryId,
        allowMultipleActive: false
      }
      settingsService.set('repositorySettings', settings)
    } catch (error) {
      console.error('Failed to save repositories:', error)
    }
  }

  getRepositories(): SkinRepository[] {
    return [...this.repositories]
  }

  getActiveRepository(): SkinRepository {
    const active = this.repositories.find((r) => r.id === this.activeRepositoryId)
    return active || DEFAULT_REPOSITORY
  }

  getRepositoryById(id: string): SkinRepository | undefined {
    return this.repositories.find((r) => r.id === id)
  }

  setActiveRepository(id: string): boolean {
    const repo = this.repositories.find((r) => r.id === id)
    if (repo) {
      this.activeRepositoryId = id
      this.saveRepositories()
      return true
    }
    return false
  }

  async addRepository(repository: Omit<SkinRepository, 'id' | 'status'>): Promise<SkinRepository> {
    const id = `${repository.owner}-${repository.repo}-${Date.now()}`

    const newRepo: SkinRepository = {
      ...repository,
      id,
      status: 'unchecked',
      isCustom: true,
      isDefault: false
    }

    // Validate before adding
    const isValid = await this.validateRepository(newRepo)
    if (!isValid) {
      throw new Error('Invalid repository structure')
    }

    this.repositories.push(newRepo)
    this.saveRepositories()
    return newRepo
  }

  async addRepositoryWithDetection(
    owner: string,
    repo: string,
    branch: string = 'main',
    name?: string
  ): Promise<{ repository: SkinRepository; detection: RepositoryDetectionResult }> {
    const detection = await repositoryDetector.detectRepositoryStructure(owner, repo, branch)

    const repository: Omit<SkinRepository, 'id' | 'status'> = {
      name: name || `${owner}/${repo}`,
      owner,
      repo,
      branch,
      isDefault: false,
      isCustom: true,
      structure: {
        type: detection.type,
        skinsPath: detection.skinsPath,
        autoDetected: true
      }
    }

    const newRepo = await this.addRepository(repository)
    return { repository: newRepo, detection }
  }

  async redetectRepositoryStructure(id: string): Promise<RepositoryDetectionResult> {
    const repo = this.getRepositoryById(id)
    if (!repo) {
      throw new Error('Repository not found')
    }

    const detection = await repositoryDetector.detectRepositoryStructure(
      repo.owner,
      repo.repo,
      repo.branch,
      repo.structure?.skinsPath
    )

    this.updateRepository(id, {
      structure: {
        type: detection.type,
        skinsPath: detection.skinsPath,
        autoDetected: true
      }
    })

    return detection
  }

  removeRepository(id: string): boolean {
    const repo = this.repositories.find((r) => r.id === id)
    if (!repo || repo.isDefault) return false
    if (this.activeRepositoryId === id) return false

    this.repositories = this.repositories.filter((r) => r.id !== id)
    this.saveRepositories()
    return true
  }

  updateRepository(id: string, updates: Partial<SkinRepository>): boolean {
    const index = this.repositories.findIndex((r) => r.id === id)
    if (index === -1) return false

    delete updates.id
    delete updates.isDefault

    this.repositories[index] = {
      ...this.repositories[index],
      ...updates
    }

    this.saveRepositories()
    return true
  }

  async validateRepository(repository: SkinRepository): Promise<boolean> {
    try {
      repository.status = 'checking'
      this.saveRepositories()

      const repoUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}`
      const repoResponse = await axios.get(repoUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Bocchi-LoL-Skin-Manager'
        },
        timeout: 10000
      })

      if (repoResponse.status !== 200) {
        repository.status = 'error'
        this.saveRepositories()
        return false
      }

      const skinsPath = repository.structure?.skinsPath || 'skins'
      const contentsUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}/contents/${skinsPath}?ref=${repository.branch}`

      try {
        const contentsResponse = await axios.get(contentsUrl, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Bocchi-LoL-Skin-Manager'
          },
          timeout: 10000
        })

        if (contentsResponse.status === 200 && Array.isArray(contentsResponse.data)) {
          repository.status = 'active'
          repository.lastChecked = new Date()
          this.saveRepositories()
          return true
        }
      } catch {
        console.error(`Skins folder not found in repository ${repository.owner}/${repository.repo}`)
      }

      repository.status = 'error'
      this.saveRepositories()
      return false
    } catch (error) {
      console.error(`Failed to validate repository ${repository.owner}/${repository.repo}:`, error)
      repository.status = 'error'
      this.saveRepositories()
      return false
    }
  }

  // ========== URL Construction ==========

  constructGitHubUrl(
    championName: string,
    skinFile: string,
    isChroma: boolean = false,
    chromaBase?: string,
    championId?: number,
    isClassic?: boolean
  ): string {
    const repo = this.getActiveRepository()
    const structure = repo.structure || DEFAULT_REPOSITORY_STRUCTURE
    const skinsPath = isClassic ? 'classic' : structure.skinsPath

    // Classic skins use a fixed ID-based structure under classic/ path
    if (isClassic && championId) {
      return this.constructClassicUrl(championId, skinFile, repo, isChroma, chromaBase)
    }

    // If ID-based repository, convert names to IDs
    if (structure.type === 'id-based') {
      if (championId) {
        return this.constructIdBasedUrlWithId(championId, skinFile, repo, skinsPath)
      }
      return this.constructIdBasedUrl(championName, skinFile, repo, skinsPath)
    }

    // Name-based repository (default)
    if (isChroma && chromaBase) {
      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championName}/chromas/${encodeURIComponent(chromaBase)}/${encodeURIComponent(skinFile)}`
    }

    return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championName}/${encodeURIComponent(skinFile)}`
  }

  /**
   * Constructs a URL for classic skins stored in the classic/ folder.
   * Classic skins use the structure: classic/{jadeChampionId}/{jadeSkinId}/{jadeSkinId}.fantome
   * Classic chromas use: classic/{jadeChampionId}/{parentJadeSkinId}/{chromaJadeId}/{chromaJadeId}.fantome
   * The jade champion ID = 60000 + realChampionId (e.g., 60103 for Ahri)
   * The jade skin ID = jadeChampionId * 1000 + skinNum (e.g., 60103301 for Classic Ahri)
   */
  private constructClassicUrl(
    championId: number,
    skinFile: string,
    repo: SkinRepository,
    isChroma: boolean = false,
    _chromaBase?: string
  ): string {
    const jadeChampionId = 60000 + championId

    // Extract classic num from skinFile if it contains the _classic_ marker
    const classicIdMatch = skinFile.match(/_classic_(\d+)/)
    if (classicIdMatch) {
      const classicNum = parseInt(classicIdMatch[1], 10)
      const jadeSkinId = jadeChampionId * 1000 + classicNum

      // Check if this is a chroma request (skinFile has chroma info appended)
      // Chromas for classic skins: the chromaId is embedded in the filename as "skinId chromaId.zip"
      const chromaMatch = skinFile.match(/\s(\d+)\.(zip|fantome)$/i)
      if (isChroma && chromaMatch) {
        const chromaId = chromaMatch[1]
        // Find the parent skin ID (the base classic skin for this chroma)
        // The parent is the 301 skin, chromas are 302, 303, etc.
        const parentJadeSkinId = jadeChampionId * 1000 + 301 // Default to 301 as parent
        return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/classic/${jadeChampionId}/${parentJadeSkinId}/${chromaId}/${chromaId}.fantome`
      }

      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/classic/${jadeChampionId}/${jadeSkinId}/${jadeSkinId}.fantome`
    }

    // Handle chroma downloads where skinFile is "SkinName chromaId.zip" format
    if (isChroma) {
      const chromaFileMatch = skinFile.match(/^(.+?)\s+(\d+)\.(zip|fantome)$/i)
      if (chromaFileMatch) {
        const chromaId = chromaFileMatch[2]
        // Look up the parent skin in skin_ids to find its jade ID
        const baseName = chromaFileMatch[1]
        const parentSkinIdFromMap = this.getSkinIdByName(baseName)
        if (parentSkinIdFromMap) {
          return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/classic/${jadeChampionId}/${parentSkinIdFromMap}/${chromaId}/${chromaId}.fantome`
        }
      }
    }

    const baseName = skinFile.replace(/\.(zip|fantome)$/i, '')

    // Search for a matching entry in skin_ids reverse map
    const skinIdFromMap = this.getSkinIdByName(baseName)
    if (skinIdFromMap) {
      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/classic/${jadeChampionId}/${skinIdFromMap}/${skinIdFromMap}.fantome`
    }

    // Fallback: try to find via champion data
    const champion = championDataService.getChampionByIdSync(championId)
    if (champion) {
      const matchingSkin = champion.skins.find((s) => {
        if (s.skinType !== 'classic') return false
        const skinName = s.nameEn || s.name
        return skinName === baseName
      })

      if (matchingSkin) {
        const classicNum = matchingSkin.id.split('_classic_')[1]
        if (classicNum) {
          const jadeSkinId = jadeChampionId * 1000 + parseInt(classicNum, 10)
          return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/classic/${jadeChampionId}/${jadeSkinId}/${jadeSkinId}.fantome`
        }
      }
    }

    throw new Error(`Classic skin "${baseName}" not found for champion ${championId}`)
  }

  private constructIdBasedUrl(
    championName: string,
    skinFile: string,
    repo: SkinRepository,
    skinsPath: string
  ): string {
    const champion = championDataService.getChampionByNameSync(championName)
    if (!champion) {
      console.error(`[ID-Based URL] Champion not found by name: ${championName}`)
      throw new Error(`Champion not found: ${championName}`)
    }

    const championId = champion.id
    return this.constructIdBasedUrlWithId(championId, skinFile, repo, skinsPath)
  }

  private constructIdBasedUrlWithId(
    championId: number,
    skinFile: string,
    repo: SkinRepository,
    skinsPath: string
  ): string {
    const champion = championDataService.getChampionByIdSync(championId)
    if (!champion) {
      throw new Error(`Champion not found for ID: ${championId}`)
    }

    // Check if this is a chroma (has 5-6 digit ID in filename)
    const chromaMatch = skinFile.match(/(\d{5,6})\.(zip|fantome)$/i)
    if (chromaMatch) {
      const chromaId = chromaMatch[1]

      let skinId = ''
      let matchedSkin: any = null
      for (const skin of champion.skins) {
        if (skin.chromas && skin.chromaList) {
          const hasChroma = skin.chromaList.some((c) => c.id.toString() === chromaId)
          if (hasChroma) {
            skinId = championId.toString() + skin.num.toString().padStart(3, '0')
            matchedSkin = skin
            break
          }
        }
      }

      if (skinId && matchedSkin) {
        // For tiered skins, the chroma variant lives under the parent skin's folder
        const parentSkin = this.findParentSkin(champion, matchedSkin)
        const urlSkinId = parentSkin
          ? championId.toString() + parentSkin.num.toString().padStart(3, '0')
          : skinId
        return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${urlSkinId}/${chromaId}/${chromaId}.fantome`
      }
    }

    // Regular skin
    const baseName = skinFile.replace(/\.(zip|fantome)$/i, '')

    // Try to find the skin by name in champion data
    const matchingSkin = champion.skins.find((s) => {
      const skinName = (s as any).lolSkinsName || s.nameEn || s.name
      return skinName === baseName
    })

    if (matchingSkin) {
      const skinId = championId.toString() + matchingSkin.num.toString().padStart(3, '0')
      // Check if this skin might be a tiered/exalted variation (stored under parent skin)
      // Tiered skins have their file inside the parent skin's folder
      const parentSkin = this.findParentSkin(champion, matchingSkin)
      if (parentSkin) {
        const parentSkinId = championId.toString() + parentSkin.num.toString().padStart(3, '0')
        return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${parentSkinId}/${skinId}/${skinId}.fantome`
      }
      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${skinId}/${skinId}.fantome`
    }

    // Fallback: try reverse lookup in skin_ids.json (name → id)
    const skinIdFromMap = this.getSkinIdByName(baseName)
    if (skinIdFromMap) {
      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${skinIdFromMap}/${skinIdFromMap}.fantome`
    }

    // Fallback: try matching by normalized name (case-insensitive, ignore special chars)
    const normalizedBase = baseName.toLowerCase().replace(/[^a-z0-9]/g, '')
    const matchByNormalized = champion.skins.find((s) => {
      const skinName = (s as any).lolSkinsName || s.nameEn || s.name
      const normalized = skinName.toLowerCase().replace(/[^a-z0-9]/g, '')
      return normalized === normalizedBase
    })

    if (matchByNormalized) {
      const skinId = championId.toString() + matchByNormalized.num.toString().padStart(3, '0')
      const parentSkin = this.findParentSkin(champion, matchByNormalized)
      if (parentSkin) {
        const parentSkinId = championId.toString() + parentSkin.num.toString().padStart(3, '0')
        return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${parentSkinId}/${skinId}/${skinId}.fantome`
      }
      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${skinId}/${skinId}.fantome`
    }

    // Last resort: construct from skin num by iterating all skins and checking partial match
    const partialMatch = champion.skins.find((s) => {
      const skinName = ((s as any).lolSkinsName || s.nameEn || s.name).toLowerCase()
      return skinName.includes(normalizedBase) || normalizedBase.includes(skinName.replace(/[^a-z0-9]/g, ''))
    })

    if (partialMatch) {
      const skinId = championId.toString() + partialMatch.num.toString().padStart(3, '0')
      const parentSkin = this.findParentSkin(champion, partialMatch)
      if (parentSkin) {
        const parentSkinId = championId.toString() + parentSkin.num.toString().padStart(3, '0')
        return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${parentSkinId}/${skinId}/${skinId}.fantome`
      }
      return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${skinsPath}/${championId}/${skinId}/${skinId}.fantome`
    }

    console.error(`[ID-Based URL] Could not resolve skin "${baseName}" for champion ${champion.name} (${championId})`)
    console.error(`[ID-Based URL] Available skins: ${champion.skins.map(s => `${s.num}:${(s as any).lolSkinsName || s.nameEn || s.name}`).join(', ')}`)
    throw new Error(`Skin "${baseName}" not found for champion ${champion.name}`)
  }

  /**
   * Finds the parent skin for tiered/exalted variations.
   * In the repo, tiered variations are stored under their parent skin's folder.
   * E.g., 103086 (Immortalized Legend Ahri) is stored under 103085 (Risen Legend Ahri).
   */
  private findParentSkin(champion: any, skin: any): any | null {
    const skinId = champion.id.toString() + skin.num.toString().padStart(3, '0')
    // If this skin ID exists in skin_ids.json, it's a top-level skin (not a variation)
    if (this.getSkinNameById(skinId)) {
      return null
    }
    // This skin is NOT in skin_ids.json — it's likely a tiered variation
    // Look for the parent: the closest lower-numbered skin that IS in skin_ids.json
    for (let num = skin.num - 1; num >= 0; num--) {
      const parentId = champion.id.toString() + num.toString().padStart(3, '0')
      if (this.getSkinNameById(parentId)) {
        // Found the parent skin
        const parentSkin = champion.skins.find((s: any) => s.num === num)
        if (parentSkin) return parentSkin
        // Return a fake object with just the num
        return { num }
      }
    }
    return null
  }

  constructRawUrl(url: string): string {
    return url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
  }

  parseGitHubUrl(
    url: string
  ): { owner: string; repo: string; branch: string; path: string } | null {
    const patterns = [
      /github\.com\/([^/]+)\/([^/]+)\/(blob|raw)\/([^/]+)\/(.+)$/,
      /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
    ]

    for (const pattern of patterns) {
      const match = url.match(pattern)
      if (match) {
        if (url.includes('raw.githubusercontent.com')) {
          return {
            owner: match[1],
            repo: match[2],
            branch: match[3],
            path: match[4]
          }
        } else {
          return {
            owner: match[1],
            repo: match[2],
            branch: match[4],
            path: match[5]
          }
        }
      }
    }

    return null
  }
}

// Export singleton instance
export const repositoryService = RepositoryService.getInstance()
