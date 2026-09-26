@echo off
rem ---------------------------------------------------------------------------
rem create-shortcut - put a "herdr-dash" shortcut on your Desktop, so the console
rem is one double-click away without hunting for the folder.
rem
rem   create-shortcut.cmd              create (or repair) the shortcut
rem   create-shortcut.cmd --no-pause   the same, without the keypress at the end
rem
rem The shortcut points at herdr-dash.cmd in this folder and starts in this folder.
rem Running this twice is harmless: if the shortcut is already there and already
rem correct it is left exactly as it is; if it points somewhere else (the folder was
rem moved) it is repaired. Nothing is created outside your own Desktop, no
rem administrator rights are needed, and no dialog is shown either way.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
set "PAUSE=1"
if /i "%~1"=="--no-pause" set "PAUSE=0"
set "HD_DIR=%~dp0"

if not exist "herdr-dash.cmd" goto no_launcher

rem The Desktop is asked for, not assumed: on many machines it is redirected into
rem OneDrive, and %USERPROFILE%\Desktop would then be the wrong folder (or absent).
rem The shortcut is read back before it is written, so this can say honestly whether
rem it created one, repaired one, or found one already correct.
set "PS=$d=[Environment]::GetFolderPath('Desktop'); if (-not $d) { Write-Host '[herdr-dash] could not find your Desktop folder - nothing was created.'; exit 1 }; $lnk=Join-Path $d 'herdr-dash.lnk'; $t=Join-Path $env:HD_DIR 'herdr-dash.cmd'; $w=New-Object -ComObject WScript.Shell; $had=$false; $old=''; if (Test-Path -LiteralPath $lnk) { $had=$true; $old=$w.CreateShortcut($lnk).TargetPath }; $s=$w.CreateShortcut($lnk); $s.TargetPath=$t; $s.WorkingDirectory=$env:HD_DIR; $s.Description='herdr-dash - control console for the herdr dashboard'; $s.WindowStyle=1; $s.Save(); if ($had -and $old -eq $t) { Write-Host '[herdr-dash] the shortcut is already there and already correct - left unchanged.' } elseif ($had) { Write-Host ('[herdr-dash] repaired the existing shortcut (it pointed at ' + $old + ').') } else { Write-Host '[herdr-dash] created the shortcut.' }; Write-Host ('[herdr-dash]   shortcut: ' + $lnk); Write-Host ('[herdr-dash]   target:   ' + $t); Write-Host ('[herdr-dash]   start in: ' + $env:HD_DIR); Write-Host '[herdr-dash] double-click it to open the control console.'; exit 0"
rem No -ExecutionPolicy Bypass: it only governs .ps1 FILES, and this runs inline code.
powershell -NoProfile -Command "%PS%"
set "RC=%errorlevel%"
if not "%RC%"=="0" goto failed

if "%PAUSE%"=="1" pause
endlocal & exit /b 0

:no_launcher
echo [herdr-dash] herdr-dash.cmd is not next to this file, so there is nothing to point a
echo [herdr-dash] shortcut at. Run this from the herdr-dash folder.
set "RC=1"
goto failed

:failed
echo [herdr-dash] no shortcut was created - the reason is above.
if not "%HD_NO_PAUSE%"=="1" if "%PAUSE%"=="1" pause
endlocal & exit /b %RC%
