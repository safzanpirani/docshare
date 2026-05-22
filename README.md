# docshare

seeshare + temporary file hosting, in one Worker. Paste / drop / pick anything →
short URL → auto-deletes in 24h. Built for handing files to coding agents.

- **Images** are converted to WebP in the browser and posted through the Worker
  (small payloads), with optional Gemini OCR — exactly like `seeshare`.
- **Any other file** (≤ 100 MB) is uploaded **straight to R2 via a presigned PUT
  URL** (the bytes never pass through the Worker) and served back as a forced
  download, so an LLM/agent can `curl` it.

Deployed at **docs.safzan.dev** — independent of seeshare (`share.safzan.dev`):
separate Worker, separate R2 bucket, separate bindings.

## Architecture

- **Runtime:** single Cloudflare Worker (Hono)
- **Storage:** one R2 bucket `docshare`
  - `img/{id}.webp` — images, `img/{id}.ocr.json` — OCR sidecars
  - `doc/{id}` — uploaded files (16-char id), `meta/{id}.json` — filename/type/size
- **TTL:** R2 lifecycle rule deletes objects > 1 day old (see setup)
- **Large uploads:** presigned S3 PUT direct to R2, bypassing the Worker's
  ~100 MB request-body limit. Requires an R2 S3-API token.
- **Abuse control:**
  - burst: Cloudflare rate-limit bindings (images 6/60s, docs 2/60s, OCR 3/60s)
  - sustained: KV per-IP daily caps (default 5 docs/day, 300 MB/day) — `src/ratelimit.ts`
- **Security:** docs are always served `Content-Disposition: attachment` +
  `X-Content-Type-Options: nosniff` so a malicious `.html`/`.svg` can't run on
  this origin.

## Setup

```sh
npm install
```

### 1. Create the R2 bucket
```sh
npx wrangler r2 bucket create docshare
```

### 2. Lifecycle rule (enforces the 24h TTL)
Dashboard → R2 → `docshare` → Settings → Object lifecycle rules → Add rule:
prefix empty (all objects), action **Delete objects** after **1 day**.
Without this, uploads are never deleted.

### 3. Bucket CORS (so the browser can PUT direct to R2)
The presigned upload is a cross-origin PUT from `docs.safzan.dev` to the R2 S3
endpoint, so the bucket needs a CORS policy. It's in `cors.json` (wrangler's
`{ "rules": [...] }` schema). Apply it:
```sh
npx wrangler r2 bucket cors set docshare --file cors.json
```

### 4. KV namespace for daily quotas
```sh
npx wrangler kv namespace create QUOTA
```
Paste the returned `id` into `wrangler.toml` (`[[kv_namespaces]] id = "..."`).

### 5. Account id
Put your Cloudflare account id into `R2_ACCOUNT_ID` in `wrangler.toml`
(`npx wrangler whoami` shows it).

### 6. Secrets
```sh
# R2 S3-API token: dashboard → R2 → Manage R2 API Tokens → Create (Object R/W)
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY

# Optional — enables image OCR. If unset, /api/ocr returns ocr_disabled.
npx wrangler secret put GEMINI_API_KEY
```

### 7. Deploy
```sh
npm run deploy
```
The `docs.safzan.dev` custom-domain bind needs the `safzan.dev` zone on this
Cloudflare account (it already serves `share.safzan.dev`).

## Local development
```sh
cat > .dev.vars <<'EOF'
R2_ACCESS_KEY_ID="..."
R2_SECRET_ACCESS_KEY="..."
GEMINI_API_KEY="..."
EOF
npm run dev
```
Note: presigned upload talks to the real R2 S3 endpoint even in dev, so the
bucket + token + CORS must exist for doc uploads to work locally.

## API

| Route | What |
|---|---|
| `GET /` | the upload page |
| `POST /api/upload` | image: `image/webp` bytes (≤ 15 MB). Returns `{ id, url, ... }` |
| `GET /i/:id.webp` | streams an image |
| `POST /api/ocr/:id` | OCR an image (cached); `ocr_disabled` if no Gemini key |
| `POST /api/doc/presign` | body `{ filename, size, contentType }` → `{ id, putUrl, downloadUrl, ... }` |
| `POST /api/doc/finalize` | body `{ id }` — confirms upload, enforces max size |
| `GET /d/:id/:filename` | streams a doc as a forced download |
| `GET /api/info/:id` | metadata for an image or doc |

## Tunables (`wrangler.toml` `[vars]`)

| Var | Default | What |
|---|---|---|
| `TTL_HOURS` | `24` | "expires at" shown to clients. **Actual delete is the R2 lifecycle rule** — keep in sync. |
| `MAX_UPLOAD_BYTES` | 15 MB | image (webp) cap |
| `MAX_DOC_BYTES` | 100 MB | doc cap |
| `DOC_DAILY_COUNT` | `5` | docs per IP per day |
| `DOC_DAILY_BYTES` | 300 MB | doc bytes per IP per day |

## Known limitations

- Daily caps are charged at presign time using the **declared** size, and KV is
  eventually consistent — so the per-IP cap is approximate, not exact. The 60s
  burst binding covers the concurrent case; `finalize` deletes any object that
  came in over `MAX_DOC_BYTES`.
- A client that presigns but never PUTs still consumes one count/declared-bytes
  for the day. The TTL lifecycle rule bounds any orphaned storage.
