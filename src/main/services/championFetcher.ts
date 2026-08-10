import axios from 'axios'

// --- Types ---

interface CDragonChroma {
  id: number
  name: string
  chromaPath: string
  colors: string[]
}

interface CDragonTier {
  id: number
  name: string
  stage: number
  description: string
  splashPath: string
  uncenteredSplashPath: string
  tilePath: string
  loadScreenPath: string
  shortName: string
  splashVideoPath: string | null
  previewVideoUrl: string | null
  collectionSplashVideoPath: string | null
  collectionCardHoverVideoPath: string | null
}

interface CDragonSkin {
  id: number
  isBase: boolean
  name: string
  skinType: string
  rarity: string
  isLegacy: boolean
  skinLines?: Array<{ id: number }>
  description?: string
  chromas?: CDragonChroma[]
  questSkinInfo?: {
    productType: string
    tiers?: CDragonTier[]
  }
}

interface CDragonChampion {
  id: number
  name: string
  alias: string
  title: string
  championTagInfo: {
    championTagPrimary: string
    championTagSecondary: string
  }
  skins: CDragonSkin[]
}

export interface Chroma {
  id: number
  name: string
  chromaPath: string
  colors: string[]
}

export interface Skin {
  id: string
  num: number
  name: string
  nameEn?: string
  chromas: boolean
  chromaList?: Chroma[]
  rarity: string
  rarityGemPath: string | null
  isLegacy: boolean
  skinType: string
  skinLines?: Array<{ id: number }>
  description?: string
  winRate?: number
  pickRate?: number
  totalGames?: number
  classicJadeAlias?: string // Jade_ champion alias for classic skin image URLs
}

export interface Champion {
  id: number
  key: string
  name: string
  nameEn?: string
  title: string
  image: string
  skins: Skin[]
  tags: string[]
}

// --- Constants ---

const DDRAGON_BASE = 'https://ddragon.leagueoflegends.com'
const CDRAGON_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global'

const RARITY_MAP: Record<string, string> = {
  kEpic: 'epic',
  kLegendary: 'legendary',
  kUltimate: 'ultimate',
  kMythic: 'mythic'
}

function getRarityGemPath(rarity: string): string | null {
  const key = RARITY_MAP[rarity]
  if (!key) return null
  return `${CDRAGON_BASE}/default/v1/rarity-gem-icons/${key}.png`
}

function normalizeLocale(language: string): string {
  if (language === 'en_US') return 'default'
  return language.toLowerCase()
}

// --- Simple concurrency limiter ---

function pLimit(concurrency: number) {
  let active = 0
  const queue: Array<() => void> = []

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++
      const run = queue.shift()!
      run()
    }
  }

  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
  }
}

// --- Skin processing ---

// Known repo-only variants that aren't in CDragon data but exist in the LeagueSkins repository
// These get added as synthetic chromas so users can select them from the chroma wheel
const REPO_ONLY_VARIANTS: Record<number, Array<{ id: number; name: string; parentSkinNum: number; colors: string[] }>> = {
  // Jinx - Arcane Fractured Jinx (222060) has two variant forms
  222: [
    { id: 222998, name: 'Arcane Fractured Jinx (Form 1)', parentSkinNum: 60, colors: ['#00FF00', '#006400'] },
    { id: 222999, name: 'Arcane Fractured Jinx (Form 2)', parentSkinNum: 60, colors: ['#FF00FF', '#4B0082'] }
  ],
  // Sett - Radiant Serpent Sett (875066) has two variant forms
  875: [
    { id: 875998, name: 'Radiant Serpent Sett (Form 2)', parentSkinNum: 66, colors: ['#04e8f8', '#04e8f8'] },
    { id: 875999, name: 'Radiant Serpent Sett (Form 3)', parentSkinNum: 66, colors: ['#ec2323', '#ec2323'] }
  ],
  // Mordekaiser - Sahn-Uzal Mordekaiser (82054) has two variant forms
  82: [
    { id: 82998, name: 'Sahn-Uzal Mordekaiser (Form 2)', parentSkinNum: 54, colors: ['#8B0000', '#FF4500'] },
    { id: 82999, name: 'Sahn-Uzal Mordekaiser (Form 3)', parentSkinNum: 54, colors: ['#f39609', '#f39609'] }
  ],
  // Morgana - Spirit Blossom Morgana (25080) has one variant form
  25: [
    { id: 25999, name: 'Spirit Blossom Morgana (Form 2)', parentSkinNum: 80, colors: ['#FF69B4', '#8B008B'] }
  ],
  // Kai'Sa - Immortalized Legend Kai'Sa (145071) has one variant form
  145: [
    { id: 145999, name: 'Immortalized Legend Kai\'Sa (Form 2)', parentSkinNum: 71, colors: ['#ff0000', '#FF1493'] }
  ]
}

