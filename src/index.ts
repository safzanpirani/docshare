import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import indexHtml from '../public/index.html'
import llmsTxt from '../public/llms.txt'
import { generateId, isValidId } from './id'
import { runOcr } from './ocr'
import { presignPutUrl } from './presign'
import { checkAndChargeDaily } from './ratelimit'

// Hard ceiling on the simple PUT /upload/:filename route. CF Workers cap the
// request body at 100MB on Free/Pro. For files larger than this, clients must
// use the 3-step presigned flow (/api/doc/presign → PUT to R2 → /finalize).
const SIMPLE_UPLOAD_MAX = 100 * 1024 * 1024

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
  const meta = { filename, contentType, size: buf.byteLength, uploadedAt, expiresAt, finalized: true }
  await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  })

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

  let id = generateId(8)
  if (await c.env.BUCKET.head(`img/${id}.webp`)) id = generateId(8)

  const uploadedAt = Date.now()
  await c.env.BUCKET.put(`img/${id}.webp`, buf, {
    httpMetadata: { contentType: 'image/webp' },
    customMetadata: { uploadedAt: uploadedAt.toString() },
  })

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

  const meta = { filename, contentType, size, uploadedAt, expiresAt, finalized: false }
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
  if (metaObj) {
    const meta = await metaObj.json<Record<string, unknown>>()
    meta.size = obj.size
    meta.finalized = true
    await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json' },
    })
  }
  return c.json({ id, size: obj.size, finalized: true })
})

// Download — forced attachment, never inline. The :filename segment is
// cosmetic (so curl/agents save a sensible name); the id is the real key.
app.get('/d/:id/:filename', serveDoc)
app.get('/d/:id', serveDoc)

async function serveDoc(c: Context<{ Bindings: Bindings }>) {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  const obj = await c.env.BUCKET.get(`doc/${id}`)
  if (!obj) return c.notFound()

  let filename = id
  let contentType = 'application/octet-stream'
  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  if (metaObj) {
    const meta = await metaObj.json<{ filename?: string; contentType?: string }>()
    if (meta.filename) filename = sanitizeFilename(meta.filename)
    if (meta.contentType) contentType = meta.contentType
  }

  const headers = new Headers()
  // Force download. Serving arbitrary user files inline on our origin would be
  // a stored-XSS vector (malicious .html/.svg). attachment + nosniff blocks it.
  headers.set('content-type', contentType)
  headers.set('content-disposition', `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  headers.set('x-content-type-options', 'nosniff')
  headers.set('cache-control', 'public, max-age=300, immutable')
  if (obj.httpEtag) headers.set('etag', obj.httpEtag)
  return new Response(obj.body, { headers })
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
    return c.json({ id, kind: 'doc', ...meta })
  }

  return c.json({ error: 'not_found' }, 404)
})

// ----------------------------------------------------------------------------
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

export default app
