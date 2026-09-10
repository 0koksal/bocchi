/**
 * Mod Repair Service — auto-fixer for the patch 16.17 "Hashpocalypse".
 *
 * Patch 16.17 changed 395 meta properties from String/Hash to File: the game now
 * stores XXH64 of the lowercased path instead of the path text, and a mod whose
 * .bin files still declare the old property types crashes the game on lookup.
 * (LTK Manager calls this "Meta property type mismatch", rule bin/property-type.)
 *
 * This service scans the PROP bins inside a custom skin mod (.fantome/.zip or a raw
 * .wad.client) for properties named by the migration table, and converts their values:
 *   String "ASSETS/.../x.dds"  ->  File XXH64("assets/.../x.dds")
 * including values nested inside Embeds, Pointers, Options, Lists and Maps.
 *
 * The original path strings are kept in the repair log. (The LTK "Embedded Hashtables"
 * standard file is deliberately not written: cslol-tools' fantome importer rejects
 * files under META/hashes.)
 *
 * The migration table ships from LeagueToolkit/ltk-manager (GPL-3.0).
 */
import fs from 'fs/promises'
import path from 'path'
import * as zlib from 'zlib'
import * as fzstd from 'fzstd'
import * as StreamZip from 'node-stream-zip'
import { xxhash64, ensureXXHashReady } from './xxhash'
import { BINFILE_MIGRATION_16_17 } from './binMigrationTable'

// ── bin property kinds (patch 16.17 numbering) ─────────────────────────────

const KIND_STRING = 16
const KIND_HASH = 17
const KIND_FILE = 18
const KIND_LIST = 128
const KIND_LIST2 = 129
const KIND_POINTER = 130
const KIND_EMBED = 131
const KIND_LINK = 132
const KIND_OPTION = 133
const KIND_MAP = 134

/** Fixed byte widths; -1 string, -2 struct, -3 option, -4 list, -5 map. */
const FIXED_WIDTH: Record<number, number> = {
  0: 0,
  1: 1,
  2: 1,
  3: 1,
  4: 2,
  5: 2,
  6: 4,
  7: 4,
  8: 8,
  9: 8,
  10: 4,
  11: 8,
  12: 12,
  13: 16,
  14: 64,
  15: 4, // Color is a packed 4-byte dword
  [KIND_STRING]: -1,
  [KIND_HASH]: 4,
  [KIND_FILE]: 8,
  [KIND_LIST]: -4,
  [KIND_LIST2]: -4,
  [KIND_POINTER]: -2,
  [KIND_EMBED]: -2,
  [KIND_LINK]: 4,
  [KIND_OPTION]: -3,
  [KIND_MAP]: -5,
  135: 1 // Flag
}

export interface RepairReport {
  /** Whether the file was scanned (false for unsupported formats). */
  scanned: boolean
  /** Properties found carrying an outdated type. */
  findings: number
  /** Properties converted to the new type. */
  repaired: number
  /** Properties left untouched (no automatic conversion, e.g. Hash → File). */
  unfixed: number
  /** File was rewritten. */
  modified: boolean
  /** Human-readable findings, e.g. "SkinMeshDataProperties.texture". */
  details: string[]
}

export interface MigrationRow {
  classHash: number
  fieldHash: number
  from: { type: string; key?: string; value?: string; class?: string }
  to: { type: string; key?: string; value?: string; class?: string }
  conversion: string
}

const KIND_NAME_TO_TAG: Record<string, number> = {
  String: KIND_STRING,
  Hash: KIND_HASH,
  File: KIND_FILE,
  List: KIND_LIST,
  List2: KIND_LIST2,
  Pointer: KIND_POINTER,
  Embed: KIND_EMBED,
  Link: KIND_LINK,
  Option: KIND_OPTION,
  Map: KIND_MAP,
  Flag: 135,
  Bool: 1,
  I32: 6,
  U32: 7,
  U8: 3
}

// ── hashing ──────────────────────────────────────────────────────────────────

