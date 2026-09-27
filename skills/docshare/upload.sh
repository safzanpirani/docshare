#!/usr/bin/env bash
# docshare — upload files to a docshare instance and manage your uploads.
#
#   upload.sh [options] <file|->...     upload; prints one URL per file
#   upload.sh ls [--json]               list your uploads (newest first)
#   upload.sh rm <url|id>... | --all    delete uploads
#   upload.sh usage [--json]            daily quota and service storage
#   upload.sh make-room [bytes] [--dry-run]
#                                       delete your oldest uploads until
#                                       <bytes> more fits
#
# Stdout carries only results (URLs or JSON); progress and errors go to stderr.
# Pure bash + curl, no python, no jq. Run with --help for every option.

set -euo pipefail

ENDPOINT="${DOCSHARE_ENDPOINT:-https://docs.safzan.dev}"
ENDPOINT="${ENDPOINT%/}"
TOKEN_FILE="${DOCSHARE_TOKEN_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/docshare/owner-token}"

# Exit codes callers can branch on.
EX_SERVER=2   # network failure or unexpected server response
EX_LIMIT=3    # a cap or rate limit refused the request
EX_USAGE=64
EX_NOINPUT=66
EX_UNAVAILABLE=69

usage() {
  cat <<'EOF'
usage: docshare [options] <file|->...        upload files, print one URL each
       docshare ls [--json]                  list your uploads
       docshare rm <url|id>... | rm --all    delete uploads
       docshare usage [--json]               daily quota + service storage
       docshare make-room [bytes] [--dry-run]
                                             delete your oldest uploads until
                                             <bytes> more fits (default: 1 upload)

upload options:
  --raw          print the ?raw=1 URL (give this to another agent to read)
  --json         print one JSON object per file: id, url, rawUrl, filename,
                 size, expiresAt
  --make-room    if a daily/storage cap blocks the upload, delete your oldest
                 uploads to fit it (reported on stderr)
  -n, --name N   filename for stdin (-) uploads (default: stdin.txt)
  -q, --quiet    no progress output

environment:
  DOCSHARE_ENDPOINT     server (default https://docs.safzan.dev)
  DOCSHARE_OWNER_TOKEN  owner token; default is read from, or created in,
                        ~/.config/docshare/owner-token
  DOCSHARE_ADMIN_KEY    admin key for the instance owner (bigger files, no
                        daily cap)

exit codes: 0 ok, 2 server/network error, 3 refused by a cap or rate limit,
64 bad usage, 66 missing file
EOF
}

die() { echo "docshare: $1" >&2; exit "${2:-1}"; }
say() { [ "$QUIET" = 1 ] || echo "$1" >&2; }

command -v curl >/dev/null || die "curl is required but not found on PATH" "$EX_UNAVAILABLE"

# ---------------------------------------------------------------- JSON helpers

# Escape a string for a JSON string literal.
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
}

