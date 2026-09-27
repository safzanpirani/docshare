// Full-page player served at /w/:id for uploaded video and audio.
//
// Deliberately separate from /d/:id: that URL is what gets copied and handed to
// agents, and it must keep returning raw bytes. /w/ is the human surface —
// filename, size, expiry, and the controls to copy or download — around a
// native <video>/<audio> element pointed back at /d/, which already answers
// Range requests with 206 (see serveDoc in index.ts), so seeking streams.

import { htmlEscape } from './http'

// No script, no network beyond the media element itself: the page is fully
// server-rendered and the only JS is the inline copy-button handler.
export const MEDIA_CSP = [
  "default-src 'none'",
  "media-src 'self'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

function fmtBytes(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// "in 6h 20m" / "expired" — computed server-side, so the page needs no clock JS.
function fmtExpiry(expiresAt: number): string {
  if (!expiresAt) return ''
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'expired'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `expires in ${mins}m`
  const h = Math.floor(mins / 60)
  return `expires in ${h}h ${mins % 60}m`
}

export type MediaPageInput = {
  id: string
  filename: string
  contentType: string
  kind: 'video' | 'audio'
  size: number
  expiresAt: number
  fileUrl: string // absolute /d/ URL — also what the copy button yields
}

export function mediaPage(m: MediaPageInput): string {
  const title = htmlEscape(m.filename)
  const url = htmlEscape(m.fileUrl)
  const dlUrl = htmlEscape(`${m.fileUrl}${m.fileUrl.includes('?') ? '&' : '?'}dl=1`)
  const ct = htmlEscape(m.contentType)
  const facts = [fmtBytes(m.size), ct, fmtExpiry(m.expiresAt)].filter(Boolean).map(htmlEscape)
  const player =
    m.kind === 'video'
      ? `<video id="p" controls playsinline preload="metadata" src="${url}"></video>`
      : `<audio id="p" controls preload="metadata" src="${url}"></audio>`
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:type" content="${m.kind}.other">
<meta property="og:video" content="${url}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0f; color: #e6e6ee;
    font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; gap: 12px; align-items: center; padding: 12px 18px;
    background: #14141b; border-bottom: 1px solid #26263a; }
  header .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-sans-serif, system-ui, sans-serif; }
  header .spacer { flex: 1 1 auto; }
  a.home { color: #8b8bb0; text-decoration: none; font-size: 13px;
    font-family: ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 18px 64px; }
  .stage { background: #000; border: 1px solid #23233a; border-radius: 12px; overflow: hidden;
    display: flex; align-items: center; justify-content: center; }
  video { width: 100%; max-height: 78vh; display: block; background: #000; }
  audio { width: 100%; padding: 18px; }
  .facts { display: flex; flex-wrap: wrap; gap: 8px 16px; color: #8b8bb0; font-size: 12.5px;
    padding: 14px 2px 0; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; padding: 16px 0 0; }
  .btn { color: #c9c9e0; text-decoration: none; font-size: 13px; padding: 8px 14px; cursor: pointer;
    border: 1px solid #35354d; border-radius: 8px; background: #1c1c27;
    font-family: ui-sans-serif, system-ui, sans-serif; }
  .btn:hover { background: #262636; }
  .url { margin-top: 16px; padding: 10px 12px; background: #12121a; border: 1px solid #23233a;
    border-radius: 8px; color: #9a9aff; font-size: 12.5px; overflow-x: auto; white-space: nowrap; }
</style>
</head><body>
<header>
  <a class="home" href="/">&larr; docshare</a>
  <span class="name">${title}</span>
  <span class="spacer"></span>
  <a class="btn" href="${dlUrl}" download>Download</a>
</header>
<main>
  <div class="stage">${player}</div>
  <div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
  <div class="row">
    <button class="btn" id="copy">Copy file URL</button>
    <button class="btn" id="copyw">Copy this page URL</button>
    <a class="btn" href="${url}">Open raw file</a>
  </div>
  <div class="url">${url}</div>
</main>
<script>
  function bind(id, value) {
    var b = document.getElementById(id)
    b.addEventListener('click', function () {
      navigator.clipboard.writeText(value).then(function () {
        var t = b.textContent
        b.textContent = 'copied ✓'
        setTimeout(function () { b.textContent = t }, 1200)
      })
    })
  }
  bind('copy', ${JSON.stringify(m.fileUrl)})
  bind('copyw', location.href)
</script>
</body></html>`
}
