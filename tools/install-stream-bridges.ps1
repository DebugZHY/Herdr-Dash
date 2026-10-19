# Install / remove the Herdr-Dash token-stream bridges.
#
#   powershell -ExecutionPolicy Bypass -File tools/install-stream-bridges.ps1
#   powershell -ExecutionPolicy Bypass -File tools/install-stream-bridges.ps1 -Uninstall
#
# The repo is the source of truth; this only copies the two add-ons into the user's agent
# directories and enables the Hermes plugin. It is idempotent: a target whose files already
# match the source is left alone (no new backup, no copy). A target that differs is moved
# aside with a timestamp — never deleted — before the new copy lands.
#
# Nothing here touches a running agent: panes pick the bridge up on their next reload/restart.
# Nothing here kills a process, edits a session, or writes outside the two target directories
# and the plugin's own enable switch.

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$NoReasoning
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$piSrc = Join-Path $repo 'bridges\pi\herdr-stream'
$piDst = Join-Path $env:USERPROFILE '.pi\agent\extensions\herdr-stream'
$hermesSrc = Join-Path $repo 'bridges\hermes\herdr-stream'
$hermesDst = Join-Path $env:LOCALAPPDATA 'hermes\plugins\herdr-stream'
$hermesExe = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
$piReloadHint = 'run /reload in each pi pane (or open a new pane)'

function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" }

function Move-Aside([string]$path, [string]$label) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $backup = "$path.bak-$stamp"
  Move-Item -LiteralPath $path -Destination $backup
  Write-Host "backup $label -> $backup"
}

# A stable fingerprint of a directory tree: relative path + SHA-256 per file, in path order.
function Get-TreeHash([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $sb = New-Object System.Text.StringBuilder
  $files = Get-ChildItem -LiteralPath $path -Recurse -File | Sort-Object FullName
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($path.Length).TrimStart('\', '/')
    [void]$sb.Append($rel).Append(':')
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    [void]$sb.Append([Convert]::ToBase64String($sha.ComputeHash($bytes))).Append("`n")
  }
  if ($files.Count -eq 0) { return 'empty' }
  $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
  return ($digest | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Sync-Tree([string]$src, [string]$dst, [string]$label) {
  if (-not (Test-Path -LiteralPath $src)) { throw "missing source: $src" }
  $want = Get-TreeHash $src
  $have = Get-TreeHash $dst
  if ($have -and $have -eq $want) {
    Write-Host "$label already up to date -> $dst"
    return $false
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Move-Aside $dst $label
  Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  if ($have) { Write-Host "updated $label -> $dst" } else { Write-Host "installed $label -> $dst" }
  return $true
}

Write-Host "Herdr-Dash stream bridges ($(if ($Uninstall) { 'uninstall' } else { 'install' }))"
Write-Host "  repo:   $repo"
Write-Host "  pi:     $piDst"
Write-Host "  hermes: $hermesDst"

if ($Uninstall) {
  Write-Step 'disable the Hermes plugin (no files are deleted)'
  if (Test-Path -LiteralPath $hermesExe) {
    try { & $hermesExe plugins disable herdr-stream 2>&1 | Out-Host } catch { Write-Warning $_ }
    if ($LASTEXITCODE -ne 0) { Write-Warning "hermes plugins disable exited $LASTEXITCODE; the plugin directory is moved aside anyway." }
  } else {
    Write-Warning "hermes.exe not found at $hermesExe; disable the plugin in its own config if it is enabled."
  }
  Move-Aside $piDst 'pi extension'
  Move-Aside $hermesDst 'hermes plugin'
  Write-Step 'done'
  Write-Host "Removed. $piReloadHint and restart hermes panes to drop the bridge."
  exit 0
}

Write-Step 'install the pi extension'
$piChanged = Sync-Tree $piSrc $piDst 'pi extension'

Write-Step 'install the Hermes plugin'
$hermesChanged = Sync-Tree $hermesSrc $hermesDst 'hermes plugin'

Write-Step 'enable the Hermes plugin (idempotent: already-enabled is not an error)'
if (Test-Path -LiteralPath $hermesExe) {
  & $hermesExe plugins enable herdr-stream 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "hermes plugins enable failed (exit $LASTEXITCODE)" }
  if (-not $NoReasoning) {
    # reasoning deltas are opt-in; text deltas do not need this
    & $hermesExe config set plugins.stream_reasoning_deltas true 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "hermes config set stream_reasoning_deltas failed (exit $LASTEXITCODE)" }
  } else {
    Write-Host '  reasoning deltas left off (-NoReasoning); text deltas still stream.'
  }
  & $hermesExe plugins list 2>&1 | Select-String -Pattern 'herdr-stream' | Out-Host
} else {
  Write-Warning "hermes.exe not found at $hermesExe."
  Write-Host '  Enable the plugin once hermes is installed:  hermes plugins enable herdr-stream'
  if (-not $NoReasoning) {
    Write-Host '  For reasoning deltas:                        hermes config set plugins.stream_reasoning_deltas true'
  }
}

Write-Step 'next steps (a running agent keeps its current add-ons)'
Write-Host "  1. pi:     $piReloadHint. New pi panes load the extension automatically."
Write-Host '  2. hermes: restart each hermes pane; plugins load at agent start.'
Write-Host '  3. dashboard: reload the page. The chat chip says "live" only after a bridge event;'
Write-Host '     "records" means the record poll still owns the view (the bridge is absent or idle).'
if ($piChanged -or $hermesChanged) {
  Write-Host ''
  Write-Host "Panes started before this install keep their old add-ons until they are reloaded/restarted."
}
Write-Host ''
Write-Host 'Uninstall with -Uninstall (moves the copies aside; disables the plugin).'
