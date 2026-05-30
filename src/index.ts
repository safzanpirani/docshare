import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import indexHtml from '../public/index.html'
import llmsTxt from '../public/llms.txt'
import ogPng from '../public/og.png'
import ogSvg from '../public/og.svg'
import { generateId, isValidId } from './id'
import { runOcr } from './ocr'
import { presignPutUrl } from './presign'
import { checkAndChargeDaily, hashIp, refundDaily } from './ratelimit'
import { addStorageUsed, reconcileStorage, withinStorageCap } from './storage'

// Hard ceiling on the simple PUT /upload/:filename route. CF Workers cap the
// request body at 100MB on Free/Pro. For files larger than this, clients must
// use the 3-step presigned flow (/api/doc/presign → PUT to R2 → /finalize).
const SIMPLE_UPLOAD_MAX = 100 * 1024 * 1024
const DEFAULT_DOC_CONTENT_TYPE = 'application/octet-stream'
const SAFE_INLINE_CONTENT_TYPES = new Set([
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

type RateLimiter = {
  limit: (opts: { key: string }) => Promise<{ success: boolean }>
}

type Bindings = {
  BUCKET: R2Bucket
  QUOTA: KVNamespace
  UPLOAD_LIMITER: RateLimiter
  DOC_LIMITER: RateLimiter
  OCR_LIMITER: RateLimiter
  GEMINI_API_KEY: string
  GEMINI_MODEL: string
  PUBLIC_ORIGIN: string
  TTL_HOURS: string
  MAX_UPLOAD_BYTES: string
  MAX_DOC_BYTES: string
  DOC_DAILY_COUNT: string
  DOC_DAILY_BYTES: string
  MAX_TOTAL_BYTES: string
  // R2 S3-API credentials for presigning (set as secrets)
  R2_ACCOUNT_ID: string
  R2_BUCKET_NAME: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

app.get('/', (c) => {
  c.header('cache-control', 'public, max-age=300')
  return c.html(indexHtml)
})

// llms.txt — see https://llmstxt.org/ — gives LLMs/agents a curated overview
// of the API so they can use docshare correctly without scraping the UI.
app.get('/llms.txt', (c) => {
  c.header('content-type', 'text/plain; charset=utf-8')
  c.header('cache-control', 'public, max-age=3600')
  return c.body(llmsTxt)
})

// Open Graph card image — Discord/Telegram/Slack fetch and cache this when
// docs.safzan.dev is pasted into a chat.
app.get('/og.svg', (c) => {
  c.header('content-type', 'image/svg+xml; charset=utf-8')
  c.header('cache-control', 'public, max-age=86400, immutable')
  return c.body(ogSvg)
})

app.get('/og.png', (c) => {
  return new Response(ogPng, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400, immutable',
    },
  })
})

// One-shot upload for files <= 100MB. Body is the raw file bytes; the response
// body is the download URL as plain text — designed to be the dumbest possible
// curl call:
//   curl -T myfile.pdf https://docs.safzan.dev/upload/myfile.pdf
// For files >100MB use the /api/doc/presign → PUT → /api/doc/finalize flow
// (the Worker request body is hard-capped at 100MB on Free/Pro plans).
app.put('/upload/:filename', async (c) => {
  const ip = clientIp(c.req.raw)
  const burst = await c.env.DOC_LIMITER.limit({ key: ip })
  if (!burst.success) return c.text('rate_limited\n', 429)

  const filenameRaw = c.req.param('filename') ?? 'file'
  let filename: string
  try { filename = sanitizeFilename(decodeURIComponent(filenameRaw)) }
  catch { filename = sanitizeFilename(filenameRaw) }
  const contentType = c.req.header('content-type') || 'application/octet-stream'

  const declared = Number(c.req.header('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared <= 0) {
    return c.text('content-length header required\n', 411)
  }
  if (declared > SIMPLE_UPLOAD_MAX) {
    return c.text(`too_large: simple upload route caps at ${SIMPLE_UPLOAD_MAX} bytes. Use POST /api/doc/presign for files up to ${c.env.MAX_DOC_BYTES} bytes.\n`, 413)
  }

  if (!(await withinStorageCap(c.env.QUOTA, declared, capBytes(c.env)))) {
    return c.text('storage_full: service storage cap reached, try again later\n', 507)
  }

  const dailyCount = Number(c.env.DOC_DAILY_COUNT) || 5
  const dailyBytes = Number(c.env.DOC_DAILY_BYTES) || 1572864000
  const quota = await checkAndChargeDaily(c.env.QUOTA, ip, declared, dailyCount, dailyBytes)
  if (!quota.ok) return c.text(`${quota.reason} (limit ${quota.limit})\n`, 429)

  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) return c.text('empty\n', 400)
  if (buf.byteLength > SIMPLE_UPLOAD_MAX) return c.text('too_large\n', 413)

  let id = generateId(16)
  if (await c.env.BUCKET.head(`doc/${id}`)) id = generateId(16)

  const uploadedAt = Date.now()
  const ttlHours = Number(c.env.TTL_HOURS) || 24
  const expiresAt = uploadedAt + ttlHours * 3600 * 1000

  await c.env.BUCKET.put(`doc/${id}`, buf, {
    httpMetadata: { contentType },
  })
  const meta = { filename, contentType, size: buf.byteLength, uploadedAt, expiresAt, finalized: true, uploaderTag: await hashIp(ip) }
  await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  })
  await addStorageUsed(c.env.QUOTA, buf.byteLength)

  const url = `${c.env.PUBLIC_ORIGIN}/d/${id}/${encodeURIComponent(filename)}`
  c.header('content-type', 'text/plain; charset=utf-8')
  return c.body(url + '\n')
})