/** FNV-1a 32 of a lowercased string — how bin class/field names are hashed. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** XXH64 of the lowercased path, as little-endian bytes — the File value format. */
function fileHashBytes(pathText: string): Buffer {
  const hex = xxhash64(pathText)
  return Buffer.from(hex.padStart(16, '0'), 'hex').swap64()
}

// ── migration table ──────────────────────────────────────────────────────────

let migrationTable: Map<string, MigrationRow> | null = null

function getMigrationTable(): Map<string, MigrationRow> {
  if (migrationTable) return migrationTable
  const map = new Map<string, MigrationRow>()
  for (const line of BINFILE_MIGRATION_16_17.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed)
      const classHash = row.class.startsWith('0x')
        ? parseInt(row.class, 16)
        : fnv1a32(row.class.toLowerCase())
      const fieldHash = row.field.startsWith('0x')
        ? parseInt(row.field, 16)
        : fnv1a32(row.field.toLowerCase())
      map.set(`${classHash}_${fieldHash}`, {
        classHash,
        fieldHash,
        from: row.from,
        to: row.to,
        conversion: row.conversion
      })
    } catch {
      // A row we cannot read is a row we must not act on
    }
  }
  migrationTable = map
  return map
}

// ── bin value model ──────────────────────────────────────────────────────────

interface BinProperty {
  fieldHash: number
  kind: number
  value: BinValue
}

type BinValue =
  | { t: 'raw'; bytes: Buffer }
  | { t: 'string'; text: string }
  | { t: 'list'; itemType: number; items: BinValue[] }
  | { t: 'map'; keyType: number; valType: number; entries: Array<{ k: BinValue; v: BinValue }> }
  | { t: 'struct'; classHash: number; props: BinProperty[] }
  | { t: 'option'; itemType: number; has: boolean; value?: BinValue }

interface BinObject {
  pathHash: number
  classHash: number
  props: BinProperty[]
}

interface BinFile {
  version: number
  dependencies: string[]
  objects: BinObject[]
}

// ── bin parsing (with in-place repair) ───────────────────────────────────────

class BinCursor {
  pos = 0
  constructor(private readonly buf: Buffer) {}

  u8(): number {
    return this.buf.readUInt8(this.pos++)
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }
  string(n: number): string {
    return this.bytes(n).toString('latin1')
  }
  skip(n: number): void {
    this.pos += n
  }
}

class ModRepairContext {
  findings = 0
  repaired = 0
  unfixed = 0
  details: string[] = []
  recoveredPaths = new Set<string>()
}

function kindName(tag: number): string {
  for (const [name, t] of Object.entries(KIND_NAME_TO_TAG)) {
    if (t === tag) return name
  }
  return `kind${tag}`
}

/** Whether the declared type matches the row's `from`/`to` spec (container-aware). */
function typeSpecMatches(
  spec: { type: string; key?: string; value?: string },
  kind: number,
  itemType?: number,
  keyType?: number
): boolean {
  const tag = KIND_NAME_TO_TAG[spec.type]
  if (tag === undefined || tag !== kind) return false
  if (kind === KIND_LIST || kind === KIND_LIST2 || kind === KIND_OPTION) {
    if (spec.value) {
      const itemTag = KIND_NAME_TO_TAG[spec.value]
      if (itemTag !== undefined && itemType !== itemTag) return false
    }
  }
  if (kind === KIND_MAP) {
    if (spec.key) {
      const keyTag = KIND_NAME_TO_TAG[spec.key]
      if (keyTag !== undefined && keyType !== keyTag) return false
    }
    if (spec.value) {
      const valTag = KIND_NAME_TO_TAG[spec.value]
      if (valTag !== undefined && itemType !== valTag) return false
    }
  }
  return true
}

/**
 * Apply the migration table to one property value. Returns the (possibly
 * converted) kind to declare, or null when the property must stay untouched.
 */
