# One-time Vercel setup for meme-api.
#
# The interactive `vercel login` flow resolves your team but then fails to write
# its token on this machine, which is why `vercel whoami` reports "user not
# found" right after a "successful" login. Using an API token sidesteps it.
#
# Usage:
#   1. Create a token: https://vercel.com/account/tokens
#   2. powershell -ExecutionPolicy Bypass -File .\scripts\setup-vercel.ps1
#
# The token is read as hidden input and only ever lives in this process, so it
# never reaches shell history or the transcript. The OpenRouter key is read from
# .env on disk — you never have to paste that either.
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot

Set-Location $projectRoot

# ─── 1. Token ──────────────────────────────────────────────────────────────────
$secure = Read-Host 'Paste your Vercel token (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:VERCEL_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if (-not $env:VERCEL_TOKEN) { throw 'No token entered.' }

# ─── 2. Verify with the REST API, NOT `vercel whoami` ──────────────────────────
# `vercel whoami` resolves a *user* and prints "User not found" for a perfectly
# valid token that is scoped to a team, or to an account with no user profile.
# Failing on that is wrong — it blocks setup over a cosmetic CLI quirk. So we ask
# the API directly what the token can actually do.
$apiHeaders = @{ Authorization = "Bearer $env:VERCEL_TOKEN" }

Write-Host ''
Write-Host 'Checking token against the Vercel API...' -ForegroundColor Cyan

$tokenScopeNote = $false
try {
  $me = Invoke-RestMethod 'https://api.vercel.com/v2/user' -Headers $apiHeaders -Method Get
  Write-Host "  user: $($me.user.username) (id $($me.user.id))" -ForegroundColor Green
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host "  GET /v2/user -> HTTP $code" -ForegroundColor Yellow
  $tokenScopeNote = $true
}

# Project access is what actually matters for the steps below.
$projectOk = $false
try {
  $p = Invoke-RestMethod 'https://api.vercel.com/v9/projects/meme-api-inky' -Headers $apiHeaders -Method Get
  Write-Host "  project meme-api-inky: found (id $($p.id))" -ForegroundColor Green
  $projectOk = $true
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host "  GET /v9/projects/meme-api-inky -> HTTP $code" -ForegroundColor Yellow
  if ($code -eq 404) {
    Write-Host '  The token cannot see this project. Either it belongs to a different' -ForegroundColor Red
    Write-Host '  account, or the project name is wrong.' -ForegroundColor Red
  }
}

if (-not $projectOk) {
  Write-Host ''
  Write-Host 'Stopping: the token cannot reach meme-api-inky, so env vars cannot be set.' -ForegroundColor Red
  if ($tokenScopeNote) {
    Write-Host 'Both /v2/user and the project returned 404. That means this token' -ForegroundColor Yellow
    Write-Host 'belongs to a different Vercel account (or you pasted the token NAME' -ForegroundColor Yellow
    Write-Host 'instead of its one-time value). It is not simply an expired token.' -ForegroundColor Yellow
  }
  exit 1
}

# ─── 3. Link the project ───────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Linking to meme-api-inky...' -ForegroundColor Cyan
vercel link --yes --project meme-api-inky 2>&1 | Out-Host

# ─── 4. Env vars ───────────────────────────────────────────────────────────────
# Read the rotated key straight off disk; it is never echoed.
$envFile = Join-Path $projectRoot '.env'
if (-not (Test-Path $envFile)) { throw "No .env found at $envFile" }

$apiKey = (Get-Content $envFile | Where-Object { $_ -match '^OPEN_ROUTER_API_KEY=' } | Select-Object -First 1) `
  -replace '^OPEN_ROUTER_API_KEY=', ''
if (-not $apiKey) { throw 'OPEN_ROUTER_API_KEY not found in .env' }

$origins = 'https://pawan53415288-sys.github.io'

foreach ($target in @('production', 'preview')) {
  Write-Host ''
  Write-Host "Setting env vars for $target..." -ForegroundColor Cyan

  # `env add` reads the value from stdin when there is no TTY, and the value must
  # NOT be passed as a flag or it shows up in the process list.
  $apiKey | vercel env add OPEN_ROUTER_API_KEY $target --sensitive --yes 2>&1 | Out-Host
  $origins  | vercel env add ALLOWED_ORIGINS     $target --sensitive --yes 2>&1 | Out-Host
}

Write-Host ''
Write-Host 'Redeploying...' -ForegroundColor Cyan
vercel redeploy --yes 2>&1 | Out-Host

$env:VERCEL_TOKEN = $null
Write-Host ''
Write-Host 'Done. Check:' -ForegroundColor Green
Write-Host '  https://meme-api-inky.vercel.app/api/health'
Write-Host 'Expect keyValid:true. Note that /api/memes may still time out —'
Write-Host 'generation takes 22-49s and Vercel Hobby caps functions near 10s.'