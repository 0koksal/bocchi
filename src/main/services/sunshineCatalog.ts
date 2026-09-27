import type { Champion, Chroma, Skin } from './championFetcher'
import { generateSkinFilename } from '../../shared/utils/skinFilename'
import type { SkinRepository, RepositorySettings } from '../types/repository.types'
import { DEFAULT_REPOSITORY } from '../types/repository.types'

export interface CatalogChampion {
  skins: Record<string, string>
  chromas?: Record<string, Record<string, string>>
  forms?: Record<string, Record<string, string>>
}

export interface SunshineCatalog {
  patch: string
  champions: Record<string, CatalogChampion>
}

export interface ClassicCatalog {
  schemaVersion: number
  champions: Array<{
    id: number
    key: string
    baseId: number
    skins: Array<{
      id: string
      num: number
      name: string
      parentSkinId?: string | null
      path: string
      tile?: string
      loading?: string
    }>
  }>
}

export function isSunshineRepository(repo: Pick<SkinRepository, 'owner' | 'repo'>): boolean {
  return repo.owner.toLowerCase() === 'bettie9' && repo.repo.toLowerCase() === 'leagueskins'
}

export function selectedRepository(settings?: RepositorySettings): SkinRepository {
  return (
    settings?.repositories?.find((repo) => repo.id === settings.activeRepositoryId) ??
    DEFAULT_REPOSITORY
  )
}