function repairProperty(
  ctx: ModRepairContext,
  classHash: number,
  prop: BinProperty,
  where: string,
  fieldName: string
): void {
  const table = getMigrationTable()
  const row = table.get(`${classHash}_${prop.fieldHash}`)
  if (!row) return

  const itemType =
    prop.value.t === 'list' || prop.value.t === 'option'
      ? prop.value.itemType
      : prop.value.t === 'map'
        ? prop.value.valType
        : undefined
  const keyType = prop.value.t === 'map' ? prop.value.keyType : undefined

  // Already at the new type — nothing to do (makes the repair idempotent)
  if (typeSpecMatches(row.to, prop.kind, itemType, keyType)) return
  // Not at the old type either — leave alone
  if (!typeSpecMatches(row.from, prop.kind, itemType, keyType)) return

  ctx.findings++
  const label = `${where} ${fieldName || `0x${prop.fieldHash.toString(16)}`} (${kindName(prop.kind)} → ${row.to.type})`

  if (row.conversion === 'hash_value') {
    let recovered: string | null = null
    let changed = false

    if (prop.kind === KIND_STRING && prop.value.t === 'string') {
      recovered = prop.value.text
      prop.value = { t: 'raw', bytes: fileHashBytes(prop.value.text) }
      prop.kind = KIND_FILE
      changed = true
    } else if (prop.value.t === 'option' && prop.value.itemType === KIND_STRING) {
      prop.value.itemType = KIND_FILE
      changed = true
      if (prop.value.has && prop.value.value?.t === 'string') {
        recovered = prop.value.value.text
        prop.value.value = { t: 'raw', bytes: fileHashBytes(prop.value.value.text) }
      }
      prop.kind = KIND_OPTION
    } else if (
      (prop.value.t === 'list' && prop.value.itemType === KIND_STRING) ||
      (prop.value.t === 'map' && prop.value.valType === KIND_STRING)
    ) {
      changed = true
      if (prop.value.t === 'list') {
        prop.value.itemType = KIND_FILE
        prop.value.items = prop.value.items.map((item) => {
          if (item.t === 'string') {
            recovered = item.text
            return { t: 'raw', bytes: fileHashBytes(item.text) }
          }
          return item
        })
      } else {
        prop.value.valType = KIND_FILE
        prop.value.entries = prop.value.entries.map((e) => {
          if (e.v.t === 'string') {
            recovered = e.v.text
            return { k: e.k, v: { t: 'raw', bytes: fileHashBytes(e.v.text) } }
          }
          return e
        })
      }
    }

    if (changed) {
      if (recovered !== null) ctx.recoveredPaths.add(recovered)
      ctx.repaired++
      ctx.details.push(label)
      return
    }
    ctx.unfixed++
    ctx.details.push(`${label} [skipped]`)
    return
  }

  if (row.conversion === 'none' && row.from.type === 'Embed' && row.to.type === 'Pointer') {
    if (prop.kind === KIND_EMBED) {
      prop.kind = KIND_POINTER
      ctx.repaired++
      ctx.details.push(label)
      return
    }
  }
  if (row.conversion === 'none' && row.from.type === 'Pointer' && row.to.type === 'Embed') {
    if (prop.kind === KIND_POINTER) {
      prop.kind = KIND_EMBED
      ctx.repaired++
      ctx.details.push(label)
      return
    }
  }

  // rehash / hash_key need the path behind an FNV hash — not recoverable here
  ctx.unfixed++
  ctx.details.push(`${label} [needs path lookup, left unchanged]`)
}