function processChromas(skin: CDragonSkin): Chroma[] | undefined {
  if (!skin.chromas || skin.chromas.length === 0) return undefined
  return skin.chromas.map((c) => ({
    id: c.id,
    name: c.name,
    chromaPath: c.chromaPath
      ? `${CDRAGON_BASE}/default${c.chromaPath.replace('/lol-game-data/assets/', '/')}`
      : '',
    colors: c.colors || []
  }))
}

function processTieredSkin(
  skin: CDragonSkin,
  championId: number,
  englishSkinNames?: Map<string, string>
): Skin[] {
  const tiers = skin.questSkinInfo?.tiers
  if (!tiers || tiers.length === 0) return []

  return tiers.map((tier, index) => {
    const skinNum = Math.floor(tier.id / 1000) === championId ? tier.id % 1000 : 0
    const skinId = `${championId}_${skinNum}`
    const nameEn = englishSkinNames?.get(skinId)

    // For the last tier (highest stage), check if there's a consecutive ID variant
    // that exists in the repo but not in CDragon (e.g., 103087 for Immortalized Legend Ahri)
    // Skip if champion has explicit REPO_ONLY_VARIANTS entries for this skin
    let chromaList: Chroma[] | undefined
    const hasExplicitVariants = REPO_ONLY_VARIANTS[championId]?.some((v) => v.parentSkinNum === skinNum)
    if (index === tiers.length - 1 && !hasExplicitVariants) {
      const nextId = tier.id + 1
      // Only add if the next ID doesn't belong to another skin in the tiers
      const nextIsInTiers = tiers.some((t) => t.id === nextId)
      if (!nextIsInTiers) {
        // Parent skin ID is the first tier's ID (e.g., 103085)
        const parentSkinId = tiers[0].id
        // URL structure: skins/{championId}/{parentSkinId}/{variantId}/{variantId}.png
        chromaList = [{
          id: nextId,
          name: `${tier.name} (Variant)`,
          chromaPath: `https://raw.githubusercontent.com/Alban1911/LeagueSkins/refs/heads/main/skins/${championId}/${parentSkinId}/${nextId}/${nextId}.png`,
          colors: ['#8B0000', '#FFD700']
        }]
      }
    }

    // Inject explicit REPO_ONLY_VARIANTS as chromas for this tiered skin
    if (hasExplicitVariants) {
      const parentSkinId = tiers[0].id // e.g., 145070
      const matchingVariants = REPO_ONLY_VARIANTS[championId]!.filter((v) => v.parentSkinNum === skinNum)
      const syntheticChromas: Chroma[] = matchingVariants.map((v) => ({
        id: v.id,
        name: v.name,
        chromaPath: `https://raw.githubusercontent.com/Alban1911/LeagueSkins/refs/heads/main/skins/${championId}/${parentSkinId}/${v.id}/${v.id}.png`,
        colors: v.colors
      }))
      chromaList = chromaList ? [...chromaList, ...syntheticChromas] : syntheticChromas
    }

    return {
      id: skinId,
      num: skinNum,
      name: tier.name,
      nameEn: nameEn && nameEn !== tier.name ? nameEn : undefined,
      chromas: !!chromaList,
      chromaList,
      rarity: skin.rarity || 'kNoRarity',
      rarityGemPath: getRarityGemPath(skin.rarity || 'kNoRarity'),
      isLegacy: skin.isLegacy || false,
      skinType: skin.skinType || '',
      skinLines: skin.skinLines,
      description: tier.description
    }
  })
}

function processRegularSkin(
  skin: CDragonSkin,
  championId: number,
  championName: string,
  englishSkinNames?: Map<string, string>
): Skin {
  const skinNum = Math.floor(skin.id / 1000) === championId ? skin.id % 1000 : 0
  const skinId = `${championId}_${skinNum}`
  const skinName = skin.isBase ? championName : skin.name
  const nameEn = englishSkinNames?.get(skinId)
  let chromaList = processChromas(skin)

  // Inject repo-only variants as synthetic chromas
  const repoVariants = REPO_ONLY_VARIANTS[championId]
  if (repoVariants) {
    const matchingVariants = repoVariants.filter((v) => v.parentSkinNum === skinNum)
    if (matchingVariants.length > 0) {
      const parentSkinId = skin.id // e.g., 222060
      const syntheticChromas: Chroma[] = matchingVariants.map((v) => ({
        id: v.id,
        name: v.name,
        chromaPath: `https://raw.githubusercontent.com/Alban1911/LeagueSkins/refs/heads/main/skins/${championId}/${parentSkinId}/${v.id}/${v.id}.png`,
        colors: v.colors
      }))
      chromaList = chromaList ? [...chromaList, ...syntheticChromas] : syntheticChromas
    }
  }

  return {
    id: skinId,
    num: skinNum,
    name: skinName,
    nameEn: nameEn && nameEn !== skinName ? nameEn : undefined,
    chromas: !!(chromaList && chromaList.length > 0),
    chromaList,
    rarity: skin.rarity || 'kNoRarity',
    rarityGemPath: getRarityGemPath(skin.rarity || 'kNoRarity'),
    isLegacy: skin.isLegacy || false,
    skinType: skin.skinType || '',
    skinLines: skin.skinLines,
    description: skin.description
  }
}