# Pull one field out of a flat JSON object. The server's responses are flat
# per item, so a regex that honours escaped quotes is enough.
json_field() { # json_field <json> <key>
  local json=$1 key=$2 m
  m=$(printf '%s' "$json" | grep -oE "\"$key\":(\"([^\"\\\\]|\\\\.)*\"|-?[0-9.]+|true|false|null)" | head -n1) || true
  m=${m#\"$key\":}
  case "$m" in
    \"*) m=${m#\"}; m=${m%\"}; m=${m//\\\"/\"}; m=${m//\\\//\/}; m=${m//\\\\/\\} ;;
  esac
  printf '%s' "$m"
}

# Split {"items":[{...},{...}]} into one object per line.
json_items() {
  printf '%s' "$1" | sed -e 's/^.*"items":\[//' -e 's/\][^]]*$//' | sed 's/},{/}\
{/g' | grep '^{' || true
}

human_size() {
  local b=${1:-0}
  if [ "$b" -ge 1073741824 ]; then awk "BEGIN{printf \"%.1f GB\", $b/1073741824}"
  elif [ "$b" -ge 1048576 ]; then awk "BEGIN{printf \"%.1f MB\", $b/1048576}"
  elif [ "$b" -ge 1024 ]; then awk "BEGIN{printf \"%.0f KB\", $b/1024}"
  else printf '%s B' "$b"; fi
}

# Minutes or hours until an epoch-ms timestamp.
time_left() {
  local ms=${1:-0} now left
  now=$(date +%s)
  left=$(( ms / 1000 - now ))
  if [ "$left" -le 0 ]; then printf 'expired'
  elif [ "$left" -ge 3600 ]; then printf '%dh left' $(( left / 3600 ))
  else printf '%dm left' $(( left / 60 )); fi
}

# ---------------------------------------------------------------- identity

# The owner token proves which uploads are yours (for ls/rm/make-room). The
# server stores only its hash. It is a credential, so it never goes in argv:
# headers reach curl through a private config file.
owner_token() {
  if [ -n "${DOCSHARE_OWNER_TOKEN:-}" ]; then printf '%s' "$DOCSHARE_OWNER_TOKEN"; return; fi
  if [ ! -s "$TOKEN_FILE" ]; then
    mkdir -p "$(dirname "$TOKEN_FILE")"
    ( umask 077
      LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 32 >"$TOKEN_FILE" )
  fi
  tr -d '[:space:]' <"$TOKEN_FILE"
}

HDRCFG=""
TMPIN=""
cleanup() { rm -f "$HDRCFG" "$TMPIN"; }
trap cleanup EXIT

header_config() {
  [ -n "$HDRCFG" ] && return
  HDRCFG=$(mktemp "${TMPDIR:-/tmp}/docshare.XXXXXX")
  chmod 600 "$HDRCFG"
  printf 'header = "x-owner-token: %s"\n' "$(owner_token)" >>"$HDRCFG"
  if [ -n "${DOCSHARE_ADMIN_KEY:-}" ]; then
    printf 'header = "x-admin-key: %s"\n' "$DOCSHARE_ADMIN_KEY" >>"$HDRCFG"
  fi
}

# ---------------------------------------------------------------- HTTP

# api <METHOD> <path> [json-body] — sets STATUS and BODY; never exits.
STATUS=0
BODY=""
api() {
  header_config
  local out args=(--silent --show-error --connect-timeout 20 --max-time 120 -K "$HDRCFG" -X "$1"
    -H 'accept: application/json' -w '\n%{http_code}')
  [ $# -ge 3 ] && args+=(-H 'content-type: application/json' --data "$3")
  if ! out=$(curl "${args[@]}" "$ENDPOINT$2" 2>&1); then
    STATUS=0; BODY=$out; return 0
  fi
  STATUS=${out##*$'\n'}
  BODY=${out%$'\n'*}
}

# Explain a failed response and exit with the matching code.
fail_response() { # fail_response <what>
  local what=$1 err hint extra=""
  [ "$STATUS" != 0 ] || die "$what: cannot reach $ENDPOINT: $BODY" "$EX_SERVER"
  err=$(json_field "$BODY" error)
  [ -n "$err" ] || die "$what: HTTP $STATUS: $(printf '%s' "$BODY" | head -c 300)" "$EX_SERVER"
  case "$err" in
    daily_count)
      extra=" (used $(json_field "$BODY" used) of $(json_field "$BODY" limit) uploads today; resets $(json_field "$BODY" resetsAt))"
      hint="rerun with --make-room to delete your oldest uploads, or free space with 'docshare ls' + 'docshare rm'" ;;
    daily_bytes)
      extra=" ($(human_size "$(json_field "$BODY" used)") of $(human_size "$(json_field "$BODY" limit)") used today; resets $(json_field "$BODY" resetsAt))"
      hint="rerun with --make-room to delete your oldest uploads, or free space with 'docshare ls' + 'docshare rm'" ;;
    storage_full)
      hint="rerun with --make-room to delete your oldest uploads, or retry later" ;;
    cannot_make_room)
      hint=$(json_field "$BODY" hint) ;;
    too_large)
      extra=" (max $(human_size "$(json_field "$BODY" max)"))" ;;
    *) hint=$(json_field "$BODY" hint) ;;
  esac
  echo "docshare: $what: $err$extra" >&2
  [ -z "$hint" ] || echo "docshare: hint: $hint" >&2
  case "$STATUS" in 409|429|507) exit "$EX_LIMIT" ;; *) exit "$EX_SERVER" ;; esac
}

