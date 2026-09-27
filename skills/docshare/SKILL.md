---
name: docshare
description: Upload local files, piped output, or images to a docshare instance (default https://docs.safzan.dev) and get a 24h share URL, then list, delete, or make room among your own uploads. Use when the user wants to share a local file with another LLM/agent, hand a build artifact / log / screenshot / document to a remote tool, or says "upload this", "give me a link to this file", "docshare it", "share this with the other agent". Also use when a docshare upload fails on a daily or storage limit, or the user wants to see or delete what they uploaded. Files up to 400 MB. The URL renders in a browser (markdown, code, PDF, media) and serves raw bytes to curl/agents.
---

# docshare

Upload a file and get back a short URL that any person, LLM, or agent can
fetch. Everything auto-deletes after 24 hours.

## Commands

Try `docshare` first: it is on PATH wherever the launcher is installed (a
one-line wrapper around the script, `docshare.cmd` on Windows). Otherwise run
the script next to this file: `upload.sh` (macOS, Linux, WSL, git-bash) or
`upload.ps1` (native Windows PowerShell). Both take the same commands. On
Windows the switches are PowerShell style (`-Json`, `-Raw`, `-MakeRoom`).

```bash
docshare report.pdf                 # prints the share URL
docshare a.log b.log c.png          # one URL per line, in order
some-cmd 2>&1 | docshare - -n build.log   # upload piped output
docshare --raw notes.md             # URL with ?raw=1, for another agent to read
docshare --json dist.zip            # {"id","url","rawUrl","filename","size","expiresAt"}
docshare --make-room big.zip        # if a limit blocks it, delete your oldest uploads first

docshare ls                         # your uploads: id, size, time left, name, URL
docshare rm <url-or-id>...          # delete specific uploads
docshare rm --all                   # delete every upload made with your token
docshare usage                      # today's quota and service storage
docshare make-room 50000000 --dry-run   # what would be deleted to fit 50 MB
```

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\.claude\skills\docshare\upload.ps1" C:\path\to\file
# same subcommands: ls, rm, usage, make-room; switches: -Raw -Json -MakeRoom -Quiet -All -DryRun
# piped input: use -Stdin -Name build.log (Windows PowerShell 5.1 rejects a bare '-')
```

Stdout carries only results (URLs or JSON). Progress and errors go to stderr.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | success | |
| 2 | network or server error | read the stderr line; retry once |
| 3 | a daily/storage cap or rate limit refused it | see "When an upload is refused" |
| 64 | bad arguments | check `--help` |
| 66 | file not found | fix the path |

## Which URL to hand over

- **A human** gets the plain URL. In a browser it renders Markdown and `.txt`,
  syntax-highlights code, previews PDFs, and plays images, video, and audio.
- **Another agent that should read the contents** gets the `--raw` URL
  (`?raw=1`), so it receives the text instead of the HTML viewer.
- **A binary download**: append `?dl=1` to force a download in browsers.
  `.apk` files are served as `application/vnd.android.package-archive`, so
  Android installs them.

curl and agents fetching the plain URL (no `text/html` in `Accept`) always get
raw bytes, so the plain URL also works for programmatic fetches.

Reply with **just the URL on its own line** so it can be copied. Mention the
24 h expiry only if the user seems unaware of it.

## When an upload is refused (exit 3)

The stderr line names the limit, and the numbers behind it:

- `daily_count` / `daily_bytes`: the per-IP daily cap (10 uploads, 1.5 GB).
  It resets at 00:00 UTC.
- `storage_full`: the service-wide storage cap.
- `rate_limited`: the burst limit of 2 uploads per minute. The script
  already waits it out and retries, so this rarely surfaces.

To get past a cap, delete your own older uploads:

1. `docshare make-room <bytes> --dry-run` shows what would go. Pass the size
   of the file you want to upload.
2. If the user is fine losing those, rerun the upload with `--make-room`. It
   deletes the oldest uploads that free enough space and reports them on stderr.
   Or pick files yourself with `docshare ls` and `docshare rm`.

Deleting a file uploaded today from the same network refunds that day's quota.
Make-room considers only uploads made with this machine's owner token. When
those are not enough, it deletes nothing and says so (`cannot_make_room`).

Deleting is irreversible. Before `--make-room`, `rm --all`, or `rm` on files
you did not upload in this session, confirm with the user, unless they
already told you to free space.

## Ownership

The script creates an owner token once in `~/.config/docshare/owner-token`
(mode 600) and sends it with every request. The server stores only its hash.
The token is what lets `ls`, `rm --all`, and `make-room` find your uploads
later. Keep it private. `DOCSHARE_OWNER_TOKEN` overrides it.

`ls` also shows untagged uploads from the same public IP, marked
`(same IP, not your token)`. Those may belong to someone else on the network,
or to the user from the web UI or a plain `curl`. `rm --all` and make-room
skip them. Delete one only by explicit id, and only when you know whose it is.

## Sending a file to Safzan on Telegram

docshare is the **fallback** for that, not the default. Telegram's bot upload
limit is 50 MB:

- **Under 50 MB**: send the file itself with `tg file <path> -d -c "<caption>"`.
  It arrives as a document he can open directly.
- **Over 50 MB**: upload here, then send the URL with `tg send`. Say why it is
  a link and that it expires in 24 h.

## When not to use

- The user wants a long-lived URL. Uploads are deleted after 24 h.
- The file contains secrets you wouldn't put on a third-party host.
- The file is over 400 MB.
- The user already has their own hosting and didn't ask for docshare.

## Other deployments and the admin key

- `DOCSHARE_ENDPOINT=https://your.example docshare file` targets another
  docshare deployment.
- `DOCSHARE_ADMIN_KEY` (instance owner only) raises the per-file cap to
  1.46 GB and skips the daily cap. The script sends it in a header file, never
  in argv.

## Raw API (no script)

The full API reference is at <https://docs.safzan.dev/llms.txt>. The shortest
forms:

```bash
T=$(cat ~/.config/docshare/owner-token)
curl -sT file.txt -H "x-owner-token: $T" -H 'accept: application/json' \
  https://docs.safzan.dev/upload/file.txt           # ≤100 MB; JSON with id/url/rawUrl
curl -s -X DELETE -H "x-owner-token: $T" <share URL>  # delete
curl -s -H "x-owner-token: $T" https://docs.safzan.dev/api/mine   # list
```

Files over 100 MB use the three-step presigned flow
(`/api/doc/presign` → PUT to R2 → `/api/doc/finalize`). The script always
uses that flow. Errors are JSON `{"error": "<code>", "hint": "..."}`.
