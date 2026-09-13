import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { decompress as zstdDecompress } from 'fzstd'
import { buildStoreZip } from '../utils/modPreview'

/**
 * Converts .modpkg archives (League Mod Toolkit binary container, used by
 * DivineSkins) into standard .fantome zips that the cslol import pipeline
 * accepts.
 *
 * modpkg layout (little-endian), per LeagueToolkit/league-mod ltk_modpkg:
 *   "_modpkg_" magic (8) | version u32 (1) | signatureSize u32 | chunkCount u32
 *   signature bytes
 *   layer table: u32 count, then per layer { u32 nameLen, name, i32 priority }
 *   chunk path table: u32 count, then nul-terminated strings
 *   wad table: u32 count, then nul-terminated strings
 *   align to 8
 *   chunkCount × 61-byte records:
 *     pathHash u64 | dataOffset u64 | compression u8 (0=none,1=zstd)
 *     compressedSize u64 | uncompressedSize u64
 *     compressedChecksum u64 | uncompressedChecksum u64
 *     pathIndex u32 | layerIndex u32 | wadIndex u32
 *
 * Chunk paths are paths inside the target WAD (xxh64 of the lowercased path is
 * the identity). The conversion writes them as loose files under
 * WAD/{WadName}.wad.client/ inside a fantome zip — cslol's mod import accepts
 * WAD folders like that and builds the real WADs itself.
 *
 * The mod's thumbnail (_meta_/thumbnail.*) is embedded as META/thumbnail.* so
 * it can serve as the preview image.
 */

const MAGIC = '_modpkg_'
const NO_LAYER_INDEX = 0xffffffff
const NO_WAD_INDEX = 0xffffffff

export interface ModpkgConvertResult {
  success: boolean
  fantomePath?: string
  modName?: string
  error?: string
}

function readNulTerminated(buf: Buffer, pos: number): { value: string; next: number } {
  let end = pos
  while (end < buf.length && buf[end] !== 0) end++
  return { value: buf.slice(pos, end).toString('utf8'), next: end + 1 }
}

class ModpkgService {
  private tempDir: string