function parseValue(cur: BinCursor, kind: number, ctx: ModRepairContext): BinValue {
  const w = FIXED_WIDTH[kind]
  if (w === undefined) throw new Error(`unknown property kind ${kind} at ${cur.pos}`)
  if (w >= 0) return { t: 'raw', bytes: Buffer.from(cur.bytes(w)) }
  if (w === -1) return { t: 'string', text: cur.string(cur.u16()) }
  if (w === -2) {
    const classHash = cur.u32()
    if (classHash === 0) return { t: 'struct', classHash: 0, props: [] }
    const size = cur.u32()
    const start = cur.pos
    const count = cur.u16()
    const props: BinProperty[] = []
    for (let i = 0; i < count; i++) {
      props.push(parseProperty(cur, classHash, ctx, `0x${classHash.toString(16)}`))
    }
    if (cur.pos - start !== size) cur.pos = start + size // resync on size lies
    return { t: 'struct', classHash, props }
  }
  if (w === -3) {
    const itemType = cur.u8()
    const has = cur.u8() !== 0
    const value = has ? parseValue(cur, itemType, ctx) : undefined
    return { t: 'option', itemType, has, value }
  }
  if (w === -4) {
    const itemType = cur.u8()
    const size = cur.u32()
    const start = cur.pos
    const count = cur.u32()
    const items: BinValue[] = []
    for (let i = 0; i < count; i++) items.push(parseValue(cur, itemType, ctx))
    if (cur.pos - start !== size) cur.pos = start + size
    return { t: 'list', itemType, items }
  }
  // map
  const keyType = cur.u8()
  const valType = cur.u8()
  const size = cur.u32()
  const start = cur.pos
  const count = cur.u32()
  const entries: Array<{ k: BinValue; v: BinValue }> = []
  for (let i = 0; i < count; i++) {
    const k = parseValue(cur, keyType, ctx)
    const v = parseValue(cur, valType, ctx)
    entries.push({ k, v })
  }
  if (cur.pos - start !== size) cur.pos = start + size
  return { t: 'map', keyType, valType, entries }
}

function parseProperty(
  cur: BinCursor,
  classHash: number,
  ctx: ModRepairContext,
  where: string
): BinProperty {
  const fieldHash = cur.u32()
  const kind = cur.u8()
  const prop: BinProperty = { fieldHash, kind, value: { t: 'raw', bytes: Buffer.alloc(0) } }
  // Parse the value first so nested structs are walked even when this level is repaired
  prop.value = parseValue(cur, kind, ctx)

  // The table may convert a container's declared item types, which parseValue
  // already applied to the inner values — detect from the parsed shape.
  repairProperty(ctx, classHash, prop, where, '')
  return prop
}

function parseBin(data: Buffer, ctx: ModRepairContext): BinFile {
  const cur = new BinCursor(data)
  const magic = cur.string(4)
  if (magic !== 'PROP') throw new Error(`unsupported bin magic: ${JSON.stringify(magic)}`)
  const version = cur.u32()
  if (version < 1 || version > 3) throw new Error(`unsupported bin version ${version}`)

  const dependencies: string[] = []
  if (version >= 2) {
    const depCount = cur.u32()
    for (let i = 0; i < depCount; i++) dependencies.push(cur.string(cur.u16()))
  }

  const objectCount = cur.u32()
  const classHashes: number[] = []
  for (let i = 0; i < objectCount; i++) classHashes.push(cur.u32())

  const objects: BinObject[] = []
  for (let oi = 0; oi < objectCount; oi++) {
    const size = cur.u32()
    const start = cur.pos
    const pathHash = cur.u32()
    const propCount = cur.u16()
    const props: BinProperty[] = []
    for (let i = 0; i < propCount; i++) {
      props.push(parseProperty(cur, classHashes[oi], ctx, `obj 0x${pathHash.toString(16)}`))
    }
    if (cur.pos - start !== size) cur.pos = start + size
    objects.push({ pathHash, classHash: classHashes[oi], props })
  }

  return { version, dependencies, objects }
}

// ── bin writing (sizes recomputed) ───────────────────────────────────────────

class ByteWriter {
  private chunks: Buffer[] = []
  private len = 0

  u8(v: number): void {
    const b = Buffer.alloc(1)
    b.writeUInt8(v)
    this.push(b)
  }
  u16(v: number): void {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(v)
    this.push(b)
  }
  u32(v: number): void {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v >>> 0)
    this.push(b)
  }
  u64(v: bigint): void {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(v)
    this.push(b)
  }
  bytes(b: Buffer): void {
    this.push(Buffer.from(b))
  }
  string(s: string): void {
    const raw = Buffer.from(s, 'latin1')
    this.u16(raw.length)
    this.push(raw)
  }
  rawString(s: string): void {
    this.push(Buffer.from(s, 'latin1'))
  }
  private push(b: Buffer): void {
    this.chunks.push(b)
    this.len += b.length
  }
  get length(): number {
    return this.len
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.len)
  }
}

