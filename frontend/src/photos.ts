// The only place for compression settings, a one-way door: originals aren't
// kept, so a photo compressed too hard can't be recovered. One encode from the
// decoded original, never a quality loop.

/** Haiku 5.5 reads up to 2,576 px and 4,784 visual tokens: on a 3:4 photo, 2200 px fits both. */
export const LONG_SIDE_MAX_PX = 2200
export const JPEG_QUALITY = 0.85
/** The backend's limit for one photo, 7 MiB. */
export const MAX_PHOTO_BYTES = 7 * 1024 * 1024
export const MAX_PAGES = 10
/** What the backend accepts when the original goes up uncompressed. */
export const ORIGINAL_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

/** Scaled so the long side is at most `longSideMax`, keeping the aspect ratio. Never enlarges. */
export function scaledSize(width: number, height: number, longSideMax: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error(`Not a size: ${width}×${height}`)
  const scale = Math.min(1, longSideMax / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export type Encode = (file: File, longSideMax: number, quality: number) => Promise<Blob>

/**
 * Decodes the photo with an `<img>`, which applies EXIF orientation, draws it
 * once on a white canvas and encodes one JPEG. No other drawing or filter.
 */
export const encodeInBrowser: Encode = async (file, longSideMax, quality) => {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const size = scaledSize(img.naturalWidth, img.naturalHeight, longSideMax)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('No 2D canvas.')
    // White first, so a transparent PNG doesn't turn black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, size.width, size.height)
    // Resampling quality, not a filter.
    context.imageSmoothingQuality = 'high'
    context.drawImage(img, 0, 0, size.width, size.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality)
    })
    if (blob === null || blob.type !== 'image/jpeg') throw new Error('The canvas gave no JPEG.')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type PreparedPhoto =
  | { ok: true; blob: Blob }
  | { ok: false; problem: 'format'; format: string | null }
  | { ok: false; problem: 'too_large' }

/** "IMG_1.HEIC" → "HEIC", null without an extension. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  return name.slice(dot + 1).toUpperCase()
}

/**
 * The photo compressed once. If the browser can't, the original when the
 * backend accepts it as is, otherwise the problem to show.
 */
export async function preparePhoto(file: File, encode: Encode = encodeInBrowser): Promise<PreparedPhoto> {
  let blob: Blob
  try {
    blob = await encode(file, LONG_SIDE_MAX_PX, JPEG_QUALITY)
  } catch {
    if (!ORIGINAL_TYPES.includes(file.type)) {
      return { ok: false, problem: 'format', format: extensionOf(file.name) }
    }
    blob = file
  }
  if (blob.size > MAX_PHOTO_BYTES) return { ok: false, problem: 'too_large' }
  return { ok: true, blob }
}
