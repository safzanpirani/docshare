# docshare upload — presign → PUT → finalize.
#
# Usage:   .\upload.ps1 <file>
# Env:     DOCSHARE_ENDPOINT   override default https://docs.safzan.dev
#
# Prints the download URL on stdout on success; an error on stderr with a
# non-zero exit code on failure. Pure PowerShell — no curl, no jq, no python.
# Works on Windows PowerShell 5.1 (preinstalled on every Windows since 2016)
# and on PowerShell Core 7+ (pwsh) on any OS.
#
# If you hit "running scripts is disabled on this system", invoke with:
#   powershell -ExecutionPolicy Bypass -File upload.ps1 <file>

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

function Die($Message, $Code = 1) {
  [Console]::Error.WriteLine($Message)
  exit $Code
}

$endpoint = if ($env:DOCSHARE_ENDPOINT) { $env:DOCSHARE_ENDPOINT.TrimEnd('/') } else { 'https://docs.safzan.dev' }

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Die "no such file: $Path" 66 }
$file = Get-Item -LiteralPath $Path
$size = $file.Length
if ($size -eq 0) { Die "file is empty" 65 }
$name = $file.Name

# Best-effort mime guess from extension. System.Web ships with .NET Framework
# (PS 5.1 on Windows); fall back to octet-stream on PS Core / non-Windows
# where System.Web isn't available.
$mime = 'application/octet-stream'
try {
  Add-Type -AssemblyName System.Web -ErrorAction Stop
  $guessed = [System.Web.MimeMapping]::GetMimeMapping($file.FullName)
  if ($guessed) { $mime = $guessed }
} catch { }

# 1) presign
try {
  $presignBody = @{ filename = $name; size = $size; contentType = $mime } | ConvertTo-Json -Compress
  $presign = Invoke-RestMethod -Method Post -Uri "$endpoint/api/doc/presign" `
    -ContentType 'application/json' -Body $presignBody
} catch {
  Die "presign failed: $($_.Exception.Message)" 2
}
if (-not $presign.putUrl) { Die "presign returned no putUrl: $presign" 2 }

# 2) PUT bytes straight to R2 — -InFile streams the file, no RAM blow-up
try {
  Invoke-WebRequest -Method Put -Uri $presign.putUrl `
    -ContentType $mime -InFile $file.FullName -UseBasicParsing | Out-Null
} catch {
  Die "upload PUT to R2 failed: $($_.Exception.Message)" 2
}

# 3) finalize
try {
  $finalBody = @{ id = $presign.id } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$endpoint/api/doc/finalize" `
    -ContentType 'application/json' -Body $finalBody | Out-Null
} catch {
  Die "finalize failed: $($_.Exception.Message)" 2
}

Write-Output $presign.downloadUrl