ok() { [ "$STATUS" -ge 200 ] 2>/dev/null && [ "$STATUS" -lt 300 ]; }

# Report items a make-room pass deleted, from an `evicted`/`deleted` array.
report_deleted() { # report_deleted <json> <key> <verb>
  local list names
  list=$(printf '%s' "$1" | grep -oE "\"$2\":\[[^]]*\]" | head -n1) || true
  [ -n "$list" ] || return 0
  names=$(printf '%s' "$list" | grep -oE '"filename":"([^"\\]|\\.)*"' | sed -e 's/^"filename":"//' -e 's/"$//' | paste -sd, - | sed 's/,/, /g')
  [ -z "$names" ] || echo "docshare: $3: $names" >&2
}

# ---------------------------------------------------------------- upload

mime_for() { # mime_for <path> <name>
  local mime
  mime=$(file --mime-type -b "$1" 2>/dev/null || true)
  [ -n "$mime" ] || mime="application/octet-stream"
  # `file` labels Android packages as zip, and Android then refuses to install
  # from the share URL. Declare the real type for extensions that matter.
  case "$2" in
    *.apk) mime="application/vnd.android.package-archive" ;;
    *.ipa) mime="application/octet-stream" ;;
    *.md) mime="text/markdown" ;;
  esac
  printf '%s' "$mime"
}

upload_one() { # upload_one <path> <name>
  local path=$1 name=$2 size mime body id puturl dlurl progress attempt waited=0
  size=$(wc -c <"$path" | tr -d ' ')
  [ "$size" -gt 0 ] || die "$name: file is empty" 65
  mime=$(mime_for "$path" "$name")

  # 1) presign — reserves an id, charges the daily quota, returns a PUT URL.
  body="{\"filename\":$(json_str "$name"),\"size\":$size,\"contentType\":$(json_str "$mime")"
  [ "$MAKE_ROOM" = 1 ] && body="$body,\"makeRoom\":true"
  body="$body}"
  while :; do
    say "Preparing $name ($(human_size "$size"))"
    api POST /api/doc/presign "$body"
    # The burst limit is two uploads a minute; wait it out rather than fail a
    # multi-file run halfway.
    if [ "$STATUS" = 429 ] && [ "$(json_field "$BODY" error)" = rate_limited ] && [ "$waited" -lt 3 ]; then
      local after
      after=$(json_field "$BODY" retryAfter)
      after=${after:-60}
      echo "docshare: rate limited; waiting ${after}s" >&2
      sleep "$after"
      waited=$((waited + 1))
      continue
    fi
    break
  done
  ok || fail_response "$name"
  report_deleted "$BODY" evicted "made room by deleting"
  id=$(json_field "$BODY" id)
  puturl=$(json_field "$BODY" putUrl)
  dlurl=$(json_field "$BODY" downloadUrl)
  [ -n "$id" ] && [ -n "$puturl" ] && [ -n "$dlurl" ] || die "$name: presign returned incomplete upload metadata" "$EX_SERVER"
  local presigned=$BODY

  # 2) PUT the bytes straight to R2. curl streams the file. A stalled transfer
  # fails within 60 s; every attempt has a 15 min ceiling.
  progress=(--silent)
  [ "$QUIET" = 1 ] || [ ! -t 2 ] || progress=(--progress-bar)
  for attempt in 1 2 3; do
    say "Uploading $name, attempt $attempt/3"
    # The signed URL is a temporary credential: feed it through stdin, not argv.
    if printf 'url = "%s"\n' "$puturl" | curl --config - --fail --show-error "${progress[@]}" \
      --connect-timeout 20 --max-time 900 --speed-limit 1024 --speed-time 60 -X PUT \
      -H "content-type: $mime" --data-binary "@$path" --output /dev/null; then
      break
    fi
    [ "$attempt" -lt 3 ] || die "$name: upload failed after 3 attempts; not finalized" "$EX_SERVER"
    say "Upload interrupted; retrying in 2 seconds"
    sleep 2
  done

  # 3) finalize — confirms the object landed and enforces the size cap.
  say "Finalizing $name"
  api POST /api/doc/finalize "{\"id\":\"$id\"}"
  ok || fail_response "$name: finalize"

  if [ "$JSON" = 1 ]; then
    printf '{"id":"%s","url":%s,"rawUrl":%s,"filename":%s,"size":%s,"expiresAt":%s}\n' \
      "$id" "$(json_str "$dlurl")" "$(json_str "$dlurl?raw=1")" "$(json_str "$name")" "$size" \
      "$(json_field "$presigned" expiresAt)"
  elif [ "$RAW" = 1 ]; then
    echo "$dlurl?raw=1"
  else
    echo "$dlurl"
  fi
}

