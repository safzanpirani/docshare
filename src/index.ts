import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import indexHtml from '../public/index.html'
import llmsTxt from '../public/llms.txt'
import ogPng from '../public/og.png'
import ogSvg from '../public/og.svg'
import icon192 from '../public/icon-192.png'
import icon512 from '../public/icon-512.png'
import { generateId, isValidId } from './id'
import { runOcr } from './ocr'
import { presignPutUrl } from './presign'
import { checkAndChargeDaily, hashIp, readDailyUsage, refundChargedDaily, refundDaily } from './ratelimit'
import { addStorageUsed, getStorageUsed, reconcileStorage, withinStorageCap } from './storage'

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
  // Optional shared password that lets the owner bypass the per-IP daily cap.
  // Set as a secret; unset means no bypass exists.
  ADMIN_KEY: string
}

// True when the request carries the owner's admin password, granting a bypass
// of the per-IP daily upload cap. A blank/unset ADMIN_KEY means no bypass.
function isAdmin(c: { env: Bindings; req: { header: (n: string) => string | undefined } }): boolean {
  const key = c.env.ADMIN_KEY
  if (!key) return false
  return c.req.header('x-admin-key') === key
}

type DocMeta = {
  filename?: string
  contentType?: string
  size?: number
  chargedSize?: number
  uploadedAt?: number
  expiresAt?: number
  finalized?: boolean
  uploaderTag?: string
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

// ---- PWA: manifest, icons, and a minimal service worker (installable + an
// Android/desktop share target that drops shared text/links into a snippet). ----
const pngHeaders = { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400, immutable' }
app.get('/icon-192.png', () => new Response(icon192, { headers: pngHeaders }))
app.get('/icon-512.png', () => new Response(icon512, { headers: pngHeaders }))

app.get('/manifest.webmanifest', (c) => {
  c.header('content-type', 'application/manifest+json; charset=utf-8')
  c.header('cache-control', 'public, max-age=3600')
  return c.body(JSON.stringify({
    name: 'docshare', short_name: 'docshare',
    description: 'Share files, images & video with coding agents. 24h auto-delete.',
    start_url: '/', scope: '/', display: 'standalone',
    background_color: '#0b0a10', theme_color: '#a78bfa',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
    // GET share target: shared text/links land as ?text/?url and become a
    // snippet upload on load. (File sharing would need a POST + SW handler.)
    share_target: { action: '/', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
  }))
})

app.get('/sw.js', (c) => {
  c.header('content-type', 'application/javascript; charset=utf-8')
  c.header('cache-control', 'no-cache')
  // No caching (this is a 24h-ephemeral tool — stale shells would be worse than
  // a network round-trip). The empty fetch handler just satisfies the install
  // criteria so the browser offers "Install app".
  return c.body(
    "self.addEventListener('install',e=>self.skipWaiting());" +
    "self.addEventListener('activate',e=>self.clients.claim());" +
    "self.addEventListener('fetch',()=>{});"
  )
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

  const dailyCount = Number(c.env.DOC_DAILY_COUNT) || 10
  const dailyBytes = Number(c.env.DOC_DAILY_BYTES) || 1572864000
  const charged = !isAdmin(c)
  if (charged) {
    const quota = await checkAndChargeDaily(c.env.QUOTA, ip, declared, dailyCount, dailyBytes)
    if (!quota.ok) return c.text(`${quota.reason} (limit ${quota.limit})\n`, 429)
  }
  const refund = async () => { if (charged) await refundChargedDaily(c.env.QUOTA, ip, declared) }

  let id = ''
  let storageCharged = 0
  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) {
    await refund()
    return c.text('empty\n', 400)
  }
  if (buf.byteLength > SIMPLE_UPLOAD_MAX) {
    await refund()
    return c.text('too_large\n', 413)
  }
  if (!(await withinStorageCap(c.env.QUOTA, buf.byteLength, capBytes(c.env)))) {
    await refund()
    return c.text('storage_full: service storage cap reached, try again later\n', 507)
  }

  id = generateId(16)
  if (await c.env.BUCKET.head(`doc/${id}`)) id = generateId(16)

  const uploadedAt = Date.now()
  const ttlHours = Number(c.env.TTL_HOURS) || 24
  const expiresAt = uploadedAt + ttlHours * 3600 * 1000

  try {
    await c.env.BUCKET.put(`doc/${id}`, buf, {
      httpMetadata: { contentType },
    })
    const meta: DocMeta = {
      filename,
      contentType,
      size: buf.byteLength,
      chargedSize: declared,
      uploadedAt,
      expiresAt,
      finalized: true,
      uploaderTag: await hashIp(ip),
    }
    await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json' },
    })
    await addStorageUsed(c.env.QUOTA, buf.byteLength)
    storageCharged = buf.byteLength
  } catch (e) {
    await refund()
    if (storageCharged > 0) await addStorageUsed(c.env.QUOTA, -storageCharged)
    if (id) {
      await c.env.BUCKET.delete(`doc/${id}`)
      await c.env.BUCKET.delete(`meta/${id}.json`)
    }
    throw e
  }

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
  const admin = isAdmin(c)
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared && declared > max && !admin) return c.json({ error: 'too_large', max }, 413)

  if ((c.req.header('content-type') ?? '') !== 'image/webp') {
    return c.json({ error: 'webp_required' }, 415)
  }

  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'empty' }, 400)
  if (buf.byteLength > max && !admin) return c.json({ error: 'too_large', max }, 413)
  if (!isWebp(buf)) return c.json({ error: 'webp_required' }, 415)

  if (!(await withinStorageCap(c.env.QUOTA, buf.byteLength, capBytes(c.env)))) {
    return c.json({ error: 'storage_full' }, 507)
  }

  let id = generateId(8)
  if (await c.env.BUCKET.head(`img/${id}.webp`)) id = generateId(8)

  const uploadedAt = Date.now()
  let storageCharged = 0
  try {
    await c.env.BUCKET.put(`img/${id}.webp`, buf, {
      httpMetadata: { contentType: 'image/webp' },
      customMetadata: { uploadedAt: uploadedAt.toString(), uploaderTag: await hashIp(ip) },
    })
    await addStorageUsed(c.env.QUOTA, buf.byteLength)
    storageCharged = buf.byteLength
  } catch (e) {
    if (storageCharged > 0) await addStorageUsed(c.env.QUOTA, -storageCharged)
    await c.env.BUCKET.delete(`img/${id}.webp`)
    throw e
  }

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
  if (size > maxDoc && !isAdmin(c)) return c.json({ error: 'too_large', max: maxDoc }, 413)

  // Global storage cap. The bytes are charged to the counter at /finalize with
  // the real object size; here we only reject if the declared size wouldn't fit.
  if (!(await withinStorageCap(c.env.QUOTA, size, capBytes(c.env)))) {
    return c.json({ error: 'storage_full' }, 507)
  }

  let id = generateId(16)
  if (await c.env.BUCKET.head(`doc/${id}`)) id = generateId(16)

  const uploadedAt = Date.now()
  const ttlHours = Number(c.env.TTL_HOURS) || 24
  const expiresAt = uploadedAt + ttlHours * 3600 * 1000

  let putUrl: string
  try {
    putUrl = await presignPutUrl(c.env, `doc/${id}`)
  } catch (e) {
    return c.json({ error: 'presign_failed', message: (e as Error).message }, 500)
  }

  const uploaderTag = await hashIp(ip)
  const dailyCount = Number(c.env.DOC_DAILY_COUNT) || 10
  const dailyBytes = Number(c.env.DOC_DAILY_BYTES) || 300 * 1024 * 1024
  const charged = !isAdmin(c)
  if (charged) {
    const quota = await checkAndChargeDaily(c.env.QUOTA, ip, size, dailyCount, dailyBytes)
    if (!quota.ok) {
      return c.json({ error: quota.reason, limit: quota.limit }, 429)
    }
  }

  const meta: DocMeta = {
    filename,
    contentType,
    size,
    chargedSize: size,
    uploadedAt,
    expiresAt,
    finalized: false,
    uploaderTag,
  }
  try {
    await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json' },
    })
  } catch (e) {
    if (charged) await refundChargedDaily(c.env.QUOTA, ip, size)
    throw e
  }

  const downloadUrl = `${c.env.PUBLIC_ORIGIN}/d/${id}/${encodeURIComponent(filename)}`
  return c.json({ id, putUrl, downloadUrl, filename, uploadedAt, expiresAt, size })
})

