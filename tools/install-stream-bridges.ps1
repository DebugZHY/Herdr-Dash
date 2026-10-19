# Install / remove the Herdr-Dash token-stream bridges.
#
#   powershell -ExecutionPolicy Bypass -File tools/install-stream-bridges.ps1
#   powershell -ExecutionPolicy Bypass -File tools/install-stream-bridges.ps1 -Uninstall
#
# The repo is the source of truth; this only copies the two add-ons into the user's
# agent directories and enables the Hermes plugin. Existing targets are moved aside
# with a timestamp, never deleted. A new agent process is required: pi/hermes panes
# that are already running keep their current extension/plugin set.

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

function Move-Aside([string]$path, [string]$label) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $backup = "$path.bak-$stamp"
  Move-Item -LiteralPath $path -Destination $backup
  Write-Host "backup $label -> $backup"
}

function Copy-Tree([string]$src, [string]$dst, [string]$label) {
  if (-not (Test-Path -LiteralPath $src)) { throw "missing source: $src" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Move-Aside $dst $label
  Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  Write-Host "installed $label -> $dst"
}

if ($Uninstall) {
  if (Test-Path -LiteralPath $hermesExe) {
    try { & $hermesExe plugins disable herdr-stream 2>&1 | Out-Host } catch { Write-Warning $_ }
  }
  Move-Aside $piDst 'pi extension'
  Move-Aside $hermesDst 'hermes plugin'
  Write-Host 'uninstalled; restart pi/hermes panes to drop the bridge.'
  exit 0
}

Copy-Tree $piSrc $piDst 'pi extension'
Copy-Tree $hermesSrc $hermesDst 'hermes plugin'

if (Test-Path -LiteralPath $hermesExe) {
  & $hermesExe plugins enable herdr-stream 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "hermes plugins enable failed (exit $LASTEXITCODE)" }
  if (-not $NoReasoning) {
    & $hermesExe config set plugins.stream_reasoning_deltas true 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "hermes config set stream_reasoning_deltas failed (exit $LASTEXITCODE)" }
  }
  & $hermesExe plugins list 2>&1 | Select-String -Pattern 'herdr-stream' | Out-Host
} else {
  Write-Warning "hermes.exe not found at $hermesExe; copy the plugin and enable it manually."
}

Write-Host ''
Write-Host 'Bridges installed. Existing pi/hermes panes keep their old add-ons.'
Write-Host 'Open a NEW pi/hermes pane (or restart one) to load the bridge, then restart Herdr-Dash.'
