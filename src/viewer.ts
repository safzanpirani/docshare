// Full-page text/markdown/code/csv/diff/pdf viewer served at /d/:id for
// browsers. Extracted from index.ts, which had grown a 250-line HTML template
// literal in the middle of the router.
//
// The raw bytes are fetched client-side from `?raw=1` (same origin) so this
// shell can be cached and the content stays a single source of truth. Markdown
// is rendered + sanitised; other text is shown as syntax-highlighted <pre>.

import { MARKDOWN_EXTENSIONS, fileExt, htmlEscape, normalizeContentType } from './http'

// This page renders attacker-supplied content (any uploaded markdown) on the
// app's own origin, and sanitisation is done by a library fetched at runtime
// from a third-party CDN. CSP is the backstop for that: even if the sanitiser
// is bypassed or the CDN is compromised, injected markup cannot reach a new
// script origin or exfiltrate to an arbitrary host.
//
// 'unsafe-inline' is required by the inline module script below; 'wasm-unsafe-eval'
// by pdf.js. Both are scoped to script-src, which is otherwise pinned to esm.sh.
export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval' https://esm.sh",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "font-src data:",
  "connect-src 'self' https://esm.sh",
  "worker-src blob: https://esm.sh",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function viewerPage(id: string, filename: string, contentType: string): string {
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

  // Rendered DOM per mode. Toggling Rendered⇄Source used to re-parse and
  // re-sanitise (or re-highlight) the whole file on every click; now the first
  // render of each mode is the only one that costs anything.
  const rendered = new Map()

  // hljs.highlightAuto tries every registered grammar, which is O(grammars ×
  // length) and stalls the main thread on large files. Above this size, fall
  // back to plain text unless the extension names a language outright.
  const AUTO_DETECT_MAX = 512 * 1024
  // Hard ceiling on what we will parse/highlight at all. Past this the tab
  // locks up, so show a prefix and point at the raw bytes.
  const RENDER_MAX = 4 * 1024 * 1024

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
      if (lang) {
        code.innerHTML = hljs.highlight(t, { language: lang, ignoreIllegals: true }).value
        code.classList.add('hljs')
      } else if (t.length <= AUTO_DETECT_MAX) {
        code.innerHTML = hljs.highlightAuto(t).value
        code.classList.add('hljs')
      }
      // else: leave the textContent set above — plain, but instant.
    } catch {}
    return pre
  }
  // Pages are rasterised lazily, as they approach the viewport.
  //
  // This used to loop over every page and await a full render before showing
  // anything: a 200-page PDF meant 200 sequential rasterisations, hundreds of
  // MB of canvas backing store held at once, and no first paint until the last
  // page finished. Now page 1 paints immediately and the rest follow on scroll.
  //
  // Placeholders are sized from page 1's aspect ratio so the scrollbar is
  // correct from the start; each page's exact dimensions are applied when it
  // actually renders.
  async function renderPdf(buf) {
    const pdfjs = await import('https://esm.sh/pdfjs-dist@4.7.76/build/pdf.min.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs'
    const doc = await pdfjs.getDocument({ data: buf }).promise
    const wrap = document.createElement('div')
    wrap.className = 'pdf'
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssW = Math.min(900, main.clientWidth || 900)

    const first = await doc.getPage(1)
    const firstBase = first.getViewport({ scale: 1 })
    const estH = Math.round(cssW * (firstBase.height / firstBase.width))

    const canvases = []
    for (let i = 1; i <= doc.numPages; i++) {
      const canvas = document.createElement('canvas')
      canvas.dataset.page = String(i)
      canvas.style.width = cssW + 'px'
      canvas.style.height = estH + 'px'
      wrap.appendChild(canvas)
      canvases.push(canvas)
    }

    const drawPage = async (canvas) => {
      if (canvas.dataset.done) return
      canvas.dataset.done = '1'
      const i = Number(canvas.dataset.page)
      const page = i === 1 ? first : await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: (cssW / base.width) * dpr })
      canvas.width = vp.width
      canvas.height = vp.height
      canvas.style.width = (vp.width / dpr) + 'px'
      canvas.style.height = (vp.height / dpr) + 'px'
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
      // Release the page's operator list / font data once painted.
      page.cleanup()
    }

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          io.unobserve(e.target)
          drawPage(e.target)
        }
        // rootMargin keeps a screenful of pages ahead of the scroll position.
      }, { rootMargin: '1200px 0px' })
      // Observe after this subtree is attached by render(), so the initial
      // intersection check sees real geometry.
      requestAnimationFrame(() => canvases.forEach((c) => io.observe(c)))
    } else {
      for (const c of canvases) await drawPage(c)
    }

    // Paint the first page up front so there is never an empty frame.
    await drawPage(canvases[0])
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
    // A mode already built is re-inserted as-is — no re-parse, no re-highlight.
    const cachedEl = rendered.get(mode)
    if (cachedEl) { main.replaceChildren(cachedEl); return }

    main.innerHTML = '<div class="loading">Loading…</div>'
    try {
      if (raw == null) {
        const res = await fetch(location.pathname + '?raw=1')
        if (!res.ok) throw new Error(res.status)
        raw = cfg.kind === 'pdf' ? await res.arrayBuffer() : await res.text()
      }
      let el
      if (cfg.kind === 'pdf') {
        el = await renderPdf(raw.slice(0))
      } else {
        let text = raw
        let clipped = false
        if (text.length > RENDER_MAX) {
          text = text.slice(0, RENDER_MAX)
          clipped = true
        }
        el = mode === 'source' ? await renderSource(text) : await renderRendered(text)
        if (clipped) {
          const wrap = document.createElement('div')
          const note = document.createElement('p')
          note.className = 'loading'
          note.textContent = 'showing the first ' + Math.round(RENDER_MAX / 1048576) +
            ' MB of this file — use Raw or Download for all of it'
          wrap.appendChild(note)
          wrap.appendChild(el)
          el = wrap
        }
      }
      rendered.set(mode, el)
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
