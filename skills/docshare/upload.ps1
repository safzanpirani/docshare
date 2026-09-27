# docshare — upload files to a docshare instance and manage your uploads.
#
#   .\upload.ps1 [options] <file|->...     upload; prints one URL per file
#   .\upload.ps1 ls [-Json]                list your uploads (newest first)
#   .\upload.ps1 rm <url|id>... | rm -All  delete uploads
#   .\upload.ps1 usage [-Json]             daily quota and service storage
#   .\upload.ps1 make-room [bytes] [-DryRun]
#                                          delete your oldest uploads until
#                                          <bytes> more fits
#
# Upload options: -Raw (print the ?raw=1 URL), -Json (one JSON object per
# file), -MakeRoom (delete your oldest uploads if a cap blocks the upload),
# -Stdin (upload piped input; same as '-'), -Name <n> (filename for stdin),
# -Quiet. Windows PowerShell 5.1 refuses a bare '-' after -File (exit 5), so
# use -Stdin there.
#
# Stdout carries only results; progress and errors go to stderr. Exit codes:
# 0 ok, 2 server/network error, 3 refused by a cap or rate limit, 64 bad usage,
# 66 missing file. Pure PowerShell — no curl, no jq, no python. Works on
# Windows PowerShell 5.1 and PowerShell 7+ (pwsh) on any OS.
#
# Env: DOCSHARE_ENDPOINT (default https://docs.safzan.dev),
#      DOCSHARE_OWNER_TOKEN (default: ~/.config/docshare/owner-token, created
#      on first use), DOCSHARE_ADMIN_KEY.
#
# If you hit "running scripts is disabled on this system", invoke with:
#   powershell -ExecutionPolicy Bypass -File upload.ps1 <file>

param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Args_,
  [switch]$Raw,
  [switch]$Json,
  [switch]$MakeRoom,
  [switch]$Quiet,
  [switch]$All,
  [switch]$DryRun,
  [switch]$Stdin,
  [string]$Name = 'stdin.txt'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # PS 5.1's progress bar slows uploads badly

$EX_SERVER = 2; $EX_LIMIT = 3; $EX_USAGE = 64; $EX_NOINPUT = 66

function Die($Message, $Code = 1) {
  [Console]::Error.WriteLine("docshare: $Message")
  exit $Code
}
function Say($Message) { if (-not $Quiet) { [Console]::Error.WriteLine($Message) } }

$endpoint = if ($env:DOCSHARE_ENDPOINT) { $env:DOCSHARE_ENDPOINT.TrimEnd('/') } else { 'https://docs.safzan.dev' }

# ---------------------------------------------------------------- identity

# The owner token proves which uploads are yours (for ls/rm/make-room). The
# server stores only its hash. Same file as upload.sh, so both share one
# identity on a machine that has both.
function Get-OwnerToken {
  if ($env:DOCSHARE_OWNER_TOKEN) { return $env:DOCSHARE_OWNER_TOKEN }
  $file = Join-Path (Join-Path (Join-Path $HOME '.config') 'docshare') 'owner-token'
  if (-not (Test-Path -LiteralPath $file) -or -not (Get-Content -LiteralPath $file -Raw)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
    $chars = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    [System.IO.File]::WriteAllText($file, $token)
  }
  return (Get-Content -LiteralPath $file -Raw).Trim()
}

function Get-Headers {
  $h = @{ 'x-owner-token' = (Get-OwnerToken); 'accept' = 'application/json' }
  if ($env:DOCSHARE_ADMIN_KEY) { $h['x-admin-key'] = $env:DOCSHARE_ADMIN_KEY }
  return $h
}

# ---------------------------------------------------------------- HTTP

# Returns @{ Status; Body (parsed JSON or $null); Text }. Never throws for an
# HTTP error status, so callers can read the server's error body.
function Invoke-Api($Method, $Path, $Body) {
  $params = @{ Method = $Method; Uri = "$endpoint$Path"; Headers = (Get-Headers); UseBasicParsing = $true }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress -Depth 5))
  }
  try {
    $resp = Invoke-WebRequest @params
    $status = [int]$resp.StatusCode; $text = $resp.Content
  } catch {
    $r = $_.Exception.Response
    if ($null -eq $r) { return @{ Status = 0; Body = $null; Text = $_.Exception.Message } }
    $status = [int]$r.StatusCode
    $text = $_.ErrorDetails.Message
    if (-not $text) {
      try { $text = (New-Object System.IO.StreamReader($r.GetResponseStream())).ReadToEnd() } catch { $text = '' }
    }
  }
  $parsed = $null
  if ($text) { try { $parsed = $text | ConvertFrom-Json } catch { } }
  return @{ Status = $status; Body = $parsed; Text = $text }
}

