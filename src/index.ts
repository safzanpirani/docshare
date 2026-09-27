import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import indexHtml from '../public/index.html'
import llmsTxt from '../public/llms.txt'
import ogPng from '../public/og.png'
import ogSvg from '../public/og.svg'
import icon192 from '../public/icon-192.png'
import icon512 from '../public/icon-512.png'
import { readConfig } from './config'
import {
  DEFAULT_DOC_CONTENT_TYPE,
  asciiFilename,
  clientIp,
  contentTypeForDownload,
  isForbiddenCrossOrigin,
  isPdfFile,
  isViewableText,
  mediaKind,
  nonNegative,
  normalizeContentType,
  parseSingleRange,
  returnedRangeBounds,
  rfc5987Value,
  sanitizeFilename,
  shouldServeInline,
  timingSafeEqual,
} from './http'
import { generateId, isValidId } from './id'
import {
  IMAGE_FORMATS,
  type ImageFormat,
  bytesMatchFormat,
  contentTypeFor,
  formatFromContentType,
  imageKey,
  parseImageKey,
} from './image'
import { mediaPage, MEDIA_CSP } from './media'
import { runOcr } from './ocr'
import { OWNER_TOKEN_HEADER, ownerTagFrom, ownsItem } from './owner'
import { presignPutUrl } from './presign'
import { checkAndChargeDaily, hashIp, readDailyUsage, refundChargedDaily, refundDaily } from './ratelimit'
import { addStorageUsed, getStorageUsed, reconcileStorage, withinStorageCap } from './storage'
import { VIEWER_CSP, viewerPage } from './viewer'

// Hard ceiling on the simple PUT /upload/:filename route. CF Workers cap the
// request body at 100MB on Free/Pro. For files larger than this, clients must
// use the 3-step presigned flow (/api/doc/presign → PUT to R2 → /finalize).
const SIMPLE_UPLOAD_MAX = 100 * 1024 * 1024

// CSP for the app shell. The app loads ES modules and WASM (jsquash) from
// esm.sh, highlight.js styles from cdnjs, and PUTs file bytes directly to R2,
// so those three hosts are pinned explicitly and everything else is denied.
const APP_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://esm.sh",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://esm.sh https://*.r2.cloudflarestorage.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

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
  MAX_ADMIN_DOC_BYTES: string
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
// Compared in constant time so response timing can't be used to recover it.
function isAdmin(c: { env: Bindings; req: { header: (n: string) => string | undefined } }): boolean {
  const key = c.env.ADMIN_KEY
  if (!key) return false
  const supplied = c.req.header('x-admin-key')
  if (!supplied) return false
  return timingSafeEqual(supplied, key)
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
  ownerTag?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Wildcard CORS is right for the endpoints that are pure capability-by-id or
// pure upload — third-party browser tools are welcome to use them.
app.use('/api/*', cors())

// ...but /api/mine and /api/delete act on the caller's ambient identity (IP,
// and now the owner token), which means a wildcard ACAO let any page the user
// visited enumerate their uploads and then delete them — no id needed, and no
// preflight, since both are CORS-"simple" requests. Requests carrying a browser
// Origin must now come from the app itself. curl/agents send no Origin and are
// unaffected, so the documented CLI surface still works.
const sameOriginOnly: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  if (isForbiddenCrossOrigin(c.req.header('origin'), c.env.PUBLIC_ORIGIN)) {
    return c.json({ error: 'forbidden_origin' }, 403)
  }
  await next()
}
app.use('/api/mine', sameOriginOnly)
app.use('/api/delete', sameOriginOnly)