function writeValue(w: ByteWriter, v: BinValue): void {
  switch (v.t) {
    case 'raw':
      w.bytes(v.bytes)
      return
    case 'string':
      w.u16(Buffer.byteLength(v.text, 'latin1'))
      w.rawString(v.text)
      return
    case 'list': {
      const body = new ByteWriter()
      body.u32(v.items.length)
      for (const item of v.items) writeValue(body, item)
      w.u8(v.itemType)
      w.u32(body.length)
      w.bytes(body.toBuffer())
      return
    }
    case 'map': {
      const body = new ByteWriter()
      body.u32(v.entries.length)
      for (const e of v.entries) {
        writeValue(body, e.k)
        writeValue(body, e.v)
      }
      w.u8(v.keyType)
      w.u8(v.valType)
      w.u32(body.length)
      w.bytes(body.toBuffer())
      return
    }
    case 'struct': {
      w.u32(v.classHash)
      if (v.classHash === 0) return
      const body = new ByteWriter()
      body.u16(v.props.length)
      for (const p of v.props) writeProperty(body, p)
      w.u32(body.length)
      w.bytes(body.toBuffer())
      return
    }
    case 'option': {
      w.u8(v.itemType)
      w.u8(v.has ? 1 : 0)
      if (v.has && v.value) writeValue(w, v.value)
      return
    }
  }
}

function writeProperty(w: ByteWriter, p: BinProperty): void {
  w.u32(p.fieldHash)
  w.u8(p.kind)
  writeValue(w, p.value)
}

function writeBin(bin: BinFile): Buffer {
  const w = new ByteWriter()
  w.rawString('PROP')
  w.u32(bin.version)
  if (bin.version >= 2) {
    w.u32(bin.dependencies.length)
    for (const dep of bin.dependencies) w.string(dep)
  }
  w.u32(bin.objects.length)
  for (const obj of bin.objects) w.u32(obj.classHash)
  for (const obj of bin.objects) {
    const body = new ByteWriter()
    body.u32(obj.pathHash)
    body.u16(obj.props.length)
    for (const p of obj.props) writeProperty(body, p)
    w.u32(body.length)
    w.bytes(body.toBuffer())
  }
  return w.toBuffer()
}

// ── WAD handling ─────────────────────────────────────────────────────────────

const WAD_COMPRESSION = { RAW: 0, GZIP: 1, ZSTD: 3, ZSTD_CHUNKED: 4 } as const

interface WadEntry {
  hash: bigint
  offset: number
  compressedSize: number
  decompressedSize: number
  typeByte: number
  tail: Buffer // subchunk index (3 bytes) + checksum (8 bytes), copied verbatim
}

function parseWad(data: Buffer): { major: number; minor: number; entries: WadEntry[] } | null {
  if (data.length < 4 || data[0] !== 0x52 || data[1] !== 0x57) return null // "RW"
  const major = data[2]
  const minor = data[3]
  if (major !== 3) return null // only v3 is rebuilt; older wads are left untouched
  const entriesStart = 4 + 256 + 8 + 4
  const count = data.readUInt32LE(268)
  const entries: WadEntry[] = []
  for (let i = 0; i < count; i++) {
    const p = entriesStart + i * 32
    if (p + 32 > data.length) return null
    entries.push({
      hash: data.readBigUInt64LE(p),
      offset: data.readUInt32LE(p + 8),
      compressedSize: data.readUInt32LE(p + 12),
      decompressedSize: data.readUInt32LE(p + 16),
      typeByte: data[p + 20],
      tail: Buffer.from(data.subarray(p + 21, p + 32))
    })
  }
  return { major, minor, entries }
}