// --- Main fetcher ---

export async function fetchLatestVersion(): Promise<string> {
  const resp = await axios.get<string[]>(`${DDRAGON_BASE}/api/versions.json`)
  return resp.data[0]
}

export async function fetchChampionData(
  language: string,
  version?: string
): Promise<{ version: string; champions: Champion[] }> {
  if (!version) {
    version = await fetchLatestVersion()
  }

  // Fetch champion list from Ddragon
  const listUrl = `${DDRAGON_BASE}/cdn/${version}/data/${language}/champion.json`
  const listResp = await axios.get<{ data: Record<string, { key: string }> }>(listUrl)
  const championList = listResp.data.data

  // For non-English: also fetch English data to get English skin names
  let englishSkinNames: Map<string, string> | undefined
  let englishChampionNames: Map<number, string> | undefined

  if (language !== 'en_US') {
    try {
      const enResult = await fetchChampionDataInternal('en_US', version)
      englishSkinNames = new Map<string, string>()
      englishChampionNames = new Map<number, string>()
      for (const champ of enResult.champions) {
        englishChampionNames.set(champ.id, champ.name)
        for (const skin of champ.skins) {
          englishSkinNames.set(skin.id, skin.name)
        }
      }
    } catch (err) {
      console.error('Failed to fetch English data for name mapping:', err)
    }
  }

  const limit = pLimit(50)
  const locale = normalizeLocale(language)
  // Separate regular champions from "Jade_" (classic) champion entries
  // Jade_ are old-kit versions that share the same display name, causing UI duplicates if listed separately
  const championKeys = Object.keys(championList).filter((key) => !key.startsWith('Jade_'))
  const jadeChampionKeys = Object.keys(championList).filter((key) => key.startsWith('Jade_'))

  const results = await Promise.all(
    championKeys.map((key) =>
      limit(async () => {
        const championId = parseInt(championList[key].key)
        try {
          const detailUrl = `${CDRAGON_BASE}/${locale}/v1/champions/${championId}.json`
          let detailData: CDragonChampion
          try {
            const resp = await axios.get<CDragonChampion>(detailUrl)
            detailData = resp.data
          } catch (err: any) {
            if (locale !== 'default' && err?.response?.status === 404) {
              const fallbackUrl = `${CDRAGON_BASE}/default/v1/champions/${championId}.json`
              const resp = await axios.get<CDragonChampion>(fallbackUrl)
              detailData = resp.data
            } else {
              throw err
            }
          }

          const tags: string[] = []
          if (detailData.championTagInfo.championTagPrimary) {
            tags.push(detailData.championTagInfo.championTagPrimary)
          }
          if (detailData.championTagInfo.championTagSecondary) {
            tags.push(detailData.championTagInfo.championTagSecondary)
          }

          const skins: Skin[] = detailData.skins.flatMap((skin) => {
            if (skin.questSkinInfo?.productType === 'kTieredSkin' && skin.questSkinInfo.tiers) {
              return processTieredSkin(skin, championId, englishSkinNames)
            }
            return processRegularSkin(skin, championId, detailData.name, englishSkinNames)
          })

          const champion: Champion = {
            id: championId,
            key: detailData.alias,
            name: detailData.name,
            nameEn: englishChampionNames?.get(championId),
            title: detailData.title,
            image: `${DDRAGON_BASE}/cdn/${version}/img/champion/${detailData.alias}.png`,
            tags,
            skins
          }

          return champion
        } catch (error: any) {
          console.error(`Failed to fetch champion ${key} (${championId}):`, error.message)
          return null
        }
      })
    )
  )

  const champions = results.filter((c): c is Champion => c !== null)

  // Fetch Jade_ (classic) champion data and merge their classic skins into regular champions
  if (jadeChampionKeys.length > 0) {
    const jadeResults = await Promise.all(
      jadeChampionKeys.map((key) =>
        limit(async () => {
          const jadeChampionId = parseInt(championList[key].key)
          // Extract the real champion ID: Jade IDs are 60000 + realId (e.g., 60103 → 103)
          const realChampionId = jadeChampionId - 60000
          try {
            const detailUrl = `${CDRAGON_BASE}/${locale}/v1/champions/${jadeChampionId}.json`
            let detailData: CDragonChampion
            try {
              const resp = await axios.get<CDragonChampion>(detailUrl)
              detailData = resp.data
            } catch (err: any) {
              if (locale !== 'default' && err?.response?.status === 404) {
                const fallbackUrl = `${CDRAGON_BASE}/default/v1/champions/${jadeChampionId}.json`
                const resp = await axios.get<CDragonChampion>(fallbackUrl)
                detailData = resp.data
              } else {
                throw err
              }
            }

            // Extract classic skins: skins with skinNum >= 300 are dedicated classic skins
            // (skinNum 0 = base, 1-299 = regular skins on classic model, 300+ = dedicated classics)
            const classicSkins: Skin[] = []
            const jadeAlias = detailData.alias // e.g., "Jade_Fiddlesticks" for correct image URLs

            for (const skin of detailData.skins) {
              if (skin.isBase) continue
              const skinNum = Math.floor(skin.id / 1000) === jadeChampionId ? skin.id % 1000 : 0
              if (skinNum < 300) continue // Skip non-classic skins (these are just old-model versions of existing skins)

              const skinId = `${realChampionId}_classic_${skinNum}`
              const nameEn = englishSkinNames?.get(`${jadeChampionId}_${skinNum}`)

              // Process chromas for this classic skin
              let chromaList: Chroma[] | undefined
              if (skin.chromas && skin.chromas.length > 0) {
                chromaList = skin.chromas.map((c) => ({
                  id: c.id,
                  name: c.name,
                  chromaPath: c.chromaPath
                    ? `${CDRAGON_BASE}/default${c.chromaPath.replace('/lol-game-data/assets/', '/')}`
                    : '',
                  colors: c.colors || []
                }))
              }

              classicSkins.push({
                id: skinId,
                num: skinNum + 10000, // Offset to avoid collision with regular skin nums, and ensure num !== 0
                name: skin.name,
                nameEn: nameEn && nameEn !== skin.name ? nameEn : undefined,
                chromas: !!(chromaList && chromaList.length > 0),
                chromaList,
                rarity: 'kNoRarity',
                rarityGemPath: null,
                isLegacy: false,
                skinType: 'classic',
                classicJadeAlias: jadeAlias,
                description: skin.description
              })
            }

            return { realChampionId, classicSkins }
          } catch (error: any) {
            console.error(`Failed to fetch classic champion ${key} (${jadeChampionId}):`, error.message)
            return null
          }
        })
      )
    )

    // Merge classic skins into the corresponding regular champions
    for (const result of jadeResults) {
      if (!result || result.classicSkins.length === 0) continue
      const champion = champions.find((c) => c.id === result.realChampionId)
      if (champion) {
        champion.skins.push(...result.classicSkins)
      }
    }
  }

  champions.sort((a, b) => a.name.localeCompare(b.name))

  return { version, champions }
}

