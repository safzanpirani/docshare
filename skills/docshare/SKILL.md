---
name: docshare
description: Upload a local file or image to a docshare instance (default https://docs.safzan.dev) and return a 24h-TTL share URL. Use when the user wants to share a local file with another LLM/agent, hand a build artifact / log / screenshot / document to a remote tool, or asks to "upload this", "give me a link to this file", "docshare it", "share this with the other agent". Files up to 400 MB are supported. The share URL renders in a browser (markdown, code, PDF, images) and serves raw bytes to curl/agents.
---

# docshare

Upload a local file or image and get back a short download URL that any LLM or
agent can fetch. The default endpoint (https://docs.safzan.dev) auto-deletes
everything after 24 hours.

## When to use this skill

- The user asks to share a local file with another AI/LLM/agent
- The user says "upload this", "share this", "docshare it", "give me a link", "send this to <other tool>"
- You produced a build artifact, log file, screenshot, or document and need a fetchable URL for it
- You need to hand a file to a tool that takes URLs but not file uploads

## When NOT to use

- The user wants a long-lived URL — docshare hard-deletes after 24 h
- The file contains secrets you wouldn't put on a third-party host
- The file is > 400 MB (docshare will reject it)
- The user already has their own hosting and didn't ask for docshare

## How to invoke

Two equivalent scripts live next to this SKILL.md. **Pick the one for the OS
you're running on** — they take the same arg and produce the same output
(download URL on stdout, error on stderr, non-zero exit on failure):

- **macOS / Linux / WSL / git-bash:** `upload.sh` — pure bash + curl
- **Windows (native PowerShell):** `upload.ps1` — pure PowerShell, no curl

```bash
# macOS / Linux / WSL / git-bash
~/.claude/skills/docshare/upload.sh /path/to/file
```

```powershell
# Windows PowerShell (5.1 ships with Windows; or pwsh 7+)
powershell -ExecutionPolicy Bypass -File "$HOME\.claude\skills\docshare\upload.ps1" "C:\path\to\file"
```

Detection rule of thumb: if you're in a Windows shell where `bash` isn't
available, use `upload.ps1`; otherwise `upload.sh`. Both stream the file
without loading it into memory (works fine up to the 400 MB max).

## Reporting the result

Reply with **just the URL on its own line** so the user (or the next tool) can
copy it directly. Don't wrap it in markdown link syntax unless the user asked
for a link. Mention the 24 h TTL only if the user seems unaware of it.

## The share URL renders in a browser

The returned `/d/:id/:filename` URL is dual-purpose, keyed off the `Accept`
header (the response sends `Vary: Accept`):

- **A browser** opening the URL gets a **rendered viewer** — Markdown (`.md`,
  and `.txt`) rendered, code/data syntax-highlighted (with a Rendered ⇄ Source
  toggle), PDFs previewed inline, images/video/audio played inline. Good for
  handing a human a readable link.
- **curl / an agent** (no `text/html` in `Accept`) always gets the **raw
  bytes** as a forced download — so programmatic fetches are unaffected.

Two query params override the default:

- `?raw=1` — always return the raw text/bytes (git-raw style), never the
  viewer. Use this when handing a text/markdown/code file to **another agent**
  that should read the content, not the HTML shell.
- `?dl=1` — always force a download, even in a browser.

So: give a **human** the plain URL (nice preview); give **another agent** the
URL with `?raw=1` if it needs to read file contents directly.

## Pointing at a different deployment

If the user has their own docshare worker, set `DOCSHARE_ENDPOINT`:

```bash
# macOS / Linux
DOCSHARE_ENDPOINT=https://your.example ~/.claude/skills/docshare/upload.sh /path/to/file
```

```powershell
# Windows PowerShell
$env:DOCSHARE_ENDPOINT = 'https://your.example'
powershell -ExecutionPolicy Bypass -File "$HOME\.claude\skills\docshare\upload.ps1" "C:\path\to\file"
```

## What the script does under the hood

Uses the 3-step presigned flow (works for the full 1 byte → 400 MB range):

1. `POST {endpoint}/api/doc/presign` with `{filename, size, contentType}` →
   gets back `{id, putUrl, downloadUrl}`
2. `PUT` the raw file bytes to `putUrl` (which is a short-lived presigned R2
   S3 URL — the bytes go straight to R2, not through the Worker)
3. `POST {endpoint}/api/doc/finalize` with `{id}` to confirm + enforce size

For files ≤ 100 MB, a single-curl alternative also exists:

```bash
curl -T file.pdf {endpoint}/upload/file.pdf
```

Response body is the download URL. The script uses the presigned flow
uniformly so the same code path handles every size.

## Limits on the public endpoint

- 400 MB max per file
- 10 uploads / 1.5 GB per IP per day (sustained)
- 2 uploads per 60 s (burst)
- 24 h TTL on all stored objects
