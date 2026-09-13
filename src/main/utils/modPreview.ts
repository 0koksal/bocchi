import fs from 'fs'
import path from 'path'
import StreamZip from 'node-stream-zip'

/**
 * Preview image handling for custom mod archives (.fantome / .zip).
 * Preview images live INSIDE the mod archive (IMAGE/preview.*, META/image.*,
 * META/thumbnail.*), so they are deleted together with the mod file and never
 * leave orphaned files behind.
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntryData {
  name: string
  data: Buffer
}

/** Builds a STORE-method zip from raw entries (no compression dependencies) */
export function buildStoreZip(entries: ZipEntryData[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date (fixed)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, entry.data)

    const centralRec = Buffer.alloc(46)
    centralRec.writeUInt32LE(0x02014b50, 0)
    centralRec.writeUInt16LE(20, 4)
    centralRec.writeUInt16LE(20, 6)
    centralRec.writeUInt16LE(0, 8)
    centralRec.writeUInt16LE(0, 10)
    centralRec.writeUInt16LE(0, 12)
    centralRec.writeUInt16LE(0x21, 14)
    centralRec.writeUInt32LE(crc, 16)
    centralRec.writeUInt32LE(entry.data.length, 20)
    centralRec.writeUInt32LE(entry.data.length, 24)
    centralRec.writeUInt16LE(nameBuf.length, 28)
    centralRec.writeUInt32LE(offset, 42)
    central.push(centralRec, nameBuf)

    offset += 30 + nameBuf.length + entry.data.length
  }

  const centralOffset = offset
  let centralSize = 0
  for (const c of central) centralSize += c.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)

  return Buffer.concat([...chunks, ...central, eocd])
}

/**
 * Picks the best preview entry from a list of zip entry names.
 * Priority: IMAGE/preview.* > META/image.* > META/thumbnail.* > any image,
 * shallow paths first.
 */
export function findPreviewEntryName(names: string[]): string | null {
  const images = names.filter((n) => !n.endsWith('/') && /\.(png|jpe?g|webp)$/i.test(n))
  if (images.length === 0) return null
  const score = (n: string): number => {
    const depth = n.split('/').length
    if (/^IMAGE\/preview\./i.test(n)) return 100 - depth
    if (/^META\/image\./i.test(n)) return 80 - depth
    if (/^META\/thumbnail\./i.test(n)) return 60 - depth
    if (/thumb|preview|banner/i.test(n)) return 40 - depth
    return 20 - depth
  }
  return images.reduce((best, n) => (score(n) > score(best) ? n : best), images[0])
}

/** Reads the preview image data from a mod archive, or null if it has none */
export async function readPreviewFromZip(
  filePath: string
): Promise<{ data: Buffer; ext: string } | null> {
  let zip: InstanceType<typeof StreamZip.async> | null = null
  try {
    zip = new StreamZip.async({ file: filePath })
    const entries = (await zip!.entries()) as Record<string, { isDirectory: boolean; name: string }>
    const names = Object.values(entries)
      .filter((e) => !e.isDirectory)
      .map((e) => e.name)
    const previewName = findPreviewEntryName(names)
    if (!previewName) return null
    const data = await zip!.entryData(entries[previewName] as never)
    const ext = path.extname(previewName).toLowerCase() || '.png'
    return { data: Buffer.from(data), ext }
  } catch {
    return null
  } finally {
    await zip?.close().catch(() => {})
  }
}

/** True if the archive already contains any image entry */
export async function zipHasImage(filePath: string): Promise<boolean> {
  let zip: InstanceType<typeof StreamZip.async> | null = null
  try {
    zip = new StreamZip.async({ file: filePath })
    const entries = await zip.entries()
    return Object.values(entries).some(
      (e) => !e.isDirectory && /\.(png|jpe?g|webp)$/i.test(e.name)
    )
  } catch {
    return false
  } finally {
    await zip?.close().catch(() => {})
  }
}

/**
 * Adds (or replaces) an entry inside a zip archive by rebuilding it.
 * Used to embed preview images into mod archives.
 */
export async function injectEntryIntoZip(
  filePath: string,
  entryName: string,
  data: Buffer
): Promise<void> {
  let zip: InstanceType<typeof StreamZip.async> | null = null
  const entries: ZipEntryData[] = []
  try {
    zip = new StreamZip.async({ file: filePath })
    const existing = await zip.entries()
    for (const entry of Object.values(existing)) {
      if (entry.isDirectory) continue
      entries.push({ name: entry.name, data: await zip.entryData(entry) })
    }
  } finally {
    await zip?.close().catch(() => {})
  }
  const filtered = entries.filter((e) => e.name !== entryName)
  filtered.push({ name: entryName, data })
  const tempPath = filePath + '.tmp'
  fs.writeFileSync(tempPath, buildStoreZip(filtered))
  fs.renameSync(tempPath, filePath)
}
