/**
 * SkinLite Service — make a custom skin show up over ANY equipped skin.
 *
 * Skin packages built for the "rebase to skin0" workflow (Sunshine / LeagueSkins, and most
 * cslol-style mods) override the champion's *base* skin files:
 *
 *   data/characters/<champ>/skins/skin0.bin
 *   data/characters/<champ>/animations/skin0.bin
 *   data/characters/<champ>helper/skins/skin0.bin   (traps, pets, clones, ...)
 *
 * The game only reads skin0.bin when the base skin is equipped. If the player has an owned
 * skin equipped (skin5, skin12, ...) the game loads skinN.bin instead and the mod never shows.
 *
 * SkinLite fixes that without touching any game file: for every other skin index N it adds a
 * copy of each skin0 bin that has been re-identified as skinN (object path hashes and the
 * linked animation bin are renamed). The model, textures and sounds are unchanged, so the
 * variant is only a few KB per skin index larger than the original.
 *
 * The transform needs no game files and no per-skin data, which makes it safe to run
 * automatically on every package (repository downloads and user imports) at apply time.
 */
import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import * as zlib from 'zlib'
import * as fzstd from 'fzstd'
import { compress } from 'zstd-napi'
import * as StreamZip from 'node-stream-zip'
import { xxhash64, ensureXXHashReady } from './xxhash'
import { championDataService } from './championDataService'
import {
  parseWad,
  WAD_COMPRESSION,
  writeStoreZip,
  type WadEntry,
  type ZipInputEntry
} from './modRepairService'

export interface SkinLiteOptions {
  /** Skin indexes to cover (e.g. every skin + chroma index of the champion). */
  skinNums?: number[]
  /** Champion key, used as an extra hint for locating the skin0 bins. */
  championKey?: string
  /** Directory where generated variants are cached. */
  cacheDir: string
}

export interface SkinLiteReport {
  /** The package contains skin0 bins that SkinLite can re-identify. */
  applicable: boolean
  /** Why the package was left alone (when applicable is false). */
  reason?: string
  /** Number of bins added (0 when the variant came from the cache). */
  generated: number
  /** The variant already existed in the cache. */
  cached?: boolean
  /** Skin index the package was rebased from (e.g. 28 for Arcane Enforcer Caitlyn). */
  sourceSkinNum?: number
  /** Path to use instead of the original package. Equals the input path when not applicable. */
  outputPath: string
}

type Compressor = (data: Buffer) => Buffer

/** zstd is the codec the game's own WAD entries use; it keeps the ~100 near-identical copies small. */
const zstdCompress: Compressor = (data) => Buffer.from(compress(data, { compressionLevel: 12 }))

/** Fallback when the caller has no skin list: covers every index any champion currently has. */
const DEFAULT_SKIN_RANGE = Array.from({ length: 99 }, (_, i) => i + 1)

const BIN_DEP_RE = /^data\/characters\/([^/]+)\/(skins|animations)\/skin(\d+)\.bin$/i

// ── hashing ──────────────────────────────────────────────────────────────────

/** FNV-1a 32 of a lowercased string — how bin object paths are hashed. */
function fnv1a32(input: string): number {
  const s = input.toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function wadHash(pathText: string): bigint {
  return BigInt('0x' + xxhash64(pathText))
}

// ── PROP bin helpers ─────────────────────────────────────────────────────────

interface BinHeader {
  version: number
  dependencies: string[]
  /** Offset of the first byte after the dependency block. */
  bodyStart: number
}

/** Read only the header of a PROP bin (version + linked bins). Returns null if not a PROP bin. */
function readBinHeader(buf: Buffer): BinHeader | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PROP') return null
  const version = buf.readUInt32LE(4)
  if (version < 1 || version > 3) return null
  let pos = 8
  const dependencies: string[] = []
  if (version >= 2) {
    const count = buf.readUInt32LE(pos)
    pos += 4
    for (let i = 0; i < count; i++) {
      const len = buf.readUInt16LE(pos)
      pos += 2
      dependencies.push(buf.toString('latin1', pos, pos + len))
      pos += len
    }
  }
  return { version, dependencies, bodyStart: pos }
}

