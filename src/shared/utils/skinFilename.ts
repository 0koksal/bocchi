export interface SkinNameInfo {
  nameEn?: string
  name: string
  chromaId?: string
  variantId?: string
}

/**
 * Generates a consistent filename for a skin or chroma
 * This function ensures the same filename is generated whether downloading or checking status
 * Note: File extension (.zip or .fantome) is handled during comparison, not generation
 */
export function generateSkinFilename(skin: SkinNameInfo): string {
  // Use the same priority order as the download logic
  // Remove characters that are invalid in Windows filenames (: / \ * ? " < > |)
  const baseName = (skin.nameEn || skin.name).replace(/[:/\\*?"<>|]/g, '')

  if (skin.chromaId) {
    return `${baseName} ${skin.chromaId}`
  }

  if (skin.variantId) {
    return `${baseName} (${skin.variantId})`
  }

  return baseName
}

/**
 * Checks if a downloaded skin filename matches the expected skin name
 * Handles both .zip and .fantome extensions
 */
export function matchesSkinFilename(downloadedFilename: string, expectedBaseName: string): boolean {
  // Remove extension from downloaded filename
  const filenameWithoutExt = downloadedFilename.replace(/\.(zip|fantome)$/i, '')
  return filenameWithoutExt === expectedBaseName
}

/**
 * Extracts the base skin name without file extension or chroma ID
 */
export function extractBaseSkinName(filename: string): string {
  // Remove .zip or .fantome extension
  let baseName = filename.replace(/\.(zip|fantome)$/i, '')

  // Remove chroma ID (numbers at the end after a space)
  baseName = baseName.replace(/\s+\d+$/, '')

  // Remove variant ID (text in parentheses at the end)
  baseName = baseName.replace(/\s+\([^)]+\)$/, '')

  return baseName
}

/**
 * Checks if two filenames represent the same skin (ignoring chroma variations)
 */
export function isSameSkin(filename1: string, filename2: string): boolean {
  return extractBaseSkinName(filename1) === extractBaseSkinName(filename2)
}

/**
 * Normalizes a skin name for comparison (removes special chars, lowercases)
 */
export function normalizeSkinName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()
}
