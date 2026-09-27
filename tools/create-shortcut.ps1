<#
create-shortcut - put a "herdr-dash" shortcut next to the console it names, so the
dash is one double-click away without hunting for the folder.

  powershell -NoProfile -File tools\create-shortcut.ps1
      create (or repair) the shortcut on your Desktop.

  powershell -NoProfile -File tools\create-shortcut.ps1 -LnkPath C:\temp\x.lnk
      the same, written somewhere else. Testing uses this: the owner's Desktop is
      only ever touched when -LnkPath is left alone.

The shortcut points at herdr-dash.cmd in the folder ABOVE tools\ and starts in that
folder, with no arguments. Running this twice is harmless: if the shortcut is already
there and already correct it is left exactly as it is; if it points somewhere else
(the folder was moved) it is repaired. Nothing is created outside the path asked for,
no administrator rights are needed, and no dialog is shown either way.

This shortcut does NOT elevate: it is a normal shortcut at your own level. Elevation
is your right-click on herdr-dash.cmd itself, which this file never sets.

Why this is a .ps1 and not inline -Command in the .cmd: the whole body used to be a
single 1093-character line inside create-shortcut.cmd. A .cmd whose gotos have to be
found by cmd's own label scan is fragile enough with long lines, and the fix for the
launcher (herdr-dash.cmd) was to move helpers like this out into tools\ and invoke
them with -File. Same shape here, same reason. No -ExecutionPolicy Bypass anywhere:
that switch only concerns .ps1 FILES, and the default policy already runs the helpers
this project ships.
#>
param(
    # Where to write the shortcut. Empty (the default) means the Desktop.
    [string]$LnkPath = ''
)

# A shortcut that could not be written must never look like one that was. With the
# default preference, WScript.Shell's Save() fails, PowerShell prints the failure, and
# the script carries straight on to print "created the shortcut." and exit 0 - it
# claims a result it never observed, the same defect the launcher had. Stop makes that
# failure end the script, and the read-back after Save() catches a save that returns
# without having written what was asked for.
$ErrorActionPreference = 'Stop'

# The Desktop is asked for, not assumed: on many machines it is redirected into
# OneDrive, and %USERPROFILE%\Desktop would then be the wrong folder (or absent).
if (-not $LnkPath) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) {
        Write-Host '[herdr-dash] could not find your Desktop folder - nothing was created.'
        exit 1
    }
    $LnkPath = Join-Path $desktop 'herdr-dash.lnk'
}

# The target folder is this script's parent, so the shortcut always names the
# herdr-dash.cmd that sits next to the tools\ folder this script was run from. The
# trailing separator is deliberate: it is the same %~dp0 shape the .cmd uses, and it
# keeps the "start in:" line below byte-for-byte what it has always printed.
$dir = (Split-Path -Parent $PSScriptRoot) + '\'
$target = Join-Path $dir 'herdr-dash.cmd'

if (-not (Test-Path -LiteralPath $target)) {
    Write-Host ('[herdr-dash] herdr-dash.cmd is not in ' + $dir + ', so there is nothing to point a shortcut at.')
    Write-Host '[herdr-dash] Run this from the herdr-dash folder.'
    exit 1
}

# The shortcut is read back before it is written, so this can say honestly whether it
# created one, repaired one, or found one already correct.
$shell = New-Object -ComObject WScript.Shell
$had = $false
$old = ''
if (Test-Path -LiteralPath $LnkPath) {
    $had = $true
    $old = $shell.CreateShortcut($LnkPath).TargetPath
}

$s = $shell.CreateShortcut($LnkPath)
$s.TargetPath = $target
$s.WorkingDirectory = $dir
$s.Arguments = ''
$s.Description = 'herdr-dash - control console for the herdr dashboard'
$s.WindowStyle = 1

try {
    $s.Save()
} catch {
    Write-Host ('[herdr-dash] could not write the shortcut to ' + $LnkPath + ' - nothing was created.')
    Write-Host ('[herdr-dash]   Windows said: ' + $_.Exception.Message)
    exit 1
}

# The save returning is still not evidence that a shortcut is there and points where it
# should, so read back what was written before any success line prints. This is the rule
# the launcher follows after its elevation attempt: never report a result you have not
# observed. Both checks below fail loudly and exit nonzero.
if (-not (Test-Path -LiteralPath $LnkPath)) {
    Write-Host ('[herdr-dash] nothing is at ' + $LnkPath + ' after writing it - nothing was created.')
    exit 1
}
$written = $shell.CreateShortcut($LnkPath).TargetPath
if ($written -ne $target) {
    Write-Host ('[herdr-dash] the shortcut at ' + $LnkPath + ' points at ' + $written + ' - nothing was created.')
    exit 1
}

if ($had -and $old -eq $target) {
    Write-Host '[herdr-dash] the shortcut is already there and already correct - left unchanged.'
} elseif ($had) {
    Write-Host ('[herdr-dash] repaired the existing shortcut (it pointed at ' + $old + ').')
} else {
    Write-Host '[herdr-dash] created the shortcut.'
}
Write-Host ('[herdr-dash]   shortcut: ' + $LnkPath)
Write-Host ('[herdr-dash]   target:   ' + $target)
Write-Host ('[herdr-dash]   start in: ' + $dir)
Write-Host '[herdr-dash] double-click it to open the control console.'
exit 0