/**
 * Re-identify a skin0 bin as skinN.
 *
 * Replaces the 32-bit path hashes of `characters/<char>/{skins,animations}/skin0[/resources]`
 * (object ids and the references to them) and renames linked `…/skin0.bin` dependencies.
 * Everything else — including links to the real skin bins (e.g. skin28.bin) — is untouched.
 */
function retargetBin(buf: Buffer, header: BinHeader, chars: string[], n: number): Buffer {
  const body = Buffer.from(buf.subarray(header.bodyStart))

  for (const c of chars) {
    for (const kind of ['skins', 'animations']) {
      for (const suffix of ['', '/resources']) {
        const from = fnv1a32(`characters/${c}/${kind}/skin0${suffix}`)
        const to = fnv1a32(`characters/${c}/${kind}/skin${n}${suffix}`)
        for (let i = 0; i + 4 <= body.length; i++) {
          if (body.readUInt32LE(i) === from) {
            body.writeUInt32LE(to, i)
            i += 3
          }
        }
      }
    }
  }

  const parts: Buffer[] = [buf.subarray(0, 8)]
  if (header.version >= 2) {
    const count = Buffer.alloc(4)
    count.writeUInt32LE(header.dependencies.length)
    parts.push(count)
    for (const dep of header.dependencies) {
      const renamed = dep.replace(/\/skin0\.bin$/i, `/skin${n}.bin`)
      const len = Buffer.alloc(2)
      len.writeUInt16LE(renamed.length)
      parts.push(len, Buffer.from(renamed, 'latin1'))
    }
  }
  parts.push(body)
  return Buffer.concat(parts)
}

// ── WAD handling ─────────────────────────────────────────────────────────────

function readChunk(wad: Buffer, entry: WadEntry): Buffer | null {
  const compression = entry.typeByte & 0x0f
  const raw = wad.subarray(entry.offset, entry.offset + entry.compressedSize)
  try {
    if (compression === WAD_COMPRESSION.RAW) return raw
    if (compression === WAD_COMPRESSION.GZIP) return zlib.gunzipSync(raw)
    if (compression === WAD_COMPRESSION.ZSTD || compression === WAD_COMPRESSION.ZSTD_CHUNKED) {
      return Buffer.from(fzstd.decompress(new Uint8Array(raw)))
    }
  } catch {
    // unreadable chunk — not a bin we can use
  }
  return null
}

/** Write a v3 WAD that keeps every original entry byte-for-byte and adds new RAW entries. */
function buildWadWithAdditions(
  original: Buffer,
  entries: WadEntry[],
  added: Map<bigint, Buffer>,
  compress: Compressor
): Buffer {
  const headerSize = 4 + 256 + 8 + 4
  type Out = { hash: bigint; data: Buffer; entry: WadEntry }
  const all: Out[] = entries.map((e) => ({
    hash: e.hash,
    data: original.subarray(e.offset, e.offset + e.compressedSize),
    entry: e
  }))
  for (const [hash, plain] of added) {
    const data = compress(plain)
    all.push({
      hash,
      data,
      entry: {
        hash,
        offset: 0,
        compressedSize: data.length,
        decompressedSize: plain.length,
        typeByte: WAD_COMPRESSION.ZSTD,
        tail: Buffer.alloc(11) // zero checksum: readers compute it lazily
      }
    })
  }
  all.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))

  const dataStart = headerSize + all.length * 32
  const total = all.reduce((sum, o) => sum + o.data.length, dataStart)
  const out = Buffer.alloc(total)
  original.copy(out, 0, 0, headerSize - 4)
  out.writeUInt32LE(all.length, headerSize - 4)

  let offset = dataStart
  all.forEach((o, i) => {
    const p = headerSize + i * 32
    out.writeBigUInt64LE(o.hash, p)
    out.writeUInt32LE(offset, p + 8)
    out.writeUInt32LE(o.entry.compressedSize, p + 12)
    out.writeUInt32LE(o.entry.decompressedSize, p + 16)
    out.writeUInt8(o.entry.typeByte, p + 20)
    o.entry.tail.copy(out, p + 21)
    o.data.copy(out, offset)
    offset += o.data.length
  })
  return out
}

interface WadResult {
  wad: Buffer | null
  generated: number
  sourceSkinNum?: number
  reason?: string
}