cmd_upload() {
  local files=() name="" arg
  while [ $# -gt 0 ]; do
    case "$1" in
      --raw) RAW=1 ;;
      --json) JSON=1 ;;
      --make-room) MAKE_ROOM=1 ;;
      -q|--quiet) QUIET=1 ;;
      -n|--name) [ $# -ge 2 ] || die "--name needs a value" "$EX_USAGE"; name=$2; shift ;;
      --name=*) name=${1#--name=} ;;
      -h|--help) usage; exit 0 ;;
      --) shift; files+=("$@"); break ;;
      -) files+=("-") ;;
      -*) die "unknown option: $1 (see --help)" "$EX_USAGE" ;;
      *) files+=("$1") ;;
    esac
    shift
  done
  [ ${#files[@]} -gt 0 ] || { usage >&2; exit "$EX_USAGE"; }
  for arg in "${files[@]}"; do
    [ "$arg" = - ] || [ -f "$arg" ] || die "no such file: $arg" "$EX_NOINPUT"
  done
  for arg in "${files[@]}"; do
    if [ "$arg" = - ]; then
      [ -z "$TMPIN" ] || die "stdin (-) can only be uploaded once" "$EX_USAGE"
      TMPIN=$(mktemp "${TMPDIR:-/tmp}/docshare-stdin.XXXXXX")
      cat >"$TMPIN"
      upload_one "$TMPIN" "${name:-stdin.txt}"
    else
      upload_one "$arg" "$(basename "$arg")"
    fi
  done
}

# ---------------------------------------------------------------- manage

cmd_ls() {
  local json=0 item kind
  while [ $# -gt 0 ]; do
    case "$1" in --json) json=1 ;; -h|--help) usage; exit 0 ;; *) die "unknown ls option: $1" "$EX_USAGE" ;; esac
    shift
  done
  api GET /api/mine
  ok || fail_response "ls"
  if [ "$json" = 1 ]; then printf '%s\n' "$BODY"; return; fi
  local items
  items=$(json_items "$BODY")
  if [ -z "$items" ]; then echo "docshare: no uploads" >&2; return; fi
  while IFS= read -r item; do
    kind=$(json_field "$item" kind)
    printf '%s\t%s\t%s\t%s\t%s%s\n' \
      "$(json_field "$item" id)" \
      "$(human_size "$(json_field "$item" size)")" \
      "$(time_left "$(json_field "$item" expiresAt)")" \
      "$( [ "$kind" = image ] && echo "image.$(json_field "$item" format)" || json_field "$item" filename)" \
      "$(json_field "$item" url)" \
      "$( [ "$(json_field "$item" matchedBy)" = token ] || printf '\t(same IP, not your token)' )"
  done <<<"$items"
}

# Accept a share URL (/d/<id>/..., /i/<id>.webp) or a bare id.
id_from() {
  local ref=$1 id
  case "$ref" in
    *"/d/"*) id=${ref#*/d/}; id=${id%%[/?#]*} ;;
    *"/i/"*) id=${ref#*/i/}; id=${id%%.*} ;;
    *) id=$ref ;;
  esac
  printf '%s' "$id" | grep -qE '^[A-Za-z0-9]{8,32}$' || die "not a docshare URL or id: $ref" "$EX_USAGE"
  printf '%s' "$id"
}