export function catalogRoot(repo: SkinRepository): string {
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.branch}`
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function names(value: unknown): value is Record<string, string> {
  return (
    record(value) &&
    Object.entries(value).every(
      ([id, name]) => /^\d{1,3}$/.test(id) && typeof name === 'string' && name.trim().length > 0
    )
  )
}

export function isSunshineCatalog(value: unknown): value is SunshineCatalog {
  if (
    !record(value) ||
    typeof value.patch !== 'string' ||
    !record(value.champions) ||
    !Object.keys(value.champions).length
  )
    return false
  return Object.entries(value.champions).every(([key, champion]) => {
    if (!/^[A-Za-z0-9_]+$/.test(key) || !record(champion) || !names(champion.skins)) return false
    const skinNames = champion.skins
    const ids = new Set(Object.keys(skinNames))
    return ['chromas', 'forms'].every((kind) => {
      const groups = champion[kind]
      return (
        groups === undefined ||
        (record(groups) &&
          Object.entries(groups).every(
            ([parent, children]) =>
              /^\d{1,3}$/.test(parent) &&
              (parent === '0' || parent in skinNames) &&
              names(children) &&
              Object.keys(children).every((id) => {
                if (ids.has(id)) return false
                ids.add(id)
                return true
              })
          ))
      )
    })
  })
}

export function isClassicCatalog(value: unknown): value is ClassicCatalog {
  return (
    record(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.champions) &&
    value.champions.every(
      (c) =>
        record(c) &&
        Number.isInteger(c.id) &&
        Number.isInteger(c.baseId) &&
        typeof c.key === 'string' &&
        /^Jade_[A-Za-z0-9_]+$/.test(c.key) &&
        Array.isArray(c.skins) &&
        c.skins.every(
          (s) =>
            record(s) &&
            typeof s.id === 'string' &&
            /^\d+$/.test(s.id) &&
            typeof s.name === 'string' &&
            Number.isInteger(s.num) &&
            (s.parentSkinId == null || typeof s.parentSkinId === 'string') &&
            s.path === `${c.key}/${s.id}.fantome`
        )
    )
  )
}

// Match the publisher's safe_name(), including directory-only trailing-dot removal.
export function packageName(name: string, directory = false): string {
  let result = name
    .replace(/:/g, '')
    // eslint-disable-next-line no-control-regex -- Match the publisher's filename sanitization.
    .replace(/[<>"/\\|?*\x00-\x1f]/g, '_')
    .trim()
  if (directory) result = result.replace(/[ .]+$/, '')
  return result && result !== '.' && result !== '..' ? result : 'Unnamed'
}

export function projectSunshineChampion(
  champion: Champion,
  catalog: SunshineCatalog,
  classic?: ClassicCatalog | null
): Champion {
  const published = catalog.champions[champion.key]
  const native = champion.skins.filter((s) => s.skinType !== 'classic')
  const byNum = new Map(native.map((skin) => [skin.num, skin]))
  const defaultSkin: Skin = byNum.get(0) ?? {
    id: `${champion.id}_0`,
    num: 0,
    name: champion.name,
    chromas: false,
    rarity: 'kNoRarity',
    rarityGemPath: null,
    isLegacy: false,
    skinType: ''
  }
  const knownChromas = new Map(native.flatMap((s) => s.chromaList ?? []).map((c) => [c.id, c]))
  const skins: Skin[] = []
  // Keep the base card for native chromas; only published variants survive.
  for (const [num, name] of Object.entries({ 0: champion.name, ...published?.skins })) {
    const original = byNum.get(Number(num)) ?? defaultSkin
    const parent = Number(num) === 0 ? champion.key : name
    const folder = `skins/${champion.key}/${packageName(parent, true)}`
    const chromaList: Chroma[] = []
    // Labels, not synthetic IDs, determine display order. Forms precede colors.
    for (const kind of ['forms', 'chromas'] as const) {
      for (const [id, label] of Object.entries(published?.[kind]?.[num] ?? {}).sort((a, b) =>
        a[1].localeCompare(b[1], 'en', { numeric: true })
      )) {
        const fullId = champion.id * 1000 + Number(id)
        const art = knownChromas.get(fullId)
        chromaList.push({
          id: fullId,
          name: label,
          kind: kind === 'forms' ? 'form' : 'chroma',
          colors: kind === 'forms' ? [] : (art?.colors ?? []),
          chromaPath:
            kind === 'chromas' && art?.chromaPath
              ? art.chromaPath
              : `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${champion.key}_${byNum.has(Number(id)) ? id : num}.jpg`,
          catalogPath: `${folder}/${packageName(label)}.fantome`
        })
      }
    }
    skins.push({
      ...original,
      id: `${champion.id}_${num}`,
      num: Number(num),
      name: Number(num) === 0 ? champion.name : original === defaultSkin ? name : original.name,
      nameEn: Number(num) === 0 ? champion.nameEn : name,
      chromas: chromaList.length > 0,
      chromaList,
      catalogPath:
        Number(num) === 0 ? undefined : `skins/${champion.key}/${packageName(name)}.fantome`
    })
  }
  for (const entry of classic?.champions.filter((c) => c.baseId === champion.id) ?? []) {
    const ids = new Set(entry.skins.map((s) => s.id))
    for (const skin of entry.skins.filter((s) => !s.parentSkinId || !ids.has(s.parentSkinId))) {
      const chromaList: Chroma[] = entry.skins
        .filter((s) => s.parentSkinId === skin.id)
        .map((s) => ({
          id: Number(s.id),
          name: s.name,
          colors: [],
          chromaPath: s.tile || s.loading || '',
          kind: 'chroma',
          catalogPath: `classic/${s.path}`
        }))
      skins.push({
        ...defaultSkin,
        id: `${champion.id}_classic_${skin.num}`,
        num: skin.num + 10000,
        name: skin.name.startsWith('Classic ') ? skin.name : `${skin.name} (Classic)`,
        nameEn: skin.name.startsWith('Classic ') ? skin.name : `${skin.name} (Classic)`,
        skinType: 'classic',
        classicJadeAlias: entry.key,
        chromas: chromaList.length > 0,
        chromaList,
        catalogPath: `classic/${skin.path}`
      })
    }
  }
  return { ...champion, skins }
}

export function sunshinePackages(champion: Champion): Array<{
  path: string
  filename: string
  kind: 'skin' | 'form' | 'chroma'
  skin: Skin
  id: string
}> {
  return champion.skins.flatMap((skin) => [
    ...(skin.catalogPath
      ? [
          {
            path: skin.catalogPath,
            filename: generateSkinFilename(skin),
            kind: 'skin' as const,
            skin,
            id: skin.id
          }
        ]
      : []),
    ...(skin.chromaList ?? [])
      .filter((c) => c.catalogPath)
      .map((c) => ({
        path: c.catalogPath!,
        filename: generateSkinFilename({ ...skin, chromaId: String(c.id) }),
        kind: c.kind ?? ('chroma' as const),
        skin,
        id: String(c.id)
      }))
  ])
}

export function resolveSunshinePackage(champion: Champion, filename: string) {
  const name = filename.replace(/\.(zip|fantome)$/i, '')
  const matches = sunshinePackages(champion).filter(
    (p) => p.filename === name || (p.kind === 'skin' && p.id === name)
  )
  if (matches.length !== 1)
    throw new Error(
      `Skin is not uniquely published in the Sunshine catalog: ${champion.key}/${name}`
    )
  return matches[0]
}

export function sunshinePackageUrl(repo: SkinRepository, relativePath: string): string {
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}
