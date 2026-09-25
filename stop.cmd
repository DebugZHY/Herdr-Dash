@echo off
rem ---------------------------------------------------------------------------
rem herdr-dash - stop the server that start.cmd started, and prove the port is free.
rem
rem   stop.cmd                   stop whatever is serving 127.0.0.1:7433
rem   stop.cmd --port 8080       another port
rem   stop.cmd --dry-run         print what would be stopped; stop nothing
rem   stop.cmd --no-pause        do not wait for a keypress at the end
rem
rem It stops the listener on the port ONLY when that process is a node.exe whose
rem command line names this server (src\server.js). Anything else listening there
rem is reported and left alone - this tool must not kill an unrelated program.
rem After stopping, it checks the port again and says whether it is really free.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=7433"
set "DRYRUN=0"
set "PAUSE=1"

rem ---------------------------------------------------------------- arguments
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--port" goto arg_port
if /i "%~1"=="--dry-run" goto arg_dryrun
if /i "%~1"=="--no-pause" goto arg_nopause
if /i "%~1"=="--help" goto usage
if /i "%~1"=="-h" goto usage
echo [herdr-dash] unknown option: %~1
goto usage

:arg_port
set "PORT=%~2"
shift
shift
goto parse

:arg_dryrun
set "DRYRUN=1"
shift
goto parse

:arg_nopause
set "PAUSE=0"
shift
goto parse

:usage
echo usage: stop.cmd [--port N] [--dry-run] [--no-pause]
endlocal
exit /b 2

:parsed
echo(%PORT%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 goto bad_port

rem ------------------------------------------------------- who holds the port?
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /i "LISTENING" ^| findstr /r /c:":%PORT% "') do set "PID=%%p"

if "%PID%"=="" goto nothing_running

rem -------------------------------------------------- is it really this server?
rem Two independent questions, both answered inside one PowerShell call:
rem   * is the process node.exe, and does its command line run src\server.js?
rem   * does the port answer /api/health with THIS server's health body?
rem Only if both say yes is it stopped. Anything else is reported and left alone.
rem  exit 0 = this server, answering        -> stop it
rem  exit 1 = a different program          -> leave it alone
rem  exit 2 = looks like this server but does not answer properly -> leave it alone
rem  exit 3 = the process is already gone  -> nothing to stop
set "OWNER=$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%PID%'; if (-not $p) { exit 3 }; $bad = ''; if ($p.Name -notmatch '^node(\.exe)?$') { $bad = 'the process is ' + $p.Name + ', not node.exe' } elseif ($p.CommandLine -notmatch 'src[\\/]server\.js') { $bad = 'its command line does not run src\server.js' }; if ($bad) { Write-Host ('[herdr-dash]   ' + $p.CommandLine); Write-Host ('[herdr-dash]   reason: ' + $bad); exit 1 }; try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:%PORT%/api/health' } catch { Write-Host ('[herdr-dash]   PID %PID% runs src\server.js but /api/health does not answer - not killing it'); exit 2 }; if ($r.Content -notmatch 'uptime_ms') { Write-Host ('[herdr-dash]   /api/health answered, but not with this server health body'); exit 2 }; exit 0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%OWNER%"
if errorlevel 3 goto gone
if errorlevel 2 goto unresponsive
if errorlevel 1 goto not_ours

if "%DRYRUN%"=="1" goto dry_stop

rem ---------------------------------------------------------------- stop it
:do_stop
echo [herdr-dash] stopping PID %PID% on port %PORT% ...
taskkill /PID %PID% /F >nul 2>nul
if errorlevel 1 goto kill_failed

rem ---------------------------------------------- verify, do not assume
set "WAIT=for ($i = 0; $i -lt 20; $i++) { if (@(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue).Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%WAIT%" >nul 2>nul
if errorlevel 1 goto still_listening

echo [herdr-dash] stopped. port %PORT% is free - nothing is listening there now.
if "%PAUSE%"=="1" pause
endlocal
exit /b 0

rem ---------------------------------------------------------------- outcomes
:nothing_running
if "%DRYRUN%"=="1" (
  echo [herdr-dash] dry run: nothing is listening on port %PORT% - nothing to stop.
  endlocal
  exit /b 0
)
echo [herdr-dash] nothing is listening on port %PORT% - nothing to stop.
if "%PAUSE%"=="1" pause
endlocal
exit /b 0

:dry_stop
echo [herdr-dash] dry run - nothing is stopped.
echo [herdr-dash] port %PORT% is held by PID %PID%, which is this herdr-dash server.
echo [herdr-dash] would run: taskkill /PID %PID% /F
echo [herdr-dash] then check the port again and report whether it is free.
endlocal
exit /b 0

:not_ours
echo [herdr-dash] port %PORT% is held by PID %PID%, and that is NOT this server.
echo [herdr-dash] not touching it. If it is yours:  taskkill /PID %PID% /F
if "%PAUSE%"=="1" pause
endlocal
exit /b 1

:unresponsive
echo [herdr-dash] PID %PID% on port %PORT% looks like this server (node + src\server.js)
echo [herdr-dash] but it is not answering /api/health, so it was NOT stopped.
echo [herdr-dash] if you are sure:  taskkill /PID %PID% /F
if "%PAUSE%"=="1" pause
endlocal
exit /b 1

:still_listening
echo [herdr-dash] PID %PID% was killed, but something is STILL listening on port %PORT%.
echo [herdr-dash] check it again:  netstat -ano ^| findstr :%PORT%
if "%PAUSE%"=="1" pause
endlocal
exit /b 1

:kill_failed
echo [herdr-dash] could not stop PID %PID% (taskkill failed - try an elevated window).
if "%PAUSE%"=="1" pause
endlocal
exit /b 1

:gone
echo [herdr-dash] PID %PID% is already gone - nothing to stop. The port is free.
if "%PAUSE%"=="1" pause
endlocal
exit /b 0

:bad_port
echo [herdr-dash] --port needs a number, got "%PORT%"
if "%PAUSE%"=="1" pause
endlocal
exit /b 2