cmd_rm() {
  local refs=() all=0 ref id failed=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --all) all=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) die "unknown rm option: $1" "$EX_USAGE" ;;
      *) refs+=("$1") ;;
    esac
    shift
  done
  if [ "$all" = 1 ]; then
    # Only uploads made with this owner token. /api/mine also lists untagged
    # uploads from the same public IP, which can belong to someone else on the
    # network (or to you from another tool); those need an explicit `rm <id>`.
    local skipped=0
    api GET /api/mine
    ok || fail_response "rm --all"
    while IFS= read -r item; do
      [ -n "$item" ] || continue
      if [ "$(json_field "$item" matchedBy)" = token ]; then refs+=("$(json_field "$item" id)")
      else skipped=$((skipped + 1)); fi
    done <<<"$(json_items "$BODY")"
    [ "$skipped" = 0 ] || echo "docshare: skipped $skipped upload(s) not made with your owner token; delete them by id if they are yours" >&2
    [ ${#refs[@]} -gt 0 ] || { echo "docshare: no uploads to delete" >&2; return; }
  fi
  [ ${#refs[@]} -gt 0 ] || die "usage: docshare rm <url|id>... | --all" "$EX_USAGE"
  for ref in "${refs[@]}"; do
    id=$(id_from "$ref")
    api POST /api/delete "{\"id\":\"$id\"}"
    if ok; then echo "deleted $id"
    elif [ "$STATUS" = 404 ]; then echo "docshare: $id: already gone" >&2
    else echo "docshare: $id: delete failed (HTTP $STATUS) $(json_field "$BODY" error)" >&2; failed=1
    fi
  done
  [ "$failed" = 0 ] || exit "$EX_SERVER"
}

cmd_usage() {
  local json=0
  while [ $# -gt 0 ]; do
    case "$1" in --json) json=1 ;; -h|--help) usage; exit 0 ;; *) die "unknown usage option: $1" "$EX_USAGE" ;; esac
    shift
  done
  api GET /api/usage
  ok || fail_response "usage"
  if [ "$json" = 1 ]; then printf '%s\n' "$BODY"; return; fi
  local daily storage
  daily=$(printf '%s' "$BODY" | grep -oE '"daily":\{[^}]*\}')
  storage=$(printf '%s' "$BODY" | grep -oE '"storage":\{[^}]*\}')
  printf 'today:   %s/%s uploads, %s/%s (resets 00:00 UTC)\n' \
    "$(json_field "$daily" count)" "$(json_field "$daily" countMax)" \
    "$(human_size "$(json_field "$daily" bytes)")" "$(human_size "$(json_field "$daily" bytesMax)")"
  printf 'storage: %s/%s service-wide\n' \
    "$(human_size "$(json_field "$storage" used)")" "$(human_size "$(json_field "$storage" cap)")"
  local max
  max=$(json_field "$BODY" docMax)
  [ -z "$max" ] || printf 'max file: %s%s\n' "$(human_size "$max")" \
    "$( [ "$(json_field "$BODY" admin)" = true ] && echo ' (admin)' )"
}

cmd_make_room() {
  local bytes=0 dry=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=true ;;
      -h|--help) usage; exit 0 ;;
      *[!0-9]*|'') die "make-room takes a byte count, got: $1" "$EX_USAGE" ;;
      *) bytes=$1 ;;
    esac
    shift
  done
  api POST /api/make-room "{\"bytes\":$bytes,\"dryRun\":$dry}"
  ok || { report_deleted "$BODY" wouldDelete "deleting all of these would still not be enough"; fail_response "make-room"; }
  if [ "$dry" = true ]; then
    report_deleted "$BODY" wouldDelete "would delete"
    printf '%s' "$BODY" | grep -q '"wouldDelete":\[\]' && echo "docshare: nothing to delete; the upload already fits" >&2
  else
    report_deleted "$BODY" deleted "deleted"
    printf '%s' "$BODY" | grep -q '"deleted":\[\]' && echo "docshare: nothing to delete; the upload already fits" >&2
  fi
  return 0
}

# ---------------------------------------------------------------- main

RAW=0
JSON=0
MAKE_ROOM=0
QUIET=0

[ $# -gt 0 ] || { usage >&2; exit "$EX_USAGE"; }
case "$1" in
  -h|--help|help) usage ;;
  ls|list) shift; cmd_ls "$@" ;;
  rm|delete) shift; cmd_rm "$@" ;;
  usage|quota) shift; cmd_usage "$@" ;;
  make-room) shift; cmd_make_room "$@" ;;
  # A file literally named like a subcommand still uploads: `docshare ./ls`.
  *) cmd_upload "$@" ;;
esac