// Step 2 (optional but recommended): confirm the upload landed and enforce the
// real size. A presigned PUT can't enforce a max size, so we verify here and
// delete anything that came in over the limit.
app.post('/api/doc/finalize', async (c) => {
  const ip = clientIp(c.req.raw)
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

  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  const meta = metaObj ? await metaObj.json<DocMeta>() : undefined
  if (!meta) {
    await c.env.BUCKET.delete(`doc/${id}`)
    return c.json({ error: 'not_found' }, 404)
  }
  const alreadyFinalized = meta?.finalized === true
  const previousFinalizedSize = alreadyFinalized ? nonNegative(meta?.size) : 0
  const chargedSize = chargedDocSize(meta, obj.size)
  const uploadedAt = Number(meta?.uploadedAt ?? 0)
  const uploaderTag = typeof meta?.uploaderTag === 'string' ? meta.uploaderTag : undefined

  const maxDoc = Number(c.env.MAX_DOC_BYTES) || 100 * 1024 * 1024
  if (obj.size > maxDoc && !isAdmin(c)) {
    await c.env.BUCKET.delete(`doc/${id}`)
    await c.env.BUCKET.delete(`meta/${id}.json`)
    if (previousFinalizedSize > 0) await addStorageUsed(c.env.QUOTA, -previousFinalizedSize)
    await refundDaily(c.env.QUOTA, ip, chargedSize, uploadedAt, uploaderTag)
    return c.json({ error: 'too_large', max: maxDoc }, 413)
  }

  const storageDelta = obj.size - previousFinalizedSize
  if (storageDelta > 0 && !(await withinStorageCap(c.env.QUOTA, storageDelta, capBytes(c.env)))) {
    await c.env.BUCKET.delete(`doc/${id}`)
    await c.env.BUCKET.delete(`meta/${id}.json`)
    if (previousFinalizedSize > 0) await addStorageUsed(c.env.QUOTA, -previousFinalizedSize)
    await refundDaily(c.env.QUOTA, ip, chargedSize, uploadedAt, uploaderTag)
    return c.json({ error: 'storage_full' }, 507)
  }

  let storageAdjusted = 0
  try {
    if (storageDelta !== 0) {
      await addStorageUsed(c.env.QUOTA, storageDelta)
      storageAdjusted = storageDelta
    }
    meta.size = obj.size
    meta.chargedSize = chargedSize
    meta.finalized = true
    await c.env.BUCKET.put(`meta/${id}.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json' },
    })
  } catch (e) {
    if (storageAdjusted !== 0) await addStorageUsed(c.env.QUOTA, -storageAdjusted)
    throw e
  }
  // Charge the global storage counter with the real object size. Re-finalize is
  // idempotent unless the still-valid presigned PUT overwrote the same key; then
  // adjust by the size delta.
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

  // Text/code/markdown files get a styled full-page viewer when opened in a
  // browser (Accept: text/html). `?raw=1` serves the plain text (git-raw
  // style) and `?dl=1` forces a download — both are what agents/curl hit, so
  // programmatic clients (no text/html in Accept) always get the raw bytes.
  const rawParam = c.req.query('raw') != null
  const dlParam = c.req.query('dl') != null
  const isText = isViewableText(filename, contentType)
  const isPdf = fileExt(filename) === 'pdf' || normalizeContentType(contentType) === 'application/pdf'
  const wantsHtml = (c.req.header('accept') || '').includes('text/html')
  if ((isText || isPdf) && wantsHtml && !rawParam && !dlParam) {
    // `Vary: Accept` is essential: this URL returns HTML to browsers but raw
    // bytes to `curl`/agents, so caches must key on Accept — otherwise a cached
    // download variant gets replayed to a browser (shows up as a spurious
    // download when clicking "View").
    return c.html(viewerPage(id, filename, contentType), 200, {
      'cache-control': 'public, max-age=300',
      vary: 'Accept',
    })
  }

  // When serving raw text, coerce the type to text/plain so a mislabelled
  // .html/.svg upload can never execute as active content.
  if (isText && rawParam) contentType = 'text/plain; charset=utf-8'

  const inline = !dlParam && (shouldServeInline(contentType) || (isText && rawParam))

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
  headers.set('vary', 'Accept') // same URL varies HTML-viewer vs raw bytes by Accept
  headers.set('access-control-allow-origin', '*') // let pulp (and any tool) fetch the raw bytes
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

// Extensions we're happy to render in the in-browser text viewer. Uploaded
// code/markdown often arrives as application/octet-stream (browsers don't
// know the type), so extension is the reliable signal. Deliberately does NOT
// include binary formats.
const TEXT_EXTENSIONS = new Set([
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

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

function fileExt(filename: string): string {
  const base = filename.toLowerCase().split('/').pop() || ''
  if (!base.includes('.')) return base // e.g. Dockerfile, Makefile
  return base.slice(base.lastIndexOf('.') + 1)
}

function isViewableText(filename: string, contentType: string): boolean {
  const ct = normalizeContentType(contentType)
  if (ct.startsWith('text/') || ct === 'application/json' || ct === 'application/xml') return true
  return TEXT_EXTENSIONS.has(fileExt(filename))
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ))
}

// Full-page text/markdown/code viewer. The raw bytes are fetched client-side
// from `?raw=1` (same origin) so this shell can be cached and the content
// stays a single source of truth. Markdown is rendered + sanitised; other
// text is shown as syntax-highlighted <pre>. Libraries load from the same
// CDNs the main app already uses.
function viewerPage(id: string, filename: string, contentType: string): string {
  const ext = fileExt(filename)
  const ct = normalizeContentType(contentType)
  const isMd = MARKDOWN_EXTENSIONS.has(ext) || ct === 'text/markdown'
  const isPdf = ext === 'pdf' || ct === 'application/pdf'
  const isCsv = ext === 'csv' || ext === 'tsv' || ct === 'text/csv'
  const isDiff = ext === 'diff' || ext === 'patch'
  const kind = isPdf ? 'pdf' : isCsv ? 'csv' : isDiff ? 'diff' : 'text'
  // csv → table, diff → colorized, markdown/.txt → rendered; code/data → source.
  // The "rendered" view can always be flipped to raw source with the toggle.
  const defaultMode =
    kind === 'text' ? (isMd || ext === 'txt' || ext === 'text' ? 'rendered' : 'source') : 'rendered'
  const cfg = JSON.stringify({ filename, ext, defaultMode, kind }).replace(/</g, '\\u003c')
  const title = htmlEscape(filename)
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github-dark.min.css">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0f; color: #e6e6ee;
    font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; z-index: 5; display: flex; gap: 12px; align-items: center;
    padding: 12px 18px; background: #14141b; border-bottom: 1px solid #26263a; }
  header .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-sans-serif, system-ui, sans-serif; }
  header .spacer { flex: 1 1 auto; }
  header a { color: #c9c9e0; text-decoration: none; font-size: 13px; padding: 6px 12px;
    border: 1px solid #35354d; border-radius: 8px; background: #1c1c27;
    font-family: ui-sans-serif, system-ui, sans-serif; white-space: nowrap; }
  header a:hover { background: #262636; }
  header a.home { border: none; background: none; color: #8b8bb0; padding: 6px 4px; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 18px 64px; }
  pre { margin: 0; padding: 18px; background: #12121a; border: 1px solid #23233a; border-radius: 10px;
    overflow-x: auto; font-size: 13px; }
  pre code { background: none; padding: 0; }
  .md { font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.7; }
  .md h1, .md h2 { border-bottom: 1px solid #26263a; padding-bottom: .3em; }
  .md h1, .md h2, .md h3, .md h4 { margin-top: 1.4em; }
  .md code { background: #1c1c27; padding: .15em .4em; border-radius: 5px; font-size: .9em; }
  .md pre { font-family: ui-monospace, monospace; }
  .md pre code { background: none; }
  .md a { color: #9a9aff; }
  .md blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid #35354d; color: #b3b3c9; }
  .md table { border-collapse: collapse; } .md th, .md td { border: 1px solid #2a2a40; padding: 6px 10px; }
  .md img { max-width: 100%; }
  .pdf { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .pdf canvas { max-width: 100%; height: auto; border: 1px solid #23233a; border-radius: 6px;
    background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.45); }
  table.csv { border-collapse: collapse; font-family: ui-monospace, monospace; font-size: 12.5px; }
  table.csv th, table.csv td { border: 1px solid #262638; padding: 5px 9px; text-align: left; white-space: pre; }
  table.csv thead th { position: sticky; top: 49px; background: #171722; font-weight: 600; }
  table.csv tbody tr:nth-child(2n) { background: #101018; }
  .diff { padding: 14px 0; }
  .diff .l { display: block; padding: 0 14px; white-space: pre-wrap; word-break: break-word; }
  .diff .add { background: rgba(60,160,90,.16); color: #b7f0c6; }
  .diff .del { background: rgba(200,70,70,.16); color: #f2b8b8; }
  .diff .hunk { color: #7aa2ff; background: #14141f; }
  .diff .meta { color: #8b8bb0; }
  .menu { position: relative; }
  .menu .items { position: absolute; right: 0; top: calc(100% + 6px); display: none; flex-direction: column;
    background: #17171f; border: 1px solid #35354d; border-radius: 8px; overflow: hidden; min-width: 150px; z-index: 10; }
  .menu.open .items { display: flex; }
  .menu .items a { border: none; border-radius: 0; background: none; padding: 9px 14px; }
  .menu .items a:hover { background: #262636; }
  .loading { color: #7a7a99; padding: 24px 0; }
</style>
</head><body>
<header>
  <a class="home" href="/">&larr; docshare</a>
  <span class="name" id="fname"></span>
  <span class="spacer"></span>
  <span id="pulp" class="menu" style="display:none"></span>
  <a href="#" id="toggle" role="button"></a>
  <a href="?raw=1">Raw</a>
  <a href="?dl=1">Download</a>
</header>
<main id="main"><div class="loading">Loading…</div></main>
<script id="cfg" type="application/json">${cfg}</script>
<script type="module">
  const cfg = JSON.parse(document.getElementById('cfg').textContent)
  document.getElementById('fname').textContent = cfg.filename
  const main = document.getElementById('main')
  const toggle = document.getElementById('toggle')
  const esc = (s) => s.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')
  let raw = null // string for text/csv/diff, ArrayBuffer for pdf
  let mode = cfg.defaultMode // 'rendered' | 'source' (n/a for pdf)

  async function renderMd(t) {
    const [{ marked }, DOMPurify] = await Promise.all([
      import('https://esm.sh/marked@12'),
      import('https://esm.sh/dompurify@3').then((m) => m.default),
    ])
    const div = document.createElement('div')
    div.className = 'md'
    div.innerHTML = DOMPurify.sanitize(marked.parse(t, { breaks: true }))
    return div
  }
  async function renderSource(t) {
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = t
    pre.appendChild(code)
    try {
      const hljs = (await import('https://esm.sh/highlight.js@11.10.0/lib/common')).default
      const lang = hljs.getLanguage(cfg.ext) ? cfg.ext : null
      code.innerHTML = lang
        ? hljs.highlight(t, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(t).value
      code.classList.add('hljs')
    } catch {}
    return pre
  }
  async function renderPdf(buf) {
    const pdfjs = await import('https://esm.sh/pdfjs-dist@4.7.76/build/pdf.min.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs'
    const doc = await pdfjs.getDocument({ data: buf }).promise
    const wrap = document.createElement('div')
    wrap.className = 'pdf'
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssW = Math.min(900, main.clientWidth || 900)
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: (cssW / base.width) * dpr })
      const canvas = document.createElement('canvas')
      canvas.width = vp.width
      canvas.height = vp.height
      canvas.style.width = (vp.width / dpr) + 'px'
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
      wrap.appendChild(canvas)
    }
    return wrap
  }
  function parseTable(t) {
    const rows = []; let row = []; let field = ''; let q = false
    const s = t.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n')
    const sep = cfg.ext === 'tsv' ? '\\t' : ','
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++ } else q = false } else field += c }
      else if (c === '"') q = true
      else if (c === sep) { row.push(field); field = '' }
      else if (c === '\\n') { row.push(field); rows.push(row); row = []; field = '' }
      else field += c
    }
    if (field.length || row.length) { row.push(field); rows.push(row) }
    return rows.filter((r) => r.some((x) => x !== ''))
  }
  function renderCsv(t) {
    const rows = parseTable(t)
    const table = document.createElement('table')
    table.className = 'csv'
    const cap = 2000
    const body = document.createElement('tbody')
    rows.slice(0, cap).forEach((r, i) => {
      const tr = document.createElement('tr')
      r.forEach((cell) => { const td = document.createElement(i === 0 ? 'th' : 'td'); td.textContent = cell; tr.appendChild(td) })
      if (i === 0) { const head = document.createElement('thead'); head.appendChild(tr); table.appendChild(head) }
      else body.appendChild(tr)
    })
    table.appendChild(body)
    const wrap = document.createElement('div')
    wrap.style.overflowX = 'auto'
    wrap.appendChild(table)
    if (rows.length > cap) { const n = document.createElement('p'); n.className = 'loading'; n.textContent = 'showing first ' + cap + ' of ' + rows.length + ' rows'; wrap.appendChild(n) }
    return wrap
  }
  function renderDiff(t) {
    const pre = document.createElement('pre')
    pre.className = 'diff'
    for (const line of t.split('\\n')) {
      const span = document.createElement('span')
      span.className = 'l'
      if (line.startsWith('@@')) span.classList.add('hunk')
      else if (/^(\\+\\+\\+|---|diff |index )/.test(line)) span.classList.add('meta')
      else if (line[0] === '+') span.classList.add('add')
      else if (line[0] === '-') span.classList.add('del')
      span.textContent = line || ' '
      pre.appendChild(span)
    }
    return pre
  }
  async function renderRendered(t) {
    if (cfg.kind === 'csv') return renderCsv(t)
    if (cfg.kind === 'diff') return renderDiff(t)
    return renderMd(t)
  }
  async function render() {
    main.innerHTML = '<div class="loading">Loading…</div>'
    try {
      if (raw == null) {
        const res = await fetch(location.pathname + '?raw=1')
        if (!res.ok) throw new Error(res.status)
        raw = cfg.kind === 'pdf' ? await res.arrayBuffer() : await res.text()
      }
      let el
      if (cfg.kind === 'pdf') el = await renderPdf(raw.slice(0))
      else el = mode === 'source' ? await renderSource(raw) : await renderRendered(raw)
      main.replaceChildren(el)
    } catch (e) {
      main.innerHTML = '<pre>Could not load file (' + esc(String(e && e.message || e)) + ')</pre>'
    }
  }
  // rendered ⇄ source toggle (hidden for pdf, which has one view)
  if (cfg.kind === 'pdf') {
    toggle.style.display = 'none'
  } else {
    const renderedLabel = cfg.kind === 'csv' ? 'Table' : cfg.kind === 'diff' ? 'Diff' : 'Rendered'
    const setLabel = () => { toggle.textContent = mode === 'source' ? renderedLabel : 'Source' }
    toggle.addEventListener('click', (e) => {
      e.preventDefault()
      mode = mode === 'source' ? 'rendered' : 'source'
      setLabel()
      render()
    })
    setLabel()
  }

  // "Open in pulp" — deep-link this file into a matching pulp tool (pulp fetches
  // the raw bytes via ?src=; /d/ sends Access-Control-Allow-Origin so it can).
  const PULP_TOOLS = {
    pdf: [['organize', 'Organize'], ['compress', 'Compress'], ['edit-text', 'Edit text'], ['split', 'Split']],
    csv: [['csv-to-pdf', 'CSV → PDF']],
    tsv: [['csv-to-pdf', 'CSV → PDF']],
  }
  const targets = PULP_TOOLS[cfg.ext]
  if (targets) {
    const rawUrl = location.origin + location.pathname + '?raw=1'
    const menu = document.getElementById('pulp')
    menu.style.display = ''
    const btn = document.createElement('a')
    btn.href = '#'
    btn.textContent = 'Open in pulp ▾'
    const items = document.createElement('div')
    items.className = 'items'
    for (const [slug, label] of targets) {
      const a = document.createElement('a')
      a.href = 'https://pulp.subintern.com/' + slug + '?src=' + encodeURIComponent(rawUrl)
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = label
      items.appendChild(a)
    }
    menu.appendChild(btn)
    menu.appendChild(items)
    btn.addEventListener('click', (e) => { e.preventDefault(); menu.classList.toggle('open') })
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('open') })
  }

  render()
</script>
</body></html>`
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

// Usage for the requester (their daily quota) + the shared storage cap. Used
// by the UI's usage bars. Read-only — never charges anything.
app.get('/api/usage', async (c) => {
  const ip = clientIp(c.req.raw)
  const [used, daily] = await Promise.all([
    getStorageUsed(c.env.QUOTA),
    readDailyUsage(c.env.QUOTA, ip),
  ])
  return c.json({
    storage: { used, cap: capBytes(c.env) },
    daily: {
      count: daily.count,
      countMax: Number(c.env.DOC_DAILY_COUNT) || 10,
      bytes: daily.bytes,
      bytesMax: Number(c.env.DOC_DAILY_BYTES) || 1572864000,
    },
  })
})

// List uploads the caller can claim: everything with an uploaderTag matching
// the caller's IP (so all devices sharing a public IP see the same list), or —
// when the owner sends the admin password — every upload on the instance. Lets
// a secondary device see and delete uploads it never had in local history.
// Personal-scale instance: a bounded full-bucket scan is fine here.
app.get('/api/mine', async (c) => {
  const ip = clientIp(c.req.raw)
  const admin = isAdmin(c)
  const myTag = await hashIp(ip)
  const ttlHours = Number(c.env.TTL_HOURS) || 24
  const mine = (tag: unknown) => admin || (typeof tag === 'string' && tag === myTag)

  const items: Array<Record<string, unknown>> = []
  const SCAN_CAP = 5000 // safety bound on objects scanned per prefix

  // Docs: metadata lives in meta/{id}.json; only surface finalized uploads.
  let cursor: string | undefined
  let scanned = 0
  do {
    const listed = await c.env.BUCKET.list({ prefix: 'meta/', cursor, limit: 1000 })
    for (const obj of listed.objects) {
      if (++scanned > SCAN_CAP) break
      const id = obj.key.slice('meta/'.length).replace(/\.json$/, '')
      if (!isValidId(id)) continue
      const metaObj = await c.env.BUCKET.get(obj.key)
      if (!metaObj) continue
      const meta = await metaObj.json<DocMeta>().catch(() => undefined)
      if (!meta || meta.finalized !== true) continue
      if (!mine(meta.uploaderTag)) continue
      const filename = meta.filename || id
      items.push({
        kind: 'doc', id, filename,
        contentType: meta.contentType || 'application/octet-stream',
        size: meta.size || 0,
        uploadedAt: meta.uploadedAt || 0,
        expiresAt: meta.expiresAt || 0,
        url: `${c.env.PUBLIC_ORIGIN}/d/${id}/${encodeURIComponent(filename)}`,
      })
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor && scanned <= SCAN_CAP)

  // Images: uploaderTag lives in R2 customMetadata; skip OCR sidecar objects.
  cursor = undefined
  scanned = 0
  do {
    // include:['customMetadata'] is supported at runtime but missing from the
    // pinned R2ListOptions types — cast to reach it.
    const listed = await c.env.BUCKET.list({ prefix: 'img/', cursor, limit: 1000, include: ['customMetadata'] } as R2ListOptions)
    for (const obj of listed.objects) {
      if (++scanned > SCAN_CAP) break
      if (!obj.key.endsWith('.webp')) continue
      const id = obj.key.slice('img/'.length).replace(/\.webp$/, '')
      const cm = obj.customMetadata || {}
      if (!mine(cm.uploaderTag)) continue
      const uploadedAt = Number(cm.uploadedAt) || 0
      items.push({
        kind: 'image', id,
        contentType: 'image/webp',
        size: obj.size || 0,
        uploadedAt,
        expiresAt: uploadedAt ? uploadedAt + ttlHours * 3600 * 1000 : 0,
        url: `${c.env.PUBLIC_ORIGIN}/i/${id}.webp`,
      })
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor && scanned <= SCAN_CAP)

  items.sort((a, b) => Number(b.uploadedAt) - Number(a.uploadedAt))
  return c.json({ items, admin })
})

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
    await c.env.BUCKET.delete(`img/${id}.webp`)
    await c.env.BUCKET.delete(`img/${id}.ocr.json`)
    await addStorageUsed(c.env.QUOTA, -size)
    return c.json({ deleted: true, kind: 'image' })
  }

  const doc = await c.env.BUCKET.head(`doc/${id}`)
  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  const meta = metaObj ? await metaObj.json<DocMeta>() : undefined
  if (doc || meta) {
    const chargedSize = chargedDocSize(meta, doc?.size ?? 0)
    const uploadedAt = Number(meta?.uploadedAt ?? 0)
    const uploaderTag = typeof meta?.uploaderTag === 'string' ? meta.uploaderTag : undefined
    const finalized = meta?.finalized === true
    const finalizedSize = finalized ? nonNegative(meta?.size) : 0
    if (doc) await c.env.BUCKET.delete(`doc/${id}`)
    await c.env.BUCKET.delete(`meta/${id}.json`)
    // Only un-charge bytes the counter was actually charged (docs are charged
    // at /finalize). An un-finalized orphan never hit the counter.
    if (finalizedSize > 0) await addStorageUsed(c.env.QUOTA, -finalizedSize)
    if (doc && !meta) {
      // TODO(review): Decide whether metadata-less doc orphans should subtract storage; without meta we cannot know whether /finalize charged them.
    }
    await refundDaily(c.env.QUOTA, ip, chargedSize, uploadedAt, uploaderTag)
    return c.json({ deleted: true, kind: 'doc' })
  }

  return c.json({ error: 'not_found' }, 404)
})

// ----------------------------------------------------------------------------
function capBytes(env: Bindings): number {
  return Number(env.MAX_TOTAL_BYTES) || 9_000_000_000
}

function chargedDocSize(meta: DocMeta | undefined, fallback: number): number {
  return nonNegative(meta?.chargedSize) || nonNegative(meta?.size) || nonNegative(fallback)
}

function nonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
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
