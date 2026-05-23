#!/usr/bin/env bash
# docshare upload — presign → PUT → finalize.
#
# Usage:   upload.sh <file>
# Env:     DOCSHARE_ENDPOINT   override default https://docs.safzan.dev
#
# Prints the download URL on stdout on success; an error on stderr with a
# non-zero exit code on failure. Pure bash + curl, no python, no jq.

set -euo pipefail

ENDPOINT="${DOCSHARE_ENDPOINT:-https://docs.safzan.dev}"
ENDPOINT="${ENDPOINT%/}"

die() { echo "$1" >&2; exit "${2:-1}"; }

[ "$#" -eq 1 ] || die "usage: $(basename "$0") <file>" 64
[ "$1" = "-h" ] || [ "$1" = "--help" ] && die "usage: $(basename "$0") <file>" 0
FILE="$1"
[ -f "$FILE" ] || die "no such file: $FILE" 66

command -v curl >/dev/null || die "curl is required but not found on PATH" 69

NAME=$(basename "$FILE")
SIZE=$(wc -c <"$FILE" | tr -d ' ')
[ "$SIZE" -gt 0 ] || die "file is empty" 65

# Best-effort mime guess; fall back to octet-stream. `file` is on macOS + every
# Linux distro; if it's missing or fails we just send the generic type.
MIME=$(file --mime-type -b "$FILE" 2>/dev/null || echo "application/octet-stream")
[ -z "$MIME" ] && MIME="application/octet-stream"

# 1) presign — POST {filename,size,contentType}, get back {id,putUrl,downloadUrl}
RESP=$(curl -fsS -X POST "$ENDPOINT/api/doc/presign" \
  -H 'content-type: application/json' \
  --data "{\"filename\":\"$NAME\",\"size\":$SIZE,\"contentType\":\"$MIME\"}") \
  || die "presign request failed" 2

# Pull a single string field out of the flat JSON response. The response has no
# nested objects/quotes and putUrl is URL-encoded, so a literal grep is safe.
get_field() {
  printf '%s' "$RESP" | grep -o "\"$1\":\"[^\"]*\"" | sed "s/\"$1\":\"\(.*\)\"/\\1/"
}
ID=$(get_field id)
PUTURL=$(get_field putUrl)
DLURL=$(get_field downloadUrl)
[ -n "$PUTURL" ] || die "presign returned no putUrl: $RESP" 2

# 2) PUT the bytes straight to R2 — curl streams the file, no RAM blow-up
curl -fsS -X PUT "$PUTURL" \
  -H "content-type: $MIME" \
  --data-binary "@$FILE" >/dev/null \
  || die "upload PUT to R2 failed" 2

# 3) finalize — confirms the upload landed, enforces the max size on the server
curl -fsS -X POST "$ENDPOINT/api/doc/finalize" \
  -H 'content-type: application/json' \
  --data "{\"id\":\"$ID\"}" >/dev/null \
  || die "finalize request failed" 2

echo "$DLURL"