function writeWad(
  original: Buffer,
  info: { major: number; minor: number; entries: WadEntry[] },
  replacedData: Map<number, Buffer>
): Buffer {
  const headerSize = 4 + 256 + 8 + 4
  const entries: WadEntry[] = info.entries.map((e, i) => {
    const repl = replacedData.get(i)
    if (!repl) return e
    return {
      hash: e.hash,
      offset: 0,
      compressedSize: repl.length,
      decompressedSize: repl.length,
      typeByte: WAD_COMPRESSION.RAW,
      tail: Buffer.alloc(11) // zero checksum: readers compute it lazily
    }
  })

  const dataStart = headerSize + entries.length * 32
  let offset = dataStart
  const dataChunks: Buffer[] = []
  const outEntries: WadEntry[] = []
  for (let i = 0; i < entries.length; i++) {
    const repl = replacedData.get(i)
    const bytes = repl ?? original.subarray(info.entries[i].offset, info.entries[i].offset + info.entries[i].compressedSize)
    const entry = { ...entries[i], offset }
    outEntries.push(entry)
    dataChunks.push(bytes)
    offset += bytes.length
  }

  const out = Buffer.alloc(offset)
  // Signature: keep the original RW major.minor bytes
  original.copy(out, 0, 0, 4)
  // Header padding, file checksum and count
  original.copy(out, 4, 4, headerSize - 4)
  out.writeUInt32LE(entries.length, 268)
  outEntries.forEach((e, i) => {
    const p = headerSize + i * 32
    out.writeBigUInt64LE(e.hash, p)
    out.writeUInt32LE(e.offset, p + 8)
    out.writeUInt32LE(e.compressedSize, p + 12)
    out.writeUInt32LE(e.decompressedSize, p + 16)
    out.writeUInt8(e.typeByte, p + 20)
    e.tail.copy(out, p + 21)
  })
  let pos = dataStart
  for (const chunk of dataChunks) {
    chunk.copy(out, pos)
    pos += chunk.length
  }
  return out
}

// ── ZIP writing (STORE-only, zero dependencies) ──────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipInputEntry {
  name: string
  data: Buffer
}

function writeStoreZip(entries: ZipInputEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    lfh.writeUInt16LE(0, 8) // method: store
    lfh.writeUInt16LE(0, 10) // time
    lfh.writeUInt16LE(0x21, 12) // date (1996-01-01, deterministic)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(entry.data.length, 18)
    lfh.writeUInt32LE(entry.data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    local.push(lfh, nameBuf, entry.data)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0x0800, 8)
    cdh.writeUInt16LE(0, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0x21, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(entry.data.length, 20)
    cdh.writeUInt32LE(entry.data.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30) // extra
    cdh.writeUInt16LE(0, 32) // comment
    cdh.writeUInt16LE(0, 34) // disk
    cdh.writeUInt16LE(0, 36) // internal attrs
    cdh.writeUInt32LE(0, 38) // external attrs
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)

    offset += 30 + nameBuf.length + entry.data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...local, centralBuf, eocd])
}

// ── public API ───────────────────────────────────────────────────────────────

const emptyReport = (scanned: boolean): RepairReport => ({
  scanned,
  findings: 0,
  repaired: 0,
  unfixed: 0,
  modified: false,
  details: []
})

/** Scan + repair one WAD file's PROP bins. Returns null when the file is left untouched. */
function repairWadBuffer(
  data: Buffer,
  sourceName: string,
  ctx: ModRepairContext
): Buffer | null {
  let wad: ReturnType<typeof parseWad>
  try {
    wad = parseWad(data)
  } catch {
    return null
  }
  if (!wad) return null

  const replaced = new Map<number, Buffer>()
  wad.entries.forEach((entry, index) => {
    const compression = entry.typeByte & 0x0f
    if (
      compression !== WAD_COMPRESSION.RAW &&
      compression !== WAD_COMPRESSION.GZIP &&
      compression !== WAD_COMPRESSION.ZSTD &&
      compression !== WAD_COMPRESSION.ZSTD_CHUNKED
    ) {
      return
    }
    let chunk: Buffer
    try {
      const raw = data.subarray(entry.offset, entry.offset + entry.compressedSize)
      if (compression === WAD_COMPRESSION.RAW) chunk = raw
      else if (compression === WAD_COMPRESSION.GZIP) chunk = zlib.gunzipSync(raw)
      else chunk = Buffer.from(fzstd.decompress(new Uint8Array(raw)))
    } catch {
      return // unreadable chunk — not ours to fix
    }
    if (chunk.subarray(0, 4).toString('latin1') !== 'PROP') return

    try {
      const before = ctx.findings
      const bin = parseBin(chunk, ctx)
      const binFindings = ctx.findings - before
      if (binFindings > 0) {
        const repairedBin = writeBin(bin)
        replaced.set(index, repairedBin)
        console.log(
          `[ModRepair] ${sourceName}: ${binFindings} property type(s) converted to File`
        )
      }
    } catch (err) {
      console.warn(`[ModRepair] ${sourceName}: failed to parse a PROP bin:`, err)
    }
  })

  if (replaced.size === 0) return null
  return writeWad(data, wad, replaced)
}