app.get('/', (c) => {
  c.header('cache-control', 'public, max-age=300')
  c.header('content-security-policy', APP_CSP)
  c.header('x-content-type-options', 'nosniff')
  c.header('referrer-policy', 'no-referrer')
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

  const cfg = readConfig(c.env)
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
    return c.text(`too_large: simple upload route caps at ${SIMPLE_UPLOAD_MAX} bytes. Use POST /api/doc/presign for files up to ${cfg.maxDocBytes} bytes.\n`, 413)
  }

  if (!(await withinStorageCap(c.env.QUOTA, declared, cfg.maxTotalBytes))) {
    return c.text('storage_full: service storage cap reached, try again later\n', 507)
  }

  const charged = !isAdmin(c)
  if (charged) {
    const quota = await checkAndChargeDaily(c.env.QUOTA, ip, declared, cfg.dailyCount, cfg.dailyBytes)
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
  if (!(await withinStorageCap(c.env.QUOTA, buf.byteLength, cfg.maxTotalBytes))) {
    await refund()
    return c.text('storage_full: service storage cap reached, try again later\n', 507)
  }

  id = generateId(16)
  if (await c.env.BUCKET.head(`doc/${id}`)) id = generateId(16)

  const uploadedAt = Date.now()
  const expiresAt = uploadedAt + cfg.ttlMs

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
      ownerTag: await ownerTagFrom(c.req.header(OWNER_TOKEN_HEADER)),
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

  const cfg = readConfig(c.env)
  const max = cfg.maxUploadBytes
  const admin = isAdmin(c)
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared && declared > max && !admin) return c.json({ error: 'too_large', max }, 413)

  const format = formatFromContentType(c.req.header('content-type'))
  if (!format) return c.json({ error: 'unsupported_format', supported: IMAGE_FORMATS }, 415)

  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'empty' }, 400)
  if (buf.byteLength > max && !admin) return c.json({ error: 'too_large', max }, 413)
  // The stored extension follows the bytes, not the declared type, so a false
  // content-type can't plant mislabelled content under a trusted extension.
  if (!bytesMatchFormat(buf, format)) {
    return c.json({ error: 'format_mismatch', declared: format }, 415)
  }

  if (!(await withinStorageCap(c.env.QUOTA, buf.byteLength, cfg.maxTotalBytes))) {
    return c.json({ error: 'storage_full' }, 507)
  }

  // Ids are bare (no extension) for clients, so uniqueness has to hold across
  // every format — an `X.png` colliding with an existing `X.webp` would make
  // /api/info, /api/delete and /api/ocr resolve to the wrong object.
  let id = generateId(8)
  for (let attempt = 0; attempt < 3 && await findImage(c.env.BUCKET, id); attempt++) {
    id = generateId(8)
  }
  if (await findImage(c.env.BUCKET, id)) return c.json({ error: 'id_collision' }, 503)

  const key = imageKey(id, format)
  const uploadedAt = Date.now()
  let storageCharged = 0
  const ownerTag = await ownerTagFrom(c.req.header(OWNER_TOKEN_HEADER))
  try {
    const customMetadata: Record<string, string> = {
      uploadedAt: uploadedAt.toString(),
      uploaderTag: await hashIp(ip),
    }
    if (ownerTag) customMetadata.ownerTag = ownerTag
    await c.env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: contentTypeFor(format) },
      customMetadata,
    })
    await addStorageUsed(c.env.QUOTA, buf.byteLength)
    storageCharged = buf.byteLength
  } catch (e) {
    if (storageCharged > 0) await addStorageUsed(c.env.QUOTA, -storageCharged)
    await c.env.BUCKET.delete(key)
    throw e
  }

  const expiresAt = uploadedAt + cfg.ttlMs
  const url = `${c.env.PUBLIC_ORIGIN}/i/${id}.${format}`

  return c.json({ id, url, format, uploadedAt, expiresAt, size: buf.byteLength })
})

// Resolve a bare id to whichever image object actually exists. Clients only
// ever hold bare ids, so every bare-id endpoint must go through this — probing
// a single extension silently misses uploads in the other format.
async function findImage(
  bucket: R2Bucket,
  id: string,
): Promise<{ key: string; format: ImageFormat; head: R2Object } | undefined> {
  for (const format of IMAGE_FORMATS) {
    const key = imageKey(id, format)
    const head = await bucket.head(key)
    if (head) return { key, format, head }
  }
  return undefined
}

app.get('/i/:filename{[A-Za-z0-9]+\\.(webp|png)}', async (c) => {
  const filename = c.req.param('filename')
  const parsed = parseImageKey(`img/${filename}`)
  if (!parsed) return c.notFound()
  const obj = await c.env.BUCKET.get(`img/${filename}`)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('content-type', contentTypeFor(parsed.format))
  headers.set('cache-control', 'public, max-age=300, s-maxage=86400, immutable')
  headers.set('x-content-type-options', 'nosniff')
  if (obj.httpEtag) headers.set('etag', obj.httpEtag)
  return new Response(obj.body, { headers })
})