interface Template {
  char: string
  kind: 'skins' | 'animations'
  buf: Buffer
  header: BinHeader
}

interface WadScan {
  info: NonNullable<ReturnType<typeof parseWad>>
  byHash: Map<bigint, number>
  chars: Set<string>
  templates: Template[]
  /** Skin the package was rebased from (e.g. 28), if its skin0 bin links to one. */
  sourceSkinNum?: number
}

/** Find the skin0 bins SkinLite can re-identify inside a WAD (no output is produced). */
function scanWad(data: Buffer, hintChamps: string[]): WadScan | { reason: string } {
  const info = parseWad(data)
  if (!info) return { reason: 'not a v3 WAD' }

  const byHash = new Map<bigint, number>()
  info.entries.forEach((e, i) => byHash.set(e.hash, i))

  // 1. Find the character folders the package talks about. Every skin bin links its
  //    animation bin by plaintext path, so the dependency lists name all of them
  //    (including helper characters such as "caitlyntrap").
  const chars = new Set<string>(hintChamps.map((c) => c.toLowerCase()))
  const binCache = new Map<number, { buf: Buffer; header: BinHeader }>()
  info.entries.forEach((entry, index) => {
    // bins are small; skip big chunks (models, textures, audio) without decompressing them
    if (entry.decompressedSize > 512 * 1024) return
    const chunk = readChunk(data, entry)
    if (!chunk) return
    const header = readBinHeader(chunk)
    if (!header) return
    binCache.set(index, { buf: chunk, header })
    for (const dep of header.dependencies) {
      const m = BIN_DEP_RE.exec(dep)
      if (m) chars.add(m[1].toLowerCase())
    }
  })

  // 2. Locate the skin0 templates inside the WAD.
  const templates: Template[] = []
  for (const char of chars) {
    for (const kind of ['skins', 'animations'] as const) {
      const idx = byHash.get(wadHash(`data/characters/${char}/${kind}/skin0.bin`))
      const cached = idx === undefined ? undefined : binCache.get(idx)
      if (cached) templates.push({ char, kind, ...cached })
    }
  }
  if (templates.length === 0) return { reason: 'no skin0 bins in package' }

  // 3. The skin the package was rebased from must not be overridden: its real bin is the
  //    dependency of our skin0 bin, and replacing it would make it link to itself.
  //    Standalone packages (a full copy of the skin inside skin0.bin) have no skins/skinN.bin
  //    link, so fall back to the animation bin they point at (animations/skinN.bin).
  let sourceSkinNum: number | undefined
  let animationHint: number | undefined
  for (const t of templates) {
    for (const dep of t.header.dependencies) {
      const m = BIN_DEP_RE.exec(dep)
      if (!m || m[1].toLowerCase() !== t.char || +m[3] === 0) continue
      if (m[2].toLowerCase() === 'skins') sourceSkinNum = +m[3]
      else animationHint = +m[3]
    }
  }
  sourceSkinNum ??= animationHint
  return { info, byHash, chars, templates, sourceSkinNum }
}

function skinLiteWad(
  data: Buffer,
  skinNums: number[],
  hintChamps: string[],
  compress: Compressor
): WadResult {
  const scan = scanWad(data, hintChamps)
  if ('reason' in scan) return { wad: null, generated: 0, reason: scan.reason }
  const { info, byHash, chars, templates, sourceSkinNum } = scan

  // 4. Add a re-identified copy of every template for every other skin index.
  const allChars = [...chars]
  const added = new Map<bigint, Buffer>()
  for (const n of skinNums) {
    if (n === 0 || n === sourceSkinNum) continue
    for (const t of templates) {
      const hash = wadHash(`data/characters/${t.char}/${t.kind}/skin${n}.bin`)
      if (byHash.has(hash)) continue // package already ships its own skinN bin
      added.set(hash, retargetBin(t.buf, t.header, allChars, n))
    }
  }
  if (added.size === 0) return { wad: null, generated: 0, reason: 'nothing to add', sourceSkinNum }

  return {
    wad: buildWadWithAdditions(data, info.entries, added, compress),
    generated: added.size,
    sourceSkinNum
  }
}

// ── public API ───────────────────────────────────────────────────────────────

