/**
 * Native WAD Overlay Builder
 *
 * Replaces mod-tools.exe mkoverlay with a pure TypeScript implementation.
 * Reads imported mod WAD files from cslol_installed/ and writes a merged
 * WAD v3.4 overlay file directly.
 *
 * Port of cslol-go's mkoverlay.cs logic.
 *
 * WAD v3.4 format:
 *   Header: 'R' 'W' 3 4 [16 bytes checksum] [248 bytes padding] [4 bytes entry count]
 *   TOC: N * 32 bytes (hash:8 + offset:4 + compSize:4 + uncompSize:4 + metadata:4 + checksum:8)
 *   Data: raw file data blobs
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { XXHash64 } from 'xxhash-addon'
import { compress } from 'zstd-napi'

// Extensions that should not be compressed
const RAW_EXTENSIONS = new Set(['.webm'])

const SEED_ZERO = Buffer.alloc(8, 0)
const SEED_ONE = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])

interface WadEntry {
  hash: Buffer            // 8 bytes - XXHash64 of the path
  size: number           // compressed size
  uncompressedSize: number
  metadata: Buffer       // 4 bytes: [flags, subchunk0, subchunk1, subchunk2]
  dataChecksum: Buffer   // 8 bytes - XXHash64 of the data
  sourcePath?: string    // path to source WAD file (for in-WAD entries)
  originalOffset?: number // offset in source WAD
  data?: Buffer          // pre-compressed data (for loose files)
  isInWad: boolean
}

/**
 * Hash a file path the same way League does: lowercase, forward slashes, XXHash64 seed 0.
 */
function hashPath(filePath: string): Buffer {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const buf = Buffer.from(normalized, 'utf-8')
  const hasher = new XXHash64(SEED_ZERO)
  hasher.update(buf)
  return hasher.digest()
}

/**
 * Compute XXHash64 of a buffer (for data checksums).
 */
function hashData(data: Buffer): Buffer {
  const hasher = new XXHash64(SEED_ZERO)
  hasher.update(data)
  return hasher.digest()
}

/**
 * Compare two 8-byte hash buffers for sorting (LE comparison).
 */