app.post('/api/ocr/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)
  if (!c.env.GEMINI_API_KEY) return c.json({ error: 'ocr_disabled' }, 503)

  // Rate-limit before any work, including the cache lookup. OCR spends a
  // third-party API budget on an object anyone holding the id can name, so the
  // limiter is the only thing bounding that spend.
  const ip = clientIp(c.req.raw)
  const { success } = await c.env.OCR_LIMITER.limit({ key: ip })
  if (!success) return c.json({ error: 'rate_limited' }, 429)

  const cached = await c.env.BUCKET.get(`img/${id}.ocr.json`)
  if (cached) {
    const data = await cached.json<{ text: string; ranAt: number; model: string }>()
    return c.json({ ...data, cached: true })
  }

  const found = await findImage(c.env.BUCKET, id)
  if (!found) return c.json({ error: 'not_found' }, 404)
  const image = await c.env.BUCKET.get(found.key)
  if (!image) return c.json({ error: 'not_found' }, 404)
  const bytes = await image.arrayBuffer()

  const model = c.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
  let text: string
  try {
    text = await runOcr(bytes, contentTypeFor(found.format), c.env.GEMINI_API_KEY, model)
  } catch (e) {
    // The upstream message can carry request details; log it, return a bare
    // failure so provider internals don't reach the client.
    console.error('ocr_failed', (e as Error).message)
    return c.json({ error: 'ocr_failed' }, 502)
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

  const cfg = readConfig(c.env)

  let body: { filename?: unknown; size?: unknown; contentType?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }

  const filename = sanitizeFilename(String(body.filename ?? 'file'))
  const size = Number(body.size ?? 0)
  const contentType = String(body.contentType ?? 'application/octet-stream')

  const maxDoc = isAdmin(c) ? cfg.maxAdminDocBytes : cfg.maxDocBytes
  if (!Number.isFinite(size) || size <= 0) return c.json({ error: 'bad_size' }, 400)
  if (size > maxDoc) return c.json({ error: 'too_large', max: maxDoc }, 413)

  // Global storage cap. The bytes are charged to the counter at /finalize with
  // the real object size; here we only reject if the declared size wouldn't fit.
  if (!(await withinStorageCap(c.env.QUOTA, size, cfg.maxTotalBytes))) {
    return c.json({ error: 'storage_full' }, 507)
  }

  let id = generateId(16)
  if (await c.env.BUCKET.head(`doc/${id}`)) id = generateId(16)

  const uploadedAt = Date.now()
  const expiresAt = uploadedAt + cfg.ttlMs

  let putUrl: string
  try {
    putUrl = await presignPutUrl(c.env, `doc/${id}`)
  } catch (e) {
    // Never surface the signer's message — it can name the account and bucket.
    console.error('presign_failed', (e as Error).message)
    return c.json({ error: 'presign_failed' }, 500)
  }

  const uploaderTag = await hashIp(ip)
  const ownerTag = await ownerTagFrom(c.req.header(OWNER_TOKEN_HEADER))
  const charged = !isAdmin(c)
  if (charged) {
    const quota = await checkAndChargeDaily(c.env.QUOTA, ip, size, cfg.dailyCount, cfg.dailyBytes)
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
    ownerTag,
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
  const cfg = readConfig(c.env)
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

  const maxDoc = isAdmin(c) ? cfg.maxAdminDocBytes : cfg.maxDocBytes
  if (obj.size > maxDoc) {
    await c.env.BUCKET.delete(`doc/${id}`)
    await c.env.BUCKET.delete(`meta/${id}.json`)
    if (previousFinalizedSize > 0) await addStorageUsed(c.env.QUOTA, -previousFinalizedSize)
    await refundDaily(c.env.QUOTA, ip, chargedSize, uploadedAt, uploaderTag)
    return c.json({ error: 'too_large', max: maxDoc }, 413)
  }

  const storageDelta = obj.size - previousFinalizedSize
  if (storageDelta > 0 && !(await withinStorageCap(c.env.QUOTA, storageDelta, cfg.maxTotalBytes))) {
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
// Watch page — the human-facing player. Kept off /d/ on purpose: /d/ is the
// URL the UI copies and agents fetch, and it must stay raw bytes.
app.get('/w/:id/:filename', serveWatch)
app.get('/w/:id', serveWatch)

async function serveWatch(c: Context<{ Bindings: Bindings }>) {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  if (!metaObj) return c.json({ error: 'not_found' }, 404)
  const meta = await metaObj.json<{
    filename?: string
    contentType?: string
    size?: number
    expiresAt?: number
  }>()

  const filename = sanitizeFilename(meta.filename || id)
  const contentType = normalizeContentType(meta.contentType || DEFAULT_DOC_CONTENT_TYPE)
  const kind = mediaKind(filename, contentType)
  // Anything that isn't playable belongs on /d/, which already picks the text
  // viewer, the PDF viewer, or a download.
  if (!kind) return c.redirect(`/d/${id}/${encodeURIComponent(filename)}`, 302)

  return c.html(
    mediaPage({
      id,
      filename,
      contentType,
      kind,
      size: nonNegative(meta.size),
      expiresAt: nonNegative(meta.expiresAt),
      fileUrl: `${c.env.PUBLIC_ORIGIN}/d/${id}/${encodeURIComponent(filename)}`,
    }),
    200,
    {
      'cache-control': 'public, max-age=60',
      'content-security-policy': MEDIA_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  )
}

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
  contentType = contentTypeForDownload(filename, contentType)

  // Text/code/markdown files get a styled full-page viewer when opened in a
  // browser (Accept: text/html). `?raw=1` serves the plain text (git-raw
  // style) and `?dl=1` forces a download — both are what agents/curl hit, so
  // programmatic clients (no text/html in Accept) always get the raw bytes.
  const rawParam = c.req.query('raw') != null
  const dlParam = c.req.query('dl') != null
  const isText = isViewableText(filename, contentType)
  const isPdf = isPdfFile(filename, contentType)
  const wantsHtml = (c.req.header('accept') || '').includes('text/html')
  if ((isText || isPdf) && wantsHtml && !rawParam && !dlParam) {
    // `Vary: Accept` is essential: this URL returns HTML to browsers but raw
    // bytes to `curl`/agents, so caches must key on Accept — otherwise a cached
    // download variant gets replayed to a browser (shows up as a spurious
    // download when clicking "View").
    return c.html(viewerPage(id, filename, contentType), 200, {
      'cache-control': 'public, max-age=300',
      vary: 'Accept',
      'content-security-policy': VIEWER_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
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
    rangeOpts = parseSingleRange(rangeHeader) as R2GetOptions['range']
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
  // Raw bytes are attacker-controlled and served from this origin; a CSP that
  // denies everything makes the response inert if a browser is ever coaxed into
  // treating it as a document.
  headers.set('content-security-policy', "default-src 'none'; sandbox")
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

// Usage for the requester (their daily quota) + the shared storage cap. Used
// by the UI's usage bars. Read-only — never charges anything.
app.get('/api/usage', async (c) => {
  const ip = clientIp(c.req.raw)
  const cfg = readConfig(c.env)
  const [used, daily] = await Promise.all([
    getStorageUsed(c.env.QUOTA),
    readDailyUsage(c.env.QUOTA, ip),
  ])
  // `admin` lets the UI show whether the key it stored is actually accepted —
  // without it a wrong password still reads as "unlocked" client-side and the
  // user only finds out when an oversized upload is rejected.
  const admin = isAdmin(c)
  // Varies by the x-admin-key header, so it must never sit in a shared cache.
  c.header('cache-control', 'no-store')
  return c.json({
    storage: { used, cap: cfg.maxTotalBytes },
    daily: {
      count: daily.count,
      countMax: cfg.dailyCount,
      bytes: daily.bytes,
      bytesMax: cfg.dailyBytes,
    },
    admin,
    docMax: admin ? cfg.maxAdminDocBytes : cfg.maxDocBytes,
  })
})

// List uploads the caller can claim: everything whose owner token matches the
// caller's (see src/owner.ts), or — when the owner sends the admin password —
// every upload on the instance. Lets a secondary device see and delete uploads
// it never had in local history.
//
// Personal-scale instance: a bounded full-bucket scan is fine here, but the
// metadata reads are issued in parallel batches. Sequentially awaiting one R2
// GET per object meant a single request could issue thousands of round-trips
// and hit the Worker duration limit.
const MINE_SCAN_CAP = 5000 // safety bound on objects scanned per prefix
const MINE_FETCH_CONCURRENCY = 50

app.get('/api/mine', async (c) => {
  const ip = clientIp(c.req.raw)
  const admin = isAdmin(c)
  const callerIpTag = await hashIp(ip)
  const callerOwnerTag = await ownerTagFrom(c.req.header(OWNER_TOKEN_HEADER))
  const cfg = readConfig(c.env)
  const owns = (itemOwnerTag: unknown, itemUploaderTag: unknown) =>
    ownsItem({ admin, itemOwnerTag, itemUploaderTag, callerOwnerTag, callerIpTag })

  const items: Array<Record<string, unknown>> = []

  // Docs: metadata lives in meta/{id}.json; only surface finalized uploads.
  const metaKeys: string[] = []
  let cursor: string | undefined
  do {
    const listed = await c.env.BUCKET.list({ prefix: 'meta/', cursor, limit: 1000 })
    for (const obj of listed.objects) {
      if (metaKeys.length >= MINE_SCAN_CAP) break
      const id = obj.key.slice('meta/'.length).replace(/\.json$/, '')
      if (isValidId(id)) metaKeys.push(obj.key)
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor && metaKeys.length < MINE_SCAN_CAP)

  for (let i = 0; i < metaKeys.length; i += MINE_FETCH_CONCURRENCY) {
    const batch = metaKeys.slice(i, i + MINE_FETCH_CONCURRENCY)
    const metas = await Promise.all(batch.map(async (key) => {
      const metaObj = await c.env.BUCKET.get(key)
      if (!metaObj) return undefined
      const meta = await metaObj.json<DocMeta>().catch(() => undefined)
      return meta ? { key, meta } : undefined
    }))
    for (const entry of metas) {
      if (!entry) continue
      const { key, meta } = entry
      if (meta.finalized !== true) continue
      if (!owns(meta.ownerTag, meta.uploaderTag)) continue
      const id = key.slice('meta/'.length).replace(/\.json$/, '')
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
  }

  // Images: tags live in R2 customMetadata, returned by list() — no per-object
  // fetch needed.
  cursor = undefined
  let scanned = 0
  do {
    // include:['customMetadata'] is supported at runtime but missing from the
    // pinned R2ListOptions types — cast to reach it.
    const listed = await c.env.BUCKET.list({ prefix: 'img/', cursor, limit: 1000, include: ['customMetadata'] } as R2ListOptions)
    for (const obj of listed.objects) {
      if (++scanned > MINE_SCAN_CAP) break
      // parseImageKey also filters out the img/{id}.ocr.json sidecars.
      const parsed = parseImageKey(obj.key)
      if (!parsed) continue
      const { id, format } = parsed
      const cm = obj.customMetadata || {}
      if (!owns(cm.ownerTag, cm.uploaderTag)) continue
      const uploadedAt = Number(cm.uploadedAt) || 0
      items.push({
        kind: 'image', id,
        format,
        contentType: contentTypeFor(format),
        size: obj.size || 0,
        uploadedAt,
        expiresAt: uploadedAt ? uploadedAt + cfg.ttlMs : 0,
        url: `${c.env.PUBLIC_ORIGIN}/i/${id}.${format}`,
      })
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor && scanned <= MINE_SCAN_CAP)

  items.sort((a, b) => Number(b.uploadedAt) - Number(a.uploadedAt))
  return c.json({ items, admin })
})

// Metadata for either an image (id) or a doc (id).
app.get('/api/info/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) return c.json({ error: 'bad_id' }, 400)

  const cfg = readConfig(c.env)

  const found = await findImage(c.env.BUCKET, id)
  if (found) {
    const img = found.head
    const uploadedAt = Number(img.customMetadata?.uploadedAt ?? img.uploaded.getTime())
    return c.json({
      id,
      kind: 'image',
      format: found.format,
      contentType: contentTypeFor(found.format),
      size: img.size,
      uploadedAt,
      expiresAt: uploadedAt + cfg.ttlMs,
    })
  }

  const metaObj = await c.env.BUCKET.get(`meta/${id}.json`)
  if (metaObj) {
    const meta = await metaObj.json<Record<string, unknown>>()
    // uploaderTag/ownerTag are internal (they authorise quota refunds and
    // ownership) — never expose them.
    delete meta.uploaderTag
    delete meta.ownerTag
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

  const found = await findImage(c.env.BUCKET, id)
  if (found) {
    const size = found.head.size
    await c.env.BUCKET.delete(found.key)
    await c.env.BUCKET.delete(`img/${id}.ocr.json`)
    await addStorageUsed(c.env.QUOTA, -size)
    return c.json({ deleted: true, kind: 'image', format: found.format })
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
    //
    // A doc with no meta sidecar is unattributable: we cannot tell whether
    // /finalize ever charged it, and guessing either way corrupts the counter.
    // Leave it alone — the half-hourly cron re-sums the bucket and repairs the
    // value from ground truth (see reconcileStorage in src/storage.ts).
    if (finalizedSize > 0) await addStorageUsed(c.env.QUOTA, -finalizedSize)
    await refundDaily(c.env.QUOTA, ip, chargedSize, uploadedAt, uploaderTag)
    return c.json({ deleted: true, kind: 'doc' })
  }

  return c.json({ error: 'not_found' }, 404)
})

// ----------------------------------------------------------------------------
function chargedDocSize(meta: DocMeta | undefined, fallback: number): number {
  return nonNegative(meta?.chargedSize) || nonNegative(meta?.size) || nonNegative(fallback)
}

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  // Cron (see wrangler.toml [triggers]): re-sum the bucket so storage that the
  // 24h lifecycle rule deleted gets subtracted from the counter.
  scheduled: (_event: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(reconcileStorage(env.QUOTA, env.BUCKET))
  },
}