  constructor() {
    this.tempDir = path.join(app.getPath('temp'), 'bocchi-url-imports')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true })
  }

  async convertToFantome(modpkgPath: string): Promise<ModpkgConvertResult> {
    try {
      const buf = await fs.readFile(modpkgPath)

      if (buf.slice(0, 8).toString('ascii') !== MAGIC) {
        return { success: false, error: 'Not a valid .modpkg file (bad magic)' }
      }
      const version = buf.readUInt32LE(8)
      if (version !== 1) {
        return { success: false, error: `Unsupported .modpkg format version: ${version}` }
      }
      const signatureSize = buf.readUInt32LE(12)
      const chunkCount = buf.readUInt32LE(16)

      let pos = 20 + signatureSize

      // Layer table
      const layerCount = buf.readUInt32LE(pos)
      pos += 4
      const layerPriorities: { name: string; priority: number }[] = []
      for (let i = 0; i < layerCount; i++) {
        const nameLen = buf.readUInt32LE(pos)
        pos += 4
        const name = buf.slice(pos, pos + nameLen).toString('utf8')
        pos += nameLen
        const priority = buf.readInt32LE(pos)
        pos += 4
        layerPriorities.push({ name, priority })
      }

      // Chunk path table (nul-terminated strings)
      const chunkPathCount = buf.readUInt32LE(pos)
      pos += 4
      const chunkPaths: string[] = []
      for (let i = 0; i < chunkPathCount; i++) {
        const { value, next } = readNulTerminated(buf, pos)
        chunkPaths.push(value)
        pos = next
      }

      // WAD name table (nul-terminated strings)
      const wadCount = buf.readUInt32LE(pos)
      pos += 4
      const wadNames: string[] = []
      for (let i = 0; i < wadCount; i++) {
        const { value, next } = readNulTerminated(buf, pos)
        wadNames.push(value)
        pos = next
      }

      // Align to 8
      pos = Math.ceil(pos / 8) * 8

      // Chunk records (61 bytes each)
      interface Resolved {
        wadName: string
        chunkPath: string
        priority: number
        data: Buffer
      }
      const resolved = new Map<string, Resolved>()
      const metaFiles = new Map<string, Buffer>()

      for (let i = 0; i < chunkCount; i++) {
        const rec = pos + i * 61
        const pathHash = buf.readBigUInt64LE(rec)
        const dataOffset = buf.readBigUInt64LE(rec + 8)
        const compression = buf.readUInt8(rec + 16)
        const compressedSize = buf.readBigUInt64LE(rec + 17)
        const pathIndex = buf.readUInt32LE(rec + 49)
        const layerIndex = buf.readUInt32LE(rec + 53)
        const wadIndex = buf.readUInt32LE(rec + 57)

        // Meta chunks (no layer/wad) are skipped, but keep the thumbnail so the
        // import can use it as the mod's preview image
        if (layerIndex === NO_LAYER_INDEX || wadIndex === NO_WAD_INDEX) {
          const metaPath = chunkPaths[pathIndex]
          if (metaPath && /^_meta_\/thumbnail\.(png|webp|jpe?g)$/i.test(metaPath)) {
            const start = Number(dataOffset)
            const size = Number(compressedSize)
            let thumbData: Buffer = buf.slice(start, start + size)
            if (compression === 1) {
              try {
                thumbData = Buffer.from(zstdDecompress(new Uint8Array(thumbData)))
              } catch {
                continue
              }
            }
            const ext = path.extname(metaPath).toLowerCase()
            metaFiles.set(`META/thumbnail${ext}`, thumbData)
          }
          continue
        }
        const chunkPath = chunkPaths[pathIndex]
        if (!chunkPath || chunkPath.startsWith('_meta_/')) continue
        const wadName = wadNames[wadIndex]
        if (!wadName) continue

        const start = Number(dataOffset)
        const size = Number(compressedSize)
        let data: Buffer = buf.slice(start, start + size)
        if (compression === 1) {
          try {
            data = Buffer.from(zstdDecompress(new Uint8Array(data)))
          } catch (err) {
            return {
              success: false,
              error: `Failed to decompress chunk ${chunkPath}: ${err instanceof Error ? err.message : 'zstd error'}`
            }
          }
        }

        const priority = layerIndex < layerPriorities.length ? layerPriorities[layerIndex].priority : 0
        const key = `${wadName}|${pathHash}`
        const existing = resolved.get(key)
        // Layer priority decides which chunk wins; higher priority overwrites
        if (!existing || priority > existing.priority) {
          resolved.set(key, { wadName, chunkPath, priority, data })
        }
      }

      if (resolved.size === 0) {
        return { success: false, error: 'This .modpkg contains no importable WAD chunks' }
      }

      const modName = path
        .basename(modpkgPath, path.extname(modpkgPath))
        .replace(/[^a-zA-Z0-9_-]/g, '_')

      // Write the fantome zip: META/info.json + WAD/{wad}/{chunk paths} + thumbnail
      const fantomePath = path.join(this.tempDir, `${Date.now()}-${modName}.fantome`)
      const zipEntries: { name: string; data: Buffer }[] = [
        {
          name: 'META/info.json',
          data: Buffer.from(
            JSON.stringify({
              Name: modName,
              Author: 'Unknown',
              Version: '1.0.0',
              Description: 'Imported from .modpkg'
            })
          )
        }
      ]
      for (const file of resolved.values()) {
        const normalized = file.chunkPath.replace(/\\/g, '/').replace(/^\/+/, '')
        zipEntries.push({
          name: `WAD/${file.wadName}/${normalized}`,
          data: file.data
        })
      }
      for (const [name, data] of metaFiles) {
        zipEntries.push({ name, data })
      }
      await fs.mkdir(this.tempDir, { recursive: true })
      await fs.writeFile(fantomePath, buildStoreZip(zipEntries))

      console.log(
        `[ModPkg] Converted ${path.basename(modpkgPath)}: ${resolved.size} chunks -> ${path.basename(fantomePath)}`
      )
      return { success: true, fantomePath, modName }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to convert .modpkg'
      }
    }
  }
}

export const modpkgService = new ModpkgService()
