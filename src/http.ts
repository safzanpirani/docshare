// Pure request/response helpers, extracted from index.ts so they can be unit
// tested without a Workers runtime. No I/O, no bindings — everything here is a
// total function over strings/numbers.

export const DEFAULT_DOC_CONTENT_TYPE = 'application/octet-stream'
export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive'

// Only known-safe browser media types render inline. A broad `image/*` rule
// would be too permissive for this origin: SVG (and future active media types)
// would then be controlled by client-declared metadata, turning an upload into
// stored XSS.
export const SAFE_INLINE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/aac',
  'audio/flac',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-wav',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
])

// Extensions we render in the in-browser text viewer. Uploaded code/markdown
// often arrives as application/octet-stream (browsers don't know the type), so
// extension is the reliable signal. Deliberately excludes binary formats.
// Extensions that mean "playable media" for the /w/ watch page. Uploads often
// arrive as application/octet-stream (screen recorders, drag-drop from Finder),
// so the extension is the reliable signal — same reasoning as TEXT_EXTENSIONS.
export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'])
export const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'oga', 'ogg', 'opus'])

export function mediaKind(filename: string, contentType: string): 'video' | 'audio' | null {
  const ct = normalizeContentType(contentType)
  const ext = fileExt(filename)
  if (ct.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (ct.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio'
  return null
}

export const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'md', 'markdown', 'mdx',
  'json', 'jsonc', 'json5', 'geojson', 'ndjson', 'xml', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'editorconfig',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'pyw', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'php', 'swift',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'lua', 'pl', 'pm', 'r',
  'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'diff', 'patch', 'tex', 'dart', 'ex', 'exs', 'graphql', 'gql', 'proto',
  'dockerfile', 'makefile', 'gitignore', 'dockerignore', 'nim', 'zig', 'jl',
])

export const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

export function normalizeContentType(contentType: string): string {
  const ct = String(contentType).toLowerCase().split(';')[0].trim()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(ct)
    ? ct
    : DEFAULT_DOC_CONTENT_TYPE
}

export function shouldServeInline(contentType: string): boolean {
  return SAFE_INLINE_CONTENT_TYPES.has(normalizeContentType(contentType))
}

export function fileExt(filename: string): string {
  const base = filename.toLowerCase().split('/').pop() || ''
  if (!base.includes('.')) return base // e.g. Dockerfile, Makefile
  return base.slice(base.lastIndexOf('.') + 1)
}

export function contentTypeForDownload(filename: string, storedContentType: string): string {
  return fileExt(filename) === 'apk' ? APK_CONTENT_TYPE : storedContentType
}

export function isViewableText(filename: string, contentType: string): boolean {
  const ct = normalizeContentType(contentType)
  if (ct.startsWith('text/') || ct === 'application/json' || ct === 'application/xml') return true
  return TEXT_EXTENSIONS.has(fileExt(filename))
}

export function isPdfFile(filename: string, contentType: string): boolean {
  return fileExt(filename) === 'pdf' || normalizeContentType(contentType) === 'application/pdf'
}

export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ))
}

// Strip path separators and control chars; keep a reasonable filename.
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return (cleaned || 'file').slice(0, 200)
}

// Header-safe fallback for the legacy `filename=` param (RFC 6266 keeps the
// UTF-8 version in `filename*`).
export function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
}

export function rfc5987Value(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export type ParsedRange =
  | { offset: number; length?: number }
  | { suffix: number }

// Single-range `Range: bytes=start-end` so HTML5 <video> can seek without
// re-downloading. Suffix ranges are supported because some media clients probe
// tail metadata. Multi-range and malformed forms return undefined and fall
// through to a full-body response.
export function parseSingleRange(rangeHeader: string): ParsedRange | undefined {
  const range = rangeHeader.trim()
  let m = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (m) {
    const offset = Number(m[1])
    if (!Number.isSafeInteger(offset)) return undefined
    const endStr = m[2]
    if (!endStr) return { offset }
    const end = Number(endStr)
    if (!Number.isSafeInteger(end) || end < offset) return undefined
    return { offset, length: end - offset + 1 }
  }

  m = /^bytes=-(\d+)$/.exec(range)
  if (m) {
    const suffix = Number(m[1])
    if (Number.isSafeInteger(suffix) && suffix > 0) return { suffix }
  }
  return undefined
}

export function returnedRangeBounds(
  range: { offset?: number; length?: number; suffix?: number },
  total: number,
): { start: number; length: number } {
  if ('offset' in range && range.offset !== undefined) {
    const start = range.offset
    return { start, length: range.length ?? total - start }
  }
  if ('suffix' in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, total)
    return { start: total - length, length }
  }
  return { start: 0, length: Math.min(range.length ?? total, total) }
}

export function nonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Cloudflare always sets cf-connecting-ip on requests reaching a Worker, and it
// cannot be spoofed by the client. The previous `x-real-ip` fallback was
// unreachable in production but would have let a caller choose their own
// identity on any deployment path that didn't set cf-connecting-ip — and that
// identity gates /api/mine and the quota counters. Trust one header only.
export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown'
}

// Constant-time string comparison, so an attacker can't recover the admin key
// byte-by-byte from response-time differences. Length is not secret here (it
// leaks via the early return) — the byte values are what matter.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// True when a browser-issued cross-origin request is hitting an endpoint that
// must stay same-origin. Requests with no Origin header (curl, agents, native
// clients) are allowed through — Origin is set by browsers, and these endpoints
// are explicitly part of the documented CLI surface.
export function isForbiddenCrossOrigin(origin: string | undefined, publicOrigin: string): boolean {
  if (!origin) return false
  return origin !== publicOrigin
}
