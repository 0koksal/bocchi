import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { readPreviewFromZip } from '../utils/modPreview'

export class ImageService {
  private modsDir: string

  constructor() {
    // Service for loading custom skin images
    this.modsDir = path.join(app.getPath('userData'), 'mods')
  }

  async getCustomSkinImage(modPath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(modPath)

      if (stat.isFile()) {
        // Preview images live INSIDE the mod archive (IMAGE/preview.*, META/image.*,
        // META/thumbnail.*) — deleted together with the mod file
        const preview = await readPreviewFromZip(modPath)
        if (preview) {
          const mimeType =
            preview.ext === '.jpg' || preview.ext === '.jpeg'
              ? 'image/jpeg'
              : preview.ext === '.webp'
                ? 'image/webp'
                : 'image/png'
          return `data:${mimeType};base64,${preview.data.toString('base64')}`
        }

        // Legacy fallback: mods/{name}/IMAGE/preview.*
        const fileName = path.basename(modPath, path.extname(modPath))
        const imageDir = path.join(this.modsDir, fileName, 'IMAGE')
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp']
        for (const ext of imageExtensions) {
          const imagePath = path.join(imageDir, `preview${ext}`)
          try {
            await fs.access(imagePath)
            const imageBuffer = await fs.readFile(imagePath)
            const base64 = imageBuffer.toString('base64')
            const mimeType =
              ext === '.jpg' || ext === '.jpeg'
                ? 'image/jpeg'
                : ext === '.png'
                  ? 'image/png'
                  : 'image/webp'
            return `data:${mimeType};base64,${base64}`
          } catch {
            // Continue to next extension
          }
        }
        return null
      }

      if (stat.isDirectory()) {
        // Legacy structure: use the folder directly
        const imageDir = path.join(modPath, 'IMAGE')
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp']
        for (const ext of imageExtensions) {
          const imagePath = path.join(imageDir, `preview${ext}`)
          try {
            await fs.access(imagePath)
            const imageBuffer = await fs.readFile(imagePath)
            const base64 = imageBuffer.toString('base64')
            const mimeType =
              ext === '.jpg' || ext === '.jpeg'
                ? 'image/jpeg'
                : ext === '.png'
                  ? 'image/png'
                  : 'image/webp'
            return `data:${mimeType};base64,${base64}`
          } catch {
            // Continue to next extension
          }
        }
      }

      return null
    } catch {
      return null
    }
  }
}