/**
 * Scan and repair a custom skin mod file in place.
 * Supports .fantome/.zip packages and raw .wad.client/.wad files.
 */
export async function repairModFile(filePath: string): Promise<RepairReport> {
  await ensureXXHashReady()
  const ext = path.extname(filePath).toLowerCase()
  const ctx = new ModRepairContext()

  try {
    if (ext === '.wad' || filePath.toLowerCase().endsWith('.wad.client')) {
      const data = await fs.readFile(filePath)
      const fixed = repairWadBuffer(data, path.basename(filePath), ctx)
      if (fixed) {
        await fs.writeFile(filePath, fixed)
        return { ...reportOf(ctx), modified: true }
      }
      return reportOf(ctx)
    }

    if (ext === '.fantome' || ext === '.zip') {
      return await repairFantome(filePath, ctx)
    }

    return emptyReport(false)
  } catch (err) {
    console.error(`[ModRepair] Failed to repair ${filePath}:`, err)
    return { ...emptyReport(ctx.findings > 0), details: ctx.details }
  }
}

function reportOf(ctx: ModRepairContext): RepairReport {
  return {
    scanned: true,
    findings: ctx.findings,
    repaired: ctx.repaired,
    unfixed: ctx.unfixed,
    modified: false,
    details: ctx.details
  }
}

async function repairFantome(filePath: string, ctx: ModRepairContext): Promise<RepairReport> {
  const zip = new StreamZip.async({ file: filePath })
  const inputs: ZipInputEntry[] = []
  let anyRepaired = false

  try {
    const entries = Object.values(await zip.entries())
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const data = await zip.entryData(entry)
      const name = entry.name.replace(/\\/g, '/')
      // cslol-tools' fantome importer fails on any file under META/hashes (its
      // copy_file hits the directory -> Access is denied), so packages carrying
      // the LTK embedded hashtable get it stripped on the way through
      if (name.toUpperCase().startsWith('META/HASHES/')) {
        anyRepaired = true
        continue
      }
      const isWad = name.toUpperCase().startsWith('WAD/') && /\.WAD(\.CLIENT)?$/i.test(name)
      if (isWad) {
        const fixed = repairWadBuffer(data, name, ctx)
        if (fixed) {
          anyRepaired = true
          inputs.push({ name, data: fixed })
          continue
        }
      }
      inputs.push({ name, data: Buffer.from(data) })
    }
  } finally {
    await zip.close()
  }

  if (!anyRepaired) return reportOf(ctx)

  // Note: cslol-tools' fantome importer fails on any file under META/hashes
  // (copy_file on the directory -> Access is denied), so packages carrying the LTK
  // "Embedded Hashtables" standard get that folder stripped above, and we never
  // write one ourselves — recovered paths stay in the log only.

  const tmpPath = filePath + '.repair.tmp'
  await fs.writeFile(tmpPath, writeStoreZip(inputs))
  await fs.rename(tmpPath, filePath)

  const report = reportOf(ctx)
  report.modified = true
  console.log(
    `[ModRepair] ${path.basename(filePath)}: repaired ${report.repaired} property type(s)` +
      (report.unfixed > 0 ? `, ${report.unfixed} left unchanged (need path lookup)` : '')
  )
  return report
}