// Internal helper to fetch English data without recursion issue
async function fetchChampionDataInternal(
  language: string,
  version: string
): Promise<{ version: string; champions: Champion[] }> {
  const listUrl = `${DDRAGON_BASE}/cdn/${version}/data/${language}/champion.json`
  const listResp = await axios.get<{ data: Record<string, { key: string }> }>(listUrl)
  const championList = listResp.data.data

  const limit = pLimit(50)
  const locale = normalizeLocale(language)
  // Filter out "Jade_" (classic) champion entries to avoid duplicates
  const championKeys = Object.keys(championList).filter((key) => !key.startsWith('Jade_'))

  const results = await Promise.all(
    championKeys.map((key) =>
      limit(async () => {
        const championId = parseInt(championList[key].key)
        try {
          const detailUrl = `${CDRAGON_BASE}/${locale}/v1/champions/${championId}.json`
          const resp = await axios.get<CDragonChampion>(detailUrl)
          const detailData = resp.data

          const tags: string[] = []
          if (detailData.championTagInfo.championTagPrimary) {
            tags.push(detailData.championTagInfo.championTagPrimary)
          }
          if (detailData.championTagInfo.championTagSecondary) {
            tags.push(detailData.championTagInfo.championTagSecondary)
          }

          const skins: Skin[] = detailData.skins.flatMap((skin) => {
            if (skin.questSkinInfo?.productType === 'kTieredSkin' && skin.questSkinInfo.tiers) {
              return processTieredSkin(skin, championId)
            }
            return processRegularSkin(skin, championId, detailData.name)
          })

          return {
            id: championId,
            key: detailData.alias,
            name: detailData.name,
            title: detailData.title,
            image: `${DDRAGON_BASE}/cdn/${version}/img/champion/${detailData.alias}.png`,
            tags,
            skins
          } as Champion
        } catch (error: any) {
          console.error(`Failed to fetch champion ${key}:`, error.message)
          return null
        }
      })
    )
  )

  const champions = results.filter((c): c is Champion => c !== null)
  champions.sort((a, b) => a.name.localeCompare(b.name))

  return { version, champions }
}