// ----------------------------------------------------------------------------
// IMAGES — converted to WebP in the browser, posted through the Worker.
// (Identical to seeshare. Small payloads, so streaming through is fine.)
// ----------------------------------------------------------------------------
app.post('/api/upload', async (c) => {
  const ip = clientIp(c.req.raw)
  const { success } = await c.env.UPLOAD_LIMITER.limit({ key: ip })
  if (!success) return c.json({ error: 'rate_limited' }, 429)

  const max = Number(c.env.MAX_UPLOAD_BYTES) || 15 * 1024 * 1024
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared && declared > max) return c.json({ error: 'too_large', max }, 413)

  if ((c.req.header('content-type') ?? '') !== 'image/webp') {
    return c.json({ error: 'webp_required' }, 415)
  }

  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'empty' }, 400)
  if (buf.byteLength > max) return c.json({ error: 'too_large', max }, 413)
  if (!isWebp(buf)) return c.json({ error: 'webp_required' }, 415)

  if (!(await withinStorageCap(c.env.QUOTA, buf.byteLength, capBytes(c.env)))) {
    return c.json({ error: 'storage_full' }, 507)
  }

  let id = generateId(8)
  if (await c.env.BUCKET.head(`img/${id}.webp`)) id = generateId(8)

  const uploadedAt = Date.now()
  await c.env.BUCKET.put(`img/${id}.webp`, buf, {
    httpMetadata: { contentType: 'image/webp' },
    customMetadata: { uploadedAt: uploadedAt.toString(), uploaderTag: await hashIp(ip) },
  })
  await addStorageUsed(c.env.QUOTA, buf.byteLength)

  const ttlHours = Number(c.env.TTL_HOURS) || 24
  const expiresAt = uploadedAt + ttlHours * 3600 * 1000
  const url = `${c.env.PUBLIC_ORIGIN}/i/${id}.webp`

  return c.json({ id, url, uploadedAt, expiresAt, size: buf.byteLength })
})

app.get('/i/:filename{[A-Za-z0-9]+\\.webp}', async (c) => {
  const filename = c.req.param('filename')
  const obj = await c.env.BUCKET.get(`img/${filename}`)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('content-type', 'image/webp')
  headers.set('cache-control', 'public, max-age=300, s-maxage=86400, immutable')
  headers.set('x-content-type-options', 'nosniff')
  if (obj.httpEtag) headers.set('etag', obj.httpEtag)
  return new Response(obj.body, { headers })
})

