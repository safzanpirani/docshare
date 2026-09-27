// Image output formats. Uploads used to be WebP-only; the browser now offers a
// WEBP/PNG toggle, so every place that touches an image object has to be
// extension-aware.
//
// Two invariants this module exists to hold:
//
//  1. The stored extension is decided by the *validated* bytes, never by the
//     client's declared content-type alone. A caller can claim anything; the
//     magic bytes are the truth.
//  2. Clients hold a **bare id** (no extension) — /api/info/:id, /api/delete
//     and /api/ocr/:id all receive one. Resolving a bare id must probe every
//     format, which is what findImage() is for. Any new bare-id endpoint has to
//     go through it, or it will silently miss PNG uploads.

export type ImageFormat = 'webp' | 'png'

export const IMAGE_FORMATS: readonly ImageFormat[] = ['webp', 'png']

const CONTENT_TYPE_TO_FORMAT: Record<string, ImageFormat> = {
  'image/webp': 'webp',
  'image/png': 'png',
}

// Exact-match on a normalized type. The client builds this header itself, but
// direct API/curl users are a supported path, so tolerate case and parameters
// (`image/PNG`, `image/png; charset=binary`) rather than 415-ing on them.
export function formatFromContentType(contentType: string | undefined): ImageFormat | undefined {
  if (!contentType) return undefined
  const ct = contentType.toLowerCase().split(';')[0].trim()
  return CONTENT_TYPE_TO_FORMAT[ct]
}

export function contentTypeFor(format: ImageFormat): string {
  return `image/${format}`
}

export function imageKey(id: string, format: ImageFormat): string {
  return `img/${id}.${format}`
}

// RIFF....WEBP
export function isWebp(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false
  const b = new Uint8Array(buf, 0, 12)
  return (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
}

// \x89 P N G \r \n \x1a \n
export function isPng(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 8) return false
  const b = new Uint8Array(buf, 0, 8)
  return (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
}

// True when the bytes really are the format they claim to be.
export function bytesMatchFormat(buf: ArrayBuffer, format: ImageFormat): boolean {
  return format === 'webp' ? isWebp(buf) : isPng(buf)
}

// Detect the format from the bytes alone, independent of any declared type.
export function detectImageFormat(buf: ArrayBuffer): ImageFormat | undefined {
  if (isWebp(buf)) return 'webp'
  if (isPng(buf)) return 'png'
  return undefined
}

// Split a stored object key (`img/abc123.png`) into its id and format.
export function parseImageKey(key: string): { id: string; format: ImageFormat } | undefined {
  if (!key.startsWith('img/')) return undefined
  const base = key.slice('img/'.length)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1) as ImageFormat
  if (!IMAGE_FORMATS.includes(ext)) return undefined
  return { id: base.slice(0, dot), format: ext }
}
