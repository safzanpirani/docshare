---
name: docshare
description: Upload a local file or image to a docshare instance (default https://docs.safzan.dev) and return a 24h-TTL download URL. Use when the user wants to share a local file with another LLM/agent, hand a build artifact / log / screenshot / document to a remote tool, or asks to "upload this", "give me a link to this file", "docshare it", "share this with the other agent". Files up to 300 MB are supported.
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
- The file is > 300 MB (docshare will reject it)
- The user already has their own hosting and didn't ask for docshare

## How to invoke

The script lives next to this SKILL.md, named `upload.sh`. Pure bash + curl,
no other deps. Run it with the file path; it prints the download URL on
stdout and exits 0, or prints an error to stderr and exits non-zero.

```bash
~/.claude/skills/docshare/upload.sh /path/to/file
```

## Reporting the result

Reply with **just the URL on its own line** so the user (or the next tool) can
copy it directly. Don't wrap it in markdown link syntax unless the user asked
for a link. Mention the 24 h TTL only if the user seems unaware of it.

## Pointing at a different deployment

If the user has their own docshare worker, set `DOCSHARE_ENDPOINT`:

```bash
DOCSHARE_ENDPOINT=https://your.example ~/.claude/skills/docshare/upload.sh /path/to/file
```

## What the script does under the hood

Uses the 3-step presigned flow (works for the full 1 byte → 300 MB range):

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

- 300 MB max per file
- 5 uploads / 1.5 GB per IP per day (sustained)
- 2 uploads per 60 s (burst)
- 24 h TTL on all stored objects