app.post('/api/ocr/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'ocr_disabled' }, 503)

  const cached = await c.env.BUCKET.get(`img/${id}.ocr.json`)
  if (cached) {
    const data = await cached.json<{ text: string; ranAt: number; model: string }>()
    return c.json({ ...data, cached: true })
  }

  const ip = clientIp(c.req.raw)
  const { success } = await c.env.OCR_LIMITER.limit({ key: ip })
  if (!success) return c.json({ error: 'rate_limited' }, 429)

  const image = await c.env.BUCKET.get(`img/${id}.webp`)
  if (!image) return c.json({ error: 'not_found' }, 404)
  const bytes = await image.arrayBuffer()

  const model = c.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
  let text: string
  try {
    text = await runOcr(bytes, c.env.GEMINI_API_KEY, model)
  } catch (e) {
    return c.json({ error: 'ocr_failed', message: (e as Error).message }, 502)
  }

  const payload = { text, ranAt: Date.now(), model }
  await c.env.BUCKET.put(`img/${id}.ocr.json`, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json' },
  })
  return c.json({ ...payload, cached: false })
})

// ----------------------------------------------------------------------------
// DOCS — any non-image file. Uploaded straight to R2 via a presigned PUT URL
// so the bytes never pass through the Worker. Served back as a forced
// download so an LLM/agent can fetch the raw file.
// ----------------------------------------------------------------------------

// Step 1: reserve an id, charge the per-IP daily quota, write a metadata
// sidecar, and hand back a short-lived presigned PUT URL.
app.post('/api/doc/presign', async (c) => {
  const ip = clientIp(c.req.raw)
  const { success } = await c.env.DOC_LIMITER.limit({ key: ip })
  if (!success) return c.json({ error: 'rate_limited' }, 429)

  let body: { filename?: unknown; size?: unknown; contentType?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }

  const filename = sanitizeFilename(String(body.filename ?? 'file'))
  const size = Number(body.size ?? 0)
  const contentType = String(body.contentType ?? 'application/octet-stream')

  const maxDoc = Number(c.env.MAX_DOC_BYTES) || 100 * 1024 * 1024
  if (!Number.isFinite(size) || size <= 0) return c.json({ error: 'bad_size' }, 400)
  if (size > maxDoc) return c.json({ error: 'too_large', max: maxDoc }, 413)

  // Global storage cap. The bytes are charged to the counter at /finalize with
  // the real object size; here we only reject if the declared size wouldn't fit.
  if (!(await withinStorageCap(c.env.QUOTA, size, capBytes(c.env)))) {
    return c.json({ error: 'storage_full' }, 507)
  }

  const dailyCount = Number(c.env.DOC_DAILY_COUNT) || 5
  const dailyBytes = Number(c.env.DOC_DAILY_BYTES) || 300 * 1024 * 1024
  const quota = await checkAndChargeDaily(c.env.QUOTA, ip, size, dailyCount, dailyBytes)
  if (!quota.ok) {
    return c.json({ error: quota.reason, limit: quota.limit }, 429)
  }

  let id = generateId(16)
  if (await c.env.BUCKET.head(`doc/${id}`)) id = generateId(16)

  const uploadedAt = Date.now()
  const ttlHours = Number(c.env.TTL_HOURS) || 24
  const expiresAt = uploadedAt + ttlHours * 3600 * 1000

  const meta = { filename, contentType, size, uploadedAt, expiresAt, finalized: false, uploaderTag: await hashIp(ip) }
  await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  })

  let putUrl: string
  try {
    putUrl = await presignPutUrl(c.env, `doc/${id}`)
  } catch (e) {
    return c.json({ error: 'presign_failed', message: (e as Error).message }, 500)
  }

  const downloadUrl = `${c.env.PUBLIC_ORIGIN}/d/${id}/${encodeURIComponent(filename)}`
  return c.json({ id, putUrl, downloadUrl, filename, uploadedAt, expiresAt, size })
})

