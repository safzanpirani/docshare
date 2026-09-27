# docshare

seeshare + temporary file hosting, in one Worker. Paste / drop / pick anything →
short URL → auto-deletes in 24h. Built for handing files to coding agents.

- **Images** are re-encoded in the browser and posted through the Worker (small
  payloads), with optional Gemini OCR — exactly like `seeshare`. Output format is
  selectable: **WEBP** (default, lossy, small) or **PNG** (lossless, larger).
  See the PNG note under Known limitations.
- **Any other file** (≤ 400 MB) is uploaded **straight to R2 via a presigned PUT
  URL** (the bytes never pass through the Worker) and served back as a forced
  download, so an LLM/agent can `curl` it.

Deployed at **docs.safzan.dev** — independent of seeshare (`share.safzan.dev`):
separate Worker, separate R2 bucket, separate bindings.

## Use it (no install required)

Upload any file ≤ 100 MB in one curl — response body is the download URL:

```sh
curl -T myfile.pdf https://docs.safzan.dev/upload/myfile.pdf
```

For files up to 400 MB, use the 3-step presigned flow (`/api/doc/presign` →
PUT to R2 → `/api/doc/finalize`) — the skill below does this for you.

LLMs/agents can read the API spec at <https://docs.safzan.dev/llms.txt>
([llmstxt.org](https://llmstxt.org/) format).

## Install as an agent skill

Via [`vercel-labs/skills`](https://github.com/vercel-labs/skills) — works for
Claude Code, opencode, and the other agents the package supports:

```sh
npx skills add https://github.com/safzanpirani/docshare
```

That drops `skills/docshare/` into your agent's skills directory
(`~/.claude/skills/docshare/` for Claude Code,
`~/.config/opencode/skills/docshare/` for opencode). The agent can then call
`~/.claude/skills/docshare/upload.sh <file>` to upload anything up to
400 MB and get back a download URL.

To point the skill at a self-hosted deployment:

```sh
export DOCSHARE_ENDPOINT=https://your.docshare.example
```

---

## Self-hosting

## Architecture

- **Runtime:** single Cloudflare Worker (Hono)
- **Storage:** one R2 bucket `docshare`
  - `img/{id}.{webp,png}` — images, `img/{id}.ocr.json` — OCR sidecars
  - `doc/{id}` — uploaded files (16-char id), `meta/{id}.json` — filename/type/size
- **TTL:** R2 lifecycle rule deletes objects > 1 day old (see setup)
- **Large uploads:** presigned S3 PUT direct to R2, bypassing the Worker's
  ~100 MB request-body limit. Requires an R2 S3-API token.
- **Abuse control:**
  - burst: Cloudflare rate-limit bindings (images 6/60s, docs 2/60s, OCR 3/60s)
  - sustained: KV per-IP daily caps (deployed: 10 docs/day, 1.5 GB/day) — `src/ratelimit.ts`
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

## Maintenance

Run the complete verification sequence after a dependency update:

```sh
npm ci
npm run check
npm audit
npm audit --omit=dev
dry_run_dir="$(mktemp -d)"
npx wrangler deploy --dry-run --outdir "$dry_run_dir"
```

Upgrade Wrangler and `@cloudflare/workers-types` together. Wrangler declares
the types package as an optional peer dependency. Resolve peer-version conflicts
in `package.json` and the lockfile. Do not bypass them with `--force` or
`--legacy-peer-deps`.

After deployment, verify the homepage and a representative download against the
live domain. Treat dependency audits, deployment output, and live checks as
separate evidence.

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
| `POST /api/upload` | image: `image/webp` or `image/png` bytes (≤ 15 MB). Returns `{ id, url, format, ... }` |
| `GET /i/:id.{webp,png}` | streams an image |
| `POST /api/ocr/:id` | OCR an image (cached); `ocr_disabled` if no Gemini key |
| `PUT /upload/:filename` | one-shot upload ≤ 100 MB; bare URL back, or JSON `{ id, url, rawUrl, expiresAt, ... }` with `Accept: application/json` |
| `POST /api/doc/presign` | body `{ filename, size, contentType, makeRoom? }` → `{ id, putUrl, downloadUrl, rawUrl, ... }` |
| `POST /api/doc/finalize` | body `{ id }` — confirms upload, enforces max size |
| `GET /d/:id/:filename` | streams a doc as a forced download |
| `GET /api/info/:id` | metadata for an image or doc |
| `GET /api/mine` | uploads the caller can claim — see Ownership below |
| `POST /api/delete` | body `{ id }` — deletes; the id is the capability |
| `DELETE /d/:id/:filename`, `DELETE /i/:id.{webp,png}` | same delete, addressed by the share URL |
| `POST /api/make-room` | body `{ bytes, dryRun? }` — deletes the caller's oldest uploads until `bytes` fits |
| `GET /api/usage` | caller's daily quota + the shared storage cap |

Errors are JSON `{ error, hint, ... }` with a stable `error` code. Cap errors
carry the numbers: `daily_count`/`daily_bytes` add `limit`, `used` and
`resetsAt`; `storage_full` adds `used` and `cap`; `rate_limited` adds
`retryAfter` and a `Retry-After` header. `PUT /upload` returns the same code
and hint as plain text.

### Making room

A full daily cap or storage cap does not have to be a dead end. The caller can
delete its own uploads to free space:

- `POST /api/make-room` with `{ "bytes": <size of the next upload> }` deletes
  the caller's oldest uploads until that upload fits. `"dryRun": true` returns
  the plan (`wouldDelete`) without deleting.
- `"makeRoom": true` on `/api/doc/presign`, or an `x-make-room: 1` header on
  either upload route, does the same inline and lists what it removed in
  `evicted` (and the `x-docshare-evicted` header).

Only uploads the caller owns are candidates. The admin key does not widen that.
For the daily caps, only docs uploaded today from the caller's IP count,
because only those refund that counter. Presigned uploads abandoned for over
30 minutes count too. When the caller's uploads cannot free enough, the
request returns `409 cannot_make_room` with the `shortfall` and deletes
nothing.

Deleting a doc uploaded today refunds the daily quota to the counter that paid
for it. The refund applies when the caller has the same IP or the same owner
token as the uploader.

### Ownership (`/api/mine`)

Uploads are attributed by an **owner token**: an opaque secret the client mints
once and sends as `x-owner-token` on every upload. The server stores only its
SHA-256, and `/api/mine` returns the uploads whose stored hash matches. Clients
that send no token (curl, agents) fall back to being matched by IP hash.

The token exists because IP alone is not an identity: behind CGNAT, a corporate
NAT, or a mobile carrier, unrelated people share a public IP and would otherwise
see — and be able to delete — each other's uploads.

`/api/mine`, `/api/delete`, `/api/make-room` and `DELETE` on share URLs reject browser requests carrying a
cross-origin `Origin` header, so a page a user happens to visit cannot enumerate
their uploads. Requests with no `Origin` (curl, agents) are unaffected.

APK downloads use `application/vnd.android.package-archive`. All document
downloads retain `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`.

## Tunables (`wrangler.toml` `[vars]`)

Defaults below are the fallbacks in `src/config.ts`, used when the var is unset.
The values actually deployed live in `wrangler.toml`.

| Var | Default | What |
|---|---|---|
| `TTL_HOURS` | `24` | "expires at" shown to clients. **Actual delete is the R2 lifecycle rule** — keep in sync. |
| `MAX_UPLOAD_BYTES` | 15 MB | image cap, per encoded image (see PNG note below) |
| `MAX_DOC_BYTES` | 100 MB | doc cap (deployed: 400 MB) |
| `MAX_ADMIN_DOC_BYTES` | 1.46 GB | doc cap for requests carrying the admin key |
| `DOC_DAILY_COUNT` | `10` | docs per IP per day |
| `DOC_DAILY_BYTES` | 1.5 GB | doc bytes per IP per day |
| `MAX_TOTAL_BYTES` | 9 GB | global storage hard cap (R2 free tier is 10 GB) |

## Tests

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest — quotas, storage counter, headers, ids, routes
npm run check       # both; this is what CI runs
```

The suite covers the accounting logic (daily quota charge/refund, the global
storage counter and its cron reconciliation), the header/filename/range helpers,
ownership matching, the make-room planner, and the upload/delete/make-room
routes end to end. It uses in-memory KV/R2 fakes (`test/fakes.ts`,
`test/app-fakes.ts`) — no Workers runtime and no network, so it runs in well
under a second.

## Known limitations

- Daily caps are charged at presign time using the **declared** size, and KV is
  eventually consistent — so the per-IP cap is approximate, not exact. The 60s
  burst binding covers the concurrent case; `finalize` deletes any object that
  came in over `MAX_DOC_BYTES`.
- A client that presigns but never PUTs still consumes one count/declared-bytes
  for the day, until `make-room` reclaims it (after 30 minutes) or the day
  rolls over. The TTL lifecycle rule bounds any orphaned storage.
- **PNG output and the 15 MB image cap.** `MAX_UPLOAD_BYTES` was sized for lossy
  WebP. PNG is lossless, so there is no quality knob to walk down: the encoder
  is single-shot and a large screenshot can exceed the cap outright, failing
  with "switch to WEBP" rather than degrading. Raising the cap for PNG only, or
  reducing `MAX_DIMENSION` for PNG, would both work — neither is implemented.
- **Quotas are format-blind.** The per-IP daily byte cap and the 9 GB global cap
  count bytes without regard to format, and PNG is several times larger per
  image than WebP. Sustained PNG use burns quota much faster than the limits
  were tuned for.