function cacheKey(
  srcPath: string,
  stat: { size: number; mtimeMs: number },
  nums: number[]
): string {
  return crypto
    .createHash('sha1')
    .update(`${path.resolve(srcPath)}|${stat.size}|${Math.floor(stat.mtimeMs)}|${nums.join(',')}`)
    .digest('hex')
    .slice(0, 10)
}

/**
 * Create (or reuse) a SkinLite variant of a skin package.
 *
 * Accepts .fantome / .zip packages and raw .wad.client / .wad files. The original file is
 * never modified; the variant is written to `cacheDir` under a name that embeds a content key,
 * so a changed source package or skin list automatically gets a fresh import in cslol-tools.
 */
export async function createSkinLiteVariant(
  srcPath: string,
  options: SkinLiteOptions
): Promise<SkinLiteReport> {
  const notApplicable = (reason: string): SkinLiteReport => ({
    applicable: false,
    reason,
    generated: 0,
    outputPath: srcPath
  })

  try {
    await ensureXXHashReady()
    const compress: Compressor = zstdCompress
    const lower = srcPath.toLowerCase()
    const isWad = lower.endsWith('.wad.client') || lower.endsWith('.wad')
    const isZip = lower.endsWith('.fantome') || lower.endsWith('.zip')
    if (!isWad && !isZip) return notApplicable('unsupported file type')

    const skinNums = [...new Set(options.skinNums?.length ? options.skinNums : DEFAULT_SKIN_RANGE)]
      .filter((n) => Number.isInteger(n) && n > 0 && n < 1000)
      .sort((a, b) => a - b)
    const hints = options.championKey ? [options.championKey] : []

    const stat = await fs.stat(srcPath)
    const key = cacheKey(srcPath, stat, skinNums)
    const base = path.basename(srcPath).replace(/\.(wad\.client|wad|fantome|zip)$/i, '')
    const ext = path.extname(srcPath)
    const outName = isWad
      ? `${base}.sl-${key}${lower.endsWith('.wad.client') ? '.wad.client' : '.wad'}`
      : `${base}.sl-${key}${ext}`
    const outputPath = path.join(options.cacheDir, outName)

    // Reuse a previous run (an empty marker records "not applicable" results)
    try {
      await fs.access(outputPath)
      return { applicable: true, generated: 0, cached: true, outputPath }
    } catch {
      /* not cached yet */
    }
    try {
      await fs.access(outputPath + '.na')
      return notApplicable('no skin0 bins in package (cached)')
    } catch {
      /* not cached yet */
    }

    await fs.mkdir(options.cacheDir, { recursive: true })
    let report: SkinLiteReport

    if (isWad) {
      const res = skinLiteWad(await fs.readFile(srcPath), skinNums, hints, compress)
      if (!res.wad) {
        await fs.writeFile(outputPath + '.na', res.reason ?? '')
        return notApplicable(res.reason ?? 'not applicable')
      }
      await fs.writeFile(outputPath + '.tmp', res.wad)
      await fs.rename(outputPath + '.tmp', outputPath)
      report = {
        applicable: true,
        generated: res.generated,
        sourceSkinNum: res.sourceSkinNum,
        outputPath
      }
    } else {
      const zip = new StreamZip.async({ file: srcPath })
      const inputs: ZipInputEntry[] = []
      let generated = 0
      let sourceSkinNum: number | undefined
      try {
        for (const entry of Object.values(await zip.entries())) {
          if (entry.isDirectory) continue
          const name = entry.name.replace(/\\/g, '/')
          // cslol-tools' fantome importer rejects anything under META/hashes
          if (name.toUpperCase().startsWith('META/HASHES/')) continue
          let data: Buffer = Buffer.from(await zip.entryData(entry))
          if (name.toUpperCase().startsWith('WAD/') && /\.WAD(\.CLIENT)?$/i.test(name)) {
            const res = skinLiteWad(data, skinNums, hints, compress)
            if (res.wad) {
              data = res.wad
              generated += res.generated
              sourceSkinNum = res.sourceSkinNum ?? sourceSkinNum
            }
          }
          inputs.push({ name, data })
        }
      } finally {
        await zip.close()
      }
      if (generated === 0) {
        await fs.writeFile(outputPath + '.na', 'no skin0 bins in package')
        return notApplicable('no skin0 bins in package')
      }
      await fs.writeFile(outputPath + '.tmp', writeStoreZip(inputs))
      await fs.rename(outputPath + '.tmp', outputPath)
      report = { applicable: true, generated, sourceSkinNum, outputPath }
    }

    console.log(
      `[SkinLite] ${path.basename(srcPath)}: +${report.generated} bins` +
        (report.sourceSkinNum !== undefined ? ` (rebased from skin${report.sourceSkinNum})` : '')
    )
    return report
  } catch (err) {
    console.warn(`[SkinLite] Failed for ${srcPath}:`, err)
    return notApplicable('error: ' + (err instanceof Error ? err.message : String(err)))
  }
}