function Format-Size($b) {
  $b = [double]$b
  if ($b -ge 1GB) { return '{0:N1} GB' -f ($b / 1GB) }
  if ($b -ge 1MB) { return '{0:N1} MB' -f ($b / 1MB) }
  if ($b -ge 1KB) { return '{0:N0} KB' -f ($b / 1KB) }
  return "$b B"
}

function Format-Left($ms) {
  $left = [int](([double]$ms / 1000) - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  if ($left -le 0) { return 'expired' }
  if ($left -ge 3600) { return "$([int][math]::Floor($left / 3600))h left" }
  return "$([int][math]::Floor($left / 60))m left"
}

# Explain a failed response and exit with the matching code.
function Fail($What, $r) {
  if ($r.Status -eq 0) { Die "${What}: cannot reach ${endpoint}: $($r.Text)" $EX_SERVER }
  $b = $r.Body
  if ($null -eq $b -or -not $b.error) { Die "${What}: HTTP $($r.Status): $($r.Text)" $EX_SERVER }
  $roomHint = "rerun with -MakeRoom to delete your oldest uploads, or free space with 'ls' + 'rm'"
  $extra = ''; $hint = $b.hint
  switch ($b.error) {
    'daily_count' { $extra = " (used $($b.used) of $($b.limit) uploads today; resets $($b.resetsAt))"; $hint = $roomHint }
    'daily_bytes' { $extra = " ($(Format-Size $b.used) of $(Format-Size $b.limit) used today; resets $($b.resetsAt))"; $hint = $roomHint }
    'storage_full' { $hint = "rerun with -MakeRoom to delete your oldest uploads, or retry later" }
    'too_large' { $extra = " (max $(Format-Size $b.max))" }
  }
  [Console]::Error.WriteLine("docshare: ${What}: $($b.error)$extra")
  if ($hint) { [Console]::Error.WriteLine("docshare: hint: $hint") }
  if (@(409, 429, 507) -contains $r.Status) { exit $EX_LIMIT }
  exit $EX_SERVER
}

function Test-Ok($r) { return $r.Status -ge 200 -and $r.Status -lt 300 }

function Show-Names($Label, $Items) {
  $list = @($Items | Where-Object { $null -ne $_ })
  if ($list.Count -gt 0) {
    $names = ($list | ForEach-Object { if ($_.filename) { $_.filename } else { $_.id } }) -join ', '
    [Console]::Error.WriteLine("docshare: ${Label}: $names")
  }
}

# ---------------------------------------------------------------- upload

function Get-Mime($Path, $FileName) {
  $ext = [System.IO.Path]::GetExtension($FileName).ToLowerInvariant()
  if ($ext -eq '.apk') { return 'application/vnd.android.package-archive' }
  if ($ext -eq '.md') { return 'text/markdown' }
  # System.Web ships with .NET Framework (PS 5.1 on Windows); PS Core falls
  # back to octet-stream.
  try {
    Add-Type -AssemblyName System.Web -ErrorAction Stop
    $guessed = [System.Web.MimeMapping]::GetMimeMapping($Path)
    if ($guessed) { return $guessed }
  } catch { }
  return 'application/octet-stream'
}

function Send-File($Path, $FileName) {
  $size = (Get-Item -LiteralPath $Path).Length
  if ($size -eq 0) { Die "${FileName}: file is empty" 65 }
  $mime = Get-Mime $Path $FileName

  # 1) presign — reserves an id, charges the daily quota, returns a PUT URL.
  $body = @{ filename = $FileName; size = $size; contentType = $mime }
  if ($MakeRoom) { $body.makeRoom = $true }
  $waited = 0
  while ($true) {
    Say "Preparing $FileName ($(Format-Size $size))"
    $r = Invoke-Api 'Post' '/api/doc/presign' $body
    # The burst limit is two uploads a minute; wait it out rather than fail a
    # multi-file run halfway.
    if ($r.Status -eq 429 -and $r.Body.error -eq 'rate_limited' -and $waited -lt 3) {
      $after = if ($r.Body.retryAfter) { [int]$r.Body.retryAfter } else { 60 }
      [Console]::Error.WriteLine("docshare: rate limited; waiting ${after}s")
      Start-Sleep -Seconds $after
      $waited++
      continue
    }
    break
  }
  if (-not (Test-Ok $r)) { Fail $FileName $r }
  $presign = $r.Body
  Show-Names 'made room by deleting' $presign.evicted
  if (-not $presign.putUrl) { Die "${FileName}: presign returned no putUrl" $EX_SERVER }

  # 2) PUT bytes straight to R2 — -InFile streams the file.
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Say "Uploading $FileName, attempt $attempt/3"
    try {
      Invoke-WebRequest -Method Put -Uri $presign.putUrl -ContentType $mime `
        -InFile $Path -UseBasicParsing -TimeoutSec 900 | Out-Null
      break
    } catch {
      if ($attempt -eq 3) { Die "${FileName}: upload failed after 3 attempts; not finalized ($($_.Exception.Message))" $EX_SERVER }
      Say 'Upload interrupted; retrying in 2 seconds'
      Start-Sleep -Seconds 2
    }
  }

  # 3) finalize — confirms the object landed and enforces the size cap.
  Say "Finalizing $FileName"
  $r = Invoke-Api 'Post' '/api/doc/finalize' @{ id = $presign.id }
  if (-not (Test-Ok $r)) { Fail "${FileName}: finalize" $r }

  $url = $presign.downloadUrl
  if ($Json) {
    [pscustomobject]@{ id = $presign.id; url = $url; rawUrl = "$url`?raw=1"; filename = $FileName; size = $size; expiresAt = $presign.expiresAt } |
      ConvertTo-Json -Compress
  } elseif ($Raw) {
    "$url`?raw=1"
  } else {
    $url
  }
}

function Invoke-Upload($Files) {
  if (-not $Files -or $Files.Count -eq 0) { Die 'usage: upload.ps1 [-Raw] [-Json] [-MakeRoom] <file|->...' $EX_USAGE }
  foreach ($f in $Files) {
    if ($f -ne '-' -and -not (Test-Path -LiteralPath $f -PathType Leaf)) { Die "no such file: $f" $EX_NOINPUT }
  }
  foreach ($f in $Files) {
    if ($f -eq '-') {
      $tmp = [System.IO.Path]::GetTempFileName()
      try {
        $stdin = [Console]::OpenStandardInput()
        $out = [System.IO.File]::OpenWrite($tmp)
        $stdin.CopyTo($out); $out.Close()
        Send-File $tmp $Name
      } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    } else {
      $item = Get-Item -LiteralPath $f
      Send-File $item.FullName $item.Name
    }
  }
}

# ---------------------------------------------------------------- manage

function Invoke-Ls {
  $r = Invoke-Api 'Get' '/api/mine' $null
  if (-not (Test-Ok $r)) { Fail 'ls' $r }
  if ($Json) { $r.Text; return }
  $items = @($r.Body.items | Where-Object { $null -ne $_ })
  if ($items.Count -eq 0) { [Console]::Error.WriteLine('docshare: no uploads'); return }
  foreach ($i in $items) {
    $label = if ($i.kind -eq 'image') { "image.$($i.format)" } else { $i.filename }
    $note = if ($i.matchedBy -eq 'token') { '' } else { "`t(same IP, not your token)" }
    "{0}`t{1}`t{2}`t{3}`t{4}{5}" -f $i.id, (Format-Size $i.size), (Format-Left $i.expiresAt), $label, $i.url, $note
  }
}

# Accept a share URL (/d/<id>/..., /i/<id>.webp) or a bare id.
function Get-IdFrom($Ref) {
  $id = $Ref
  if ($Ref -match '/d/([A-Za-z0-9]+)') { $id = $Matches[1] }
  elseif ($Ref -match '/i/([A-Za-z0-9]+)\.') { $id = $Matches[1] }
  if ($id -notmatch '^[A-Za-z0-9]{8,32}$') { Die "not a docshare URL or id: $Ref" $EX_USAGE }
  return $id
}

function Invoke-Rm($Refs) {
  $ids = @()
  if ($All) {
    $r = Invoke-Api 'Get' '/api/mine' $null
    if (-not (Test-Ok $r)) { Fail 'rm -All' $r }
    # Only uploads made with this owner token. /api/mine also lists untagged
    # uploads from the same public IP, which can belong to someone else on the
    # network (or to you from another tool); those need an explicit `rm <id>`.
    $items = @($r.Body.items | Where-Object { $null -ne $_ })
    $ids = @($items | Where-Object { $_.matchedBy -eq 'token' } | ForEach-Object { $_.id })
    $skipped = $items.Count - $ids.Count
    if ($skipped -gt 0) { [Console]::Error.WriteLine("docshare: skipped $skipped upload(s) not made with your owner token; delete them by id if they are yours") }
    if ($ids.Count -eq 0) { [Console]::Error.WriteLine('docshare: no uploads to delete'); return }
  } else {
    if (-not $Refs -or $Refs.Count -eq 0) { Die 'usage: upload.ps1 rm <url|id>... | rm -All' $EX_USAGE }
    $ids = @($Refs | ForEach-Object { Get-IdFrom $_ })
  }
  $failed = $false
  foreach ($id in $ids) {
    $r = Invoke-Api 'Post' '/api/delete' @{ id = $id }
    if (Test-Ok $r) { "deleted $id" }
    elseif ($r.Status -eq 404) { [Console]::Error.WriteLine("docshare: ${id}: already gone") }
    else { [Console]::Error.WriteLine("docshare: ${id}: delete failed (HTTP $($r.Status)) $($r.Body.error)"); $failed = $true }
  }
  if ($failed) { exit $EX_SERVER }
}

function Invoke-Usage {
  $r = Invoke-Api 'Get' '/api/usage' $null
  if (-not (Test-Ok $r)) { Fail 'usage' $r }
  if ($Json) { $r.Text; return }
  $b = $r.Body
  "today:   $($b.daily.count)/$($b.daily.countMax) uploads, $(Format-Size $b.daily.bytes)/$(Format-Size $b.daily.bytesMax) (resets 00:00 UTC)"
  "storage: $(Format-Size $b.storage.used)/$(Format-Size $b.storage.cap) service-wide"
  if ($b.docMax) { "max file: $(Format-Size $b.docMax)$(if ($b.admin) { ' (admin)' })" }
}

function Invoke-MakeRoom($Rest) {
  $bytes = 0
  if ($Rest -and $Rest.Count -gt 0) {
    if ($Rest[0] -notmatch '^[0-9]+$') { Die "make-room takes a byte count, got: $($Rest[0])" $EX_USAGE }
    $bytes = [long]$Rest[0]
  }
  $r = Invoke-Api 'Post' '/api/make-room' @{ bytes = $bytes; dryRun = [bool]$DryRun }
  if (-not (Test-Ok $r)) { Show-Names 'deleting all of these would still not be enough' $r.Body.wouldDelete; Fail 'make-room' $r }
  $list = @($(if ($DryRun) { $r.Body.wouldDelete } else { $r.Body.deleted }) | Where-Object { $null -ne $_ })
  if ($list.Count -eq 0) { [Console]::Error.WriteLine('docshare: nothing to delete; the upload already fits') }
  else { Show-Names $(if ($DryRun) { 'would delete' } else { 'deleted' }) $list }
}

# ---------------------------------------------------------------- main

$argv = @($Args_ | Where-Object { $null -ne $_ })
if ($Stdin) { $argv = @('-') + $argv }
if ($argv.Count -eq 0) { Die 'usage: upload.ps1 [-Raw] [-Json] [-MakeRoom] <file|->... | ls | rm | usage | make-room' $EX_USAGE }
$rest = @($argv | Select-Object -Skip 1)
switch ($argv[0]) {
  { $_ -in 'ls', 'list' } { Invoke-Ls; break }
  { $_ -in 'rm', 'delete' } { Invoke-Rm $rest; break }
  { $_ -in 'usage', 'quota' } { Invoke-Usage; break }
  'make-room' { Invoke-MakeRoom $rest; break }
  default { Invoke-Upload $argv }
}
