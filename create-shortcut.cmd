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
rem
rem This shortcut does NOT elevate: it is a normal shortcut at your own level, and
rem elevation is your right-click on herdr-dash.cmd itself.
rem
rem The work itself is in tools\create-shortcut.ps1, which is where the Desktop
rem path and the created / repaired / already-correct wording live. That helper
rem takes -LnkPath, so it can be run against a temp path without touching a real
rem Desktop; this launcher never passes it, so a plain double-click only ever
rem writes to the Desktop it asks Windows for.
rem
rem THIS FILE IS CRLF ON PURPOSE. cmd finds a goto's label by scanning the file, and
rem a .cmd whose lines end in a bare LF loses its place once the file grows - measured
rem on herdr-dash.cmd, whose label lookup then failed with "cannot find the batch".
rem Keep every line under 200 characters for the same reason. Both are enforced here
rem deliberately; see the note in tools\create-shortcut.ps1 for the inline PowerShell
rem this file used to carry as one 1093-character line.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
set "PAUSE=1"
if /i "%~1"=="--no-pause" set "PAUSE=0"

if not exist "herdr-dash.cmd" goto no_launcher

rem No -ExecutionPolicy Bypass: it only concerns .ps1 FILES, and the default policy
rem already runs the helpers this project ships (tools\elevate-self.ps1 is invoked
rem the same way), so nothing here needs it.
powershell -NoProfile -File "tools\create-shortcut.ps1"
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
