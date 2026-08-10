import xxhash from 'xxhash-wasm'

let h64Raw: ((input: Uint8Array, seed?: bigint) => bigint) | null = null

// Initialize xxhash-wasm (must be called before using hash functions)
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (h64Raw) return
  if (initPromise) {
    await initPromise
    return
  }
  initPromise = xxhash().then((hasher) => {
    h64Raw = hasher.h64Raw
  })
  await initPromise
}

// Eagerly initialize on module load
ensureInit()

/**
 * Calculate XXH64 hash of a string path with zero seed.
 * Returns hex string (16 chars, zero-padded).
 */
export function xxhash64(input: string): string {
  if (!h64Raw) {
    throw new Error('xxhash-wasm not initialized. Call ensureXXHashReady() first.')
  }
  const encoder = new TextEncoder()
  const data = encoder.encode(input.toLowerCase())
  const hashBigInt = h64Raw(data, 0n)
  return hashBigInt.toString(16).padStart(16, '0')
}

/**
 * Ensures xxhash is ready for synchronous use.
 * Call this once at app startup before any hashing.
 */
export async function ensureXXHashReady(): Promise<void> {
  await ensureInit()
}