/**
 * Every skin and chroma index a champion has, from the champion data Bocchi already caches.
 * Chroma ids are `championId * 1000 + skinIndex`, so the index is `id % 1000`.
 * Returns undefined for unknown champions (e.g. "Custom"), which makes SkinLite use its
 * default range.
 */
export async function getSkinNumsForChampion(championKey: string): Promise<number[] | undefined> {
  try {
    const champion = await championDataService.getChampionByKey(championKey)
    if (!champion) return undefined
    const nums = new Set<number>()
    for (const skin of champion.skins) {
      nums.add(skin.num)
      for (const chroma of skin.chromaList ?? []) nums.add(chroma.id % 1000)
    }
    nums.delete(0)
    return nums.size > 0 ? [...nums] : undefined
  } catch {
    return undefined
  }
}

/**
 * Build SkinLite variants for a batch of resolved skin files (used right before applying).
 * Returns originalPath -> variantPath for every package SkinLite could handle; callers fall
 * back to the original path for everything else. Items with `enabled: false` are skipped.
 */
export async function resolveSkinLitePaths(
  items: Array<{ localPath?: string | null; championKey?: string; enabled?: boolean }>
): Promise<Map<string, string>> {
  const cacheDir = path.join(app.getPath('userData'), 'skinlite-cache')
  const out = new Map<string, string>()
  await Promise.all(
    items.map(async ({ localPath, championKey, enabled = true }) => {
      if (!localPath || !enabled) return
      const known = !!championKey && championKey !== 'Custom'
      const report = await createSkinLiteVariant(localPath, {
        championKey: known ? championKey : undefined,
        skinNums: known ? await getSkinNumsForChampion(championKey!) : undefined,
        cacheDir
      })
      if (report.applicable) out.set(localPath, report.outputPath)
    })
  )
  return out
}

/**
 * Cheap check used by the UI: can SkinLite do anything with this package?
 * False for mods that are not rebased skins (no skin0 bins), e.g. texture or sound mods.
 */
export async function inspectSkinLite(
  srcPath: string,
  championKey?: string
): Promise<{ applicable: boolean; reason?: string; sourceSkinNum?: number }> {
  try {
    await ensureXXHashReady()
    const lower = srcPath.toLowerCase()
    const hints = championKey && championKey !== 'Custom' ? [championKey] : []
    const wads: Buffer[] = []
    if (lower.endsWith('.wad.client') || lower.endsWith('.wad')) {
      wads.push(await fs.readFile(srcPath))
    } else if (lower.endsWith('.fantome') || lower.endsWith('.zip')) {
      const zip = new StreamZip.async({ file: srcPath })
      try {
        for (const entry of Object.values(await zip.entries())) {
          const name = entry.name.replaceAll('\\', '/').toUpperCase()
          if (!entry.isDirectory && name.startsWith('WAD/') && /\.WAD(\.CLIENT)?$/.test(name)) {
            wads.push(Buffer.from(await zip.entryData(entry)))
          }
        }
      } finally {
        await zip.close()
      }
    } else {
      return { applicable: false, reason: 'unsupported file type' }
    }
    for (const wad of wads) {
      const scan = scanWad(wad, hints)
      if (!('reason' in scan)) return { applicable: true, sourceSkinNum: scan.sourceSkinNum }
    }
    return { applicable: false, reason: 'no skin0 bins in package' }
  } catch (err) {
    return { applicable: false, reason: 'error: ' + (err instanceof Error ? err.message : String(err)) }
  }
}