// Step 2 (optional but recommended): confirm the upload landed and enforce the
// real size. A presigned PUT can't enforce a max size, so we verify here and
// delete anything that came in over the limit.
app.post('/api/doc/finalize', async (c) => {
  let body: { id?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }
  const id = String(body.id ?? '')
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  const obj = await c.env.BUCKET.head(`doc/${id}`)
  if (!obj) return c.json({ error: 'not_found' }, 404)

  const maxDoc = Number(c.env.MAX_DOC_BYTES) || 100 * 1024 * 1024
  if (obj.size > maxDoc) {
    await c.env.BUCKET.delete(`doc/${id}`)
    await c.env.BUCKET.delete(`meta/${id}.json`)
    return c.json({ error: 'too_large', max: maxDoc }, 413)
  }

  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  let alreadyFinalized = false
  if (metaObj) {
    const meta = await metaObj.json<Record<string, unknown>>()
    alreadyFinalized = meta.finalized === true
    meta.size = obj.size
    meta.finalized = true
    await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json' },
    })
  }
  // Charge the global storage counter with the real object size, exactly once
  // (finalize is idempotent — a re-finalize must not double-count).
  if (!alreadyFinalized) await addStorageUsed(c.env.QUOTA, obj.size)
  return c.json({ id, size: obj.size, finalized: true })
})

// Download / inline-serve. The :filename segment is cosmetic (so curl/agents
// save a sensible name); the id is the real key.
//
// Serving everything as `attachment` blocks stored-XSS via .html/.svg uploads,
// but it also stops Discord/Telegram from auto-playing video embeds and stops
// the browser from previewing images. Compromise: known-safe browser media
// types get `inline`; everything else stays `attachment` + nosniff.
app.get('/d/:id/:filename', serveDoc)
app.get('/d/:id', serveDoc)