function compareHash(a: Buffer, b: Buffer): number {
  for (let i = 7; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * Convert hash buffer to a string key for Map usage.
 */
function hashKey(h: Buffer): string {
  return h.toString('hex')
}

/**
 * Read WAD metadata (TOC entries) from a .wad.client file without loading data.
 */
function readWadMetadata(wadPath: string, entries: Map<string, WadEntry>): void {
  const fd = fs.openSync(wadPath, 'r')
  try {
    const countBuf = Buffer.alloc(4)
    fs.readSync(fd, countBuf, 0, 4, 268) // offset 268 = entry count
    const count = countBuf.readUInt32LE(0)

    const tocBuf = Buffer.alloc(count * 32)
    fs.readSync(fd, tocBuf, 0, count * 32, 272)

    for (let i = 0; i < count; i++) {
      const off = i * 32
      const hashBuf = Buffer.alloc(8)
      tocBuf.copy(hashBuf, 0, off, off + 8)
      const checksumBuf = Buffer.alloc(8)
      tocBuf.copy(checksumBuf, 0, off + 24, off + 32)

      const entry: WadEntry = {
        hash: hashBuf,
        originalOffset: tocBuf.readUInt32LE(off + 8),
        size: tocBuf.readUInt32LE(off + 12),
        uncompressedSize: tocBuf.readUInt32LE(off + 16),
        metadata: Buffer.from(tocBuf.subarray(off + 20, off + 24)),
        dataChecksum: checksumBuf,
        sourcePath: wadPath,
        isInWad: true
      }
      entries.set(hashKey(entry.hash), entry)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read loose files from a folder, compress them, and add to entries.
 */
async function readAndCompressFolder(
  rootFolder: string,
  entries: Map<string, WadEntry>
): Promise<void> {
  const files = await getAllFiles(rootFolder)

  for (const file of files) {
    const relPath = path.relative(rootFolder, file).replace(/\\/g, '/').toLowerCase()
    const raw = await fsp.readFile(file)

    // Hash the path
    let pathHashBuf: Buffer
    if (!relPath.includes('/')) {
      // Try parsing filename as hex hash
      const hexName = path.basename(file, path.extname(file))
      if (/^[0-9a-fA-F]{8,16}$/.test(hexName)) {
        pathHashBuf = Buffer.alloc(8)
        const bigVal = BigInt('0x' + hexName)
        pathHashBuf.writeBigUInt64LE(bigVal)
      } else {
        pathHashBuf = hashPath(relPath)
      }
    } else {
      pathHashBuf = hashPath(relPath)
    }

    const ext = path.extname(file).toLowerCase()
    const shouldStayRaw = RAW_EXTENSIONS.has(ext) || raw.length < 128

    let compressed: Buffer
    let type: number
    if (shouldStayRaw) {
      compressed = raw
      type = 0 // uncompressed
    } else {
      compressed = compress(raw, { compressionLevel: 3 }) // Zstd level 3 (sync)
      type = 3 // Zstd compressed
    }

    entries.set(hashKey(pathHashBuf), {
      hash: pathHashBuf,
      data: compressed,
      size: compressed.length,
      uncompressedSize: raw.length,
      metadata: Buffer.from([type, 0, 0, 0]),
      dataChecksum: hashData(compressed),
      isInWad: false
    })
  }
}

/**
 * Recursively get all files in a directory.
 */
async function getAllFiles(dir: string): Promise<string[]> {
  const result: string[] = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await getAllFiles(fullPath)))
    } else {
      result.push(fullPath)
    }
  }
  return result
}

/**
 * Calculate TOC checksum (XXHash128 of header magic + all entry hashes and checksums).
 * Since xxhash-addon may not have XXHash128, we use XXHash64 as a fallback
 * and pad to 16 bytes (this matches how the game validates it).
 */
function calculateTocChecksum(entries: WadEntry[]): Buffer {
  const hasher1 = new XXHash64(SEED_ZERO)
  const hasher2 = new XXHash64(SEED_ONE)

  const magic = Buffer.from([0x52, 0x57, 3, 4]) // 'R' 'W' 3 4
  hasher1.update(magic)
  hasher2.update(magic)

  const entryBuf = Buffer.alloc(16)
  for (const e of entries) {
    e.hash.copy(entryBuf, 0, 0, 8)
    e.dataChecksum.copy(entryBuf, 8, 0, 8)
    hasher1.update(entryBuf)
    hasher2.update(entryBuf)
  }

  const h1 = hasher1.digest()
  const h2 = hasher2.digest()
  const checksum = Buffer.alloc(16)
  h2.copy(checksum, 0, 0, 8) // reversed order like C# Array.Reverse
  h1.copy(checksum, 8, 0, 8)
  return checksum
}

/**
 * Write the merged WAD v3.4 file.
 */
function writeWad(entries: WadEntry[], checksum: Buffer, outputPath: string): void {
  const dir = path.dirname(outputPath)
  fs.mkdirSync(dir, { recursive: true })

  const fd = fs.openSync(outputPath, 'w')
  try {
    // Header: 'RW' + version 3.4 + 16 byte checksum + 248 byte padding + entry count
    const header = Buffer.alloc(272)
    header[0] = 0x52 // 'R'
    header[1] = 0x57 // 'W'
    header[2] = 3    // major
    header[3] = 4    // minor
    checksum.copy(header, 4, 0, 16)
    // bytes 20-267 are zero padding (already zero from alloc)
    header.writeUInt32LE(entries.length, 268)
    fs.writeSync(fd, header)

    // Calculate data start offset
    let currentOffset = 272 + entries.length * 32
    const writtenOffsets = new Map<string, number>() // keyed by checksum hex

    // Write TOC
    const tocEntry = Buffer.alloc(32)
    for (const e of entries) {
      const csKey = hashKey(e.dataChecksum)
      let offset: number
      if (writtenOffsets.has(csKey)) {
        offset = writtenOffsets.get(csKey)!
      } else {
        offset = currentOffset
        writtenOffsets.set(csKey, currentOffset)
        currentOffset += e.size
      }

      e.hash.copy(tocEntry, 0, 0, 8)
      tocEntry.writeUInt32LE(offset, 8)
      tocEntry.writeUInt32LE(e.size, 12)
      tocEntry.writeUInt32LE(e.uncompressedSize, 16)
      e.metadata.copy(tocEntry, 20, 0, 4)
      e.dataChecksum.copy(tocEntry, 24, 0, 8)
      fs.writeSync(fd, tocEntry)
    }

    // Write data blobs
    const writtenChecksums = new Set<string>()
    const openFds = new Map<string, number>()
    const copyBuf = Buffer.alloc(81920)

    try {
      for (const e of entries) {
        const csKey = hashKey(e.dataChecksum)
        if (writtenChecksums.has(csKey)) continue
        writtenChecksums.add(csKey)

        if (!e.isInWad && e.data) {
          // Loose file: write pre-compressed data
          fs.writeSync(fd, e.data)
        } else if (e.isInWad && e.sourcePath && e.originalOffset !== undefined) {
          // In-WAD entry: copy from source
          let srcFd: number
          if (openFds.has(e.sourcePath)) {
            srcFd = openFds.get(e.sourcePath)!
          } else {
            srcFd = fs.openSync(e.sourcePath, 'r')
            openFds.set(e.sourcePath, srcFd)
          }

          let remaining = e.size
          let readOffset = e.originalOffset
          while (remaining > 0) {
            const toRead = Math.min(copyBuf.length, remaining)
            const bytesRead = fs.readSync(srcFd, copyBuf, 0, toRead, readOffset)
            fs.writeSync(fd, copyBuf, 0, bytesRead)
            remaining -= bytesRead
            readOffset += bytesRead
          }
        }
      }
    } finally {
      for (const srcFd of openFds.values()) {
        fs.closeSync(srcFd)
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Build a WAD overlay from installed mods.
 *
 * @param installedDir - Path to cslol_installed/ directory
 * @param outputDir - Path to write the overlay (e.g., profiles/preset_xxx/)
 * @param modNames - Array of mod folder names (e.g., ['mod_0_SkinA', 'mod_1_SkinB'])
 * @returns The overlay directory path and config path
 */
export async function buildNativeOverlay(
  installedDir: string,
  outputDir: string,
  modNames: string[]
): Promise<{ overlayPath: string; configPath: string }> {
  console.log(`[NativeOverlay] Building overlay with ${modNames.length} mods`)
  const startTime = Date.now()

  // Group entries by source WAD filename (e.g., "Ezreal.wad.client")
  // Each champion gets its own WAD in the overlay
  const wadGroups = new Map<string, Map<string, WadEntry>>()

  for (const mod of modNames) {
    const wadFolder = path.join(installedDir, mod, 'WAD')
    if (!fs.existsSync(wadFolder)) {
      console.warn(`[NativeOverlay] WAD folder not found: ${wadFolder}`)
      continue
    }

    const wadEntries = await fsp.readdir(wadFolder, { withFileTypes: true })
    for (const entry of wadEntries) {
      const fullPath = path.join(wadFolder, entry.name)

      if (entry.isDirectory() && entry.name.endsWith('.wad.client')) {
        // Loose files folder named like "Ezreal.wad.client/"
        const wadName = entry.name
        if (!wadGroups.has(wadName)) wadGroups.set(wadName, new Map())
        await readAndCompressFolder(fullPath, wadGroups.get(wadName)!)
      } else if (!entry.isDirectory() && entry.name.endsWith('.wad.client')) {
        // Pre-built WAD file (e.g., "Ezreal.wad.client")
        const wadName = entry.name
        if (!wadGroups.has(wadName)) wadGroups.set(wadName, new Map())
        readWadMetadata(fullPath, wadGroups.get(wadName)!)
      }
    }
  }

  if (wadGroups.size === 0) {
    throw new Error('No WAD entries found in any mods')
  }

  let totalEntries = 0

  // Write one overlay WAD per champion
  for (const [wadName, entries] of wadGroups) {
    if (entries.size === 0) continue

    const sortedEntries = Array.from(entries.values()).sort((a, b) => compareHash(a.hash, b.hash))
    const checksum = calculateTocChecksum(sortedEntries)

    // Output path: DATA/FINAL/Champions/{wadName}
    const wadOutputPath = path.join(outputDir, 'DATA', 'FINAL', 'Champions', wadName)
    writeWad(sortedEntries, checksum, wadOutputPath)
    totalEntries += sortedEntries.length
    console.log(`[NativeOverlay] Wrote ${wadName}: ${sortedEntries.length} entries`)
  }

  // Write a minimal config file (the .config that runoverlay/cslol-dll expects)
  const configPath = `${outputDir}.config`
  await fsp.writeFile(configPath, '')

  const elapsed = Date.now() - startTime
  console.log(
    `[NativeOverlay] Built overlay: ${totalEntries} entries across ${wadGroups.size} WADs, ${modNames.length} mods, ${elapsed}ms`
  )

  return { overlayPath: outputDir, configPath }
}