async function serveDoc(c: Context<{ Bindings: Bindings }>) {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  let filename = id
  let contentType = DEFAULT_DOC_CONTENT_TYPE
  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  if (metaObj) {
    const meta = await metaObj.json<{ filename?: string; contentType?: string }>()
    if (meta.filename) filename = sanitizeFilename(meta.filename)
    if (meta.contentType) contentType = normalizeContentType(meta.contentType)
  }

  const inline = shouldServeInline(contentType)

  // Parse a single-range `Range: bytes=start-end` header so HTML5 <video> can
  // seek without re-downloading. Suffix ranges are supported because some
  // media clients probe tail metadata. Multi-range and malformed forms fall
  // through to a full-body response.
  const rangeHeader = c.req.header('range')
  let rangeOpts: R2GetOptions['range'] | undefined
  if (inline && rangeHeader) {
    rangeOpts = parseSingleRange(rangeHeader)
  }

  const obj = rangeOpts
    ? await c.env.BUCKET.get(`doc/${id}`, { range: rangeOpts })
    : await c.env.BUCKET.get(`doc/${id}`)
  if (!obj) return c.notFound()

  const headers = new Headers()
  headers.set('content-type', contentType)
  const disposition = inline ? 'inline' : 'attachment'
  headers.set('content-disposition', `${disposition}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${rfc5987Value(filename)}`)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('cache-control', 'public, max-age=300, immutable')
  if (inline) headers.set('accept-ranges', 'bytes')
  if (obj.httpEtag) headers.set('etag', obj.httpEtag)

  // 206 Partial Content when a Range was honoured.
  if (rangeOpts && obj.range) {
    const total = obj.size
    const { start, length } = returnedRangeBounds(obj.range, total)
    if (length <= 0 || start >= total) {
      headers.set('content-range', `bytes */${total}`)
      headers.delete('content-length')
      return new Response(null, { status: 416, headers })
    }
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${total}`)
    headers.set('content-length', String(length))
    return new Response(obj.body, { status: 206, headers })
  }

  headers.set('content-length', String(obj.size))
  return new Response(obj.body, { headers })
}

// Allow only known browser media types to render inline. Broad image/* is too
// permissive for this origin because SVG and future active media types would
// otherwise be controlled by client-declared metadata.
function shouldServeInline(contentType: string): boolean {
  return SAFE_INLINE_CONTENT_TYPES.has(normalizeContentType(contentType))
}

function normalizeContentType(contentType: string): string {
  const ct = String(contentType).toLowerCase().split(';')[0].trim()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(ct)
    ? ct
    : DEFAULT_DOC_CONTENT_TYPE
}

function parseSingleRange(rangeHeader: string): R2GetOptions['range'] | undefined {
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

function returnedRangeBounds(range: R2Range, total: number): { start: number; length: number } {
  if ('offset' in range) {
    const start = range.offset ?? 0
    return { start, length: range.length ?? total - start }
  }
  if ('suffix' in range) {
    const length = Math.min(range.suffix, total)
    return { start: total - length, length }
  }
  return { start: 0, length: Math.min(range.length, total) }
}

// Metadata for either an image (id) or a doc (id).
app.get('/api/info/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  const ttlHours = Number(c.env.TTL_HOURS) || 24

  const img = await c.env.BUCKET.head(`img/${id}.webp`)
  if (img) {
    const uploadedAt = Number(img.customMetadata?.uploadedAt ?? img.uploaded.getTime())
    return c.json({
      id,
      kind: 'image',
      size: img.size,
      uploadedAt,
      expiresAt: uploadedAt + ttlHours * 3600 * 1000,
    })
  }

  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  if (metaObj) {
    const meta = await metaObj.json<Record<string, unknown>>()
    // uploaderTag is internal (used to authorise quota refunds) — never expose.
    delete meta.uploaderTag
    return c.json({ id, kind: 'doc', ...meta })
  }

  return c.json({ error: 'not_found' }, 404)
})

// Delete an image or doc by id. The link/id is the capability — anyone holding
// it can delete the file (no accounts exist). Frees the global storage counter
// and refunds the original uploader's daily quota when they delete a file they
// uploaded today (see refundDaily).
app.post('/api/delete', async (c) => {
  const ip = clientIp(c.req.raw)
  let body: { id?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }
  const id = String(body.id ?? '')
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  const img = await c.env.BUCKET.head(`img/${id}.webp`)
  if (img) {
    const size = img.size
    const uploadedAt = Number(img.customMetadata?.uploadedAt ?? img.uploaded.getTime())
    const uploaderTag = img.customMetadata?.uploaderTag
    await c.env.BUCKET.delete(`img/${id}.webp`)
    await c.env.BUCKET.delete(`img/${id}.ocr.json`)
    await addStorageUsed(c.env.QUOTA, -size)
    await refundDaily(c.env.QUOTA, ip, size, uploadedAt, uploaderTag)
    return c.json({ deleted: true, kind: 'image' })
  }

  const doc = await c.env.BUCKET.head(`doc/${id}`)
  if (doc) {
    const size = doc.size
    let uploadedAt = 0
    let uploaderTag: string | undefined
    let finalized = false
    const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
    if (metaObj) {
      const meta = await metaObj.json<Record<string, unknown>>()
      uploadedAt = Number(meta.uploadedAt ?? 0)
      uploaderTag = typeof meta.uploaderTag === 'string' ? meta.uploaderTag : undefined
      finalized = meta.finalized === true
    }
    await c.env.BUCKET.delete(`doc/${id}`)
    await c.env.BUCKET.delete(`meta/${id}.json`)
    // Only un-charge bytes the counter was actually charged (docs are charged
    // at /finalize). An un-finalized orphan never hit the counter.
    if (finalized) await addStorageUsed(c.env.QUOTA, -size)
    await refundDaily(c.env.QUOTA, ip, size, uploadedAt, uploaderTag)
    return c.json({ deleted: true, kind: 'doc' })
  }

  return c.json({ error: 'not_found' }, 404)
})

// ----------------------------------------------------------------------------
function capBytes(env: Bindings): number {
  return Number(env.MAX_TOTAL_BYTES) || 9_000_000_000
}

function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

function isWebp(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false
  const b = new Uint8Array(buf, 0, 12)
  return (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
}

// Strip path separators and control chars; keep a reasonable filename.
function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return (cleaned || 'file').slice(0, 200)
}

// Header-safe fallback for the legacy `filename=` param (RFC 6266 keeps the
// UTF-8 version in `filename*`).
function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
}

function rfc5987Value(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  // Cron (see wrangler.toml [triggers]): re-sum the bucket so storage that the
  // 24h lifecycle rule deleted gets subtracted from the counter.
  scheduled: (_event: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(reconcileStorage(env.QUOTA, env.BUCKET))
  },
}
