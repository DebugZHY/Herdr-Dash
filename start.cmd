@echo off
rem ---------------------------------------------------------------------------
rem herdr-dash - start the local web GUI, wait until it answers, open a browser.
rem
rem   start.cmd                  start on 127.0.0.1:7433, then open the browser
rem   start.cmd --port 8080      use another port
rem   start.cmd --no-open        do not open a browser
rem   start.cmd --dry-run        print what would happen; change nothing
rem
rem Double-clicking this file is the normal way to use it, so nothing here needs
rem an argument. If an instance is ALREADY answering /api/health on the port, this
rem does not start a second one (that used to die with "listen EADDRINUSE ... 7433"
rem and leave the error in the window): it says so and just opens the browser.
rem
rem Only cmd's own built-ins and Windows' PowerShell are used - no npm, no Python.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=7433"
set "OPEN=1"
set "DRYRUN=0"

rem ---------------------------------------------------------------- arguments
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--port" goto arg_port
if /i "%~1"=="--no-open" goto arg_noopen
if /i "%~1"=="--dry-run" goto arg_dryrun
if /i "%~1"=="--help" goto usage
if /i "%~1"=="-h" goto usage
echo [herdr-dash] unknown option: %~1
goto usage

:arg_port
set "PORT=%~2"
shift
shift
goto parse

:arg_noopen
set "OPEN=0"
shift
goto parse

:arg_dryrun
set "DRYRUN=1"
shift
goto parse

:usage
echo usage: start.cmd [--port N] [--no-open] [--dry-run]
endlocal
exit /b 2

:parsed
echo(%PORT%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 goto bad_port

rem ------------------------------------------------------------ what is needed
where node >nul 2>nul
if errorlevel 1 goto no_node
if not exist "src\server.js" goto no_server

rem ------------------------------------------------------------ the two scripts
rem PROBE answers the whole "what is on this port?" question with one exit code:
rem   0  something serves /api/health there -> an instance is already running
rem   1  something else listens there       -> starting ours would fail
rem   2  nothing listens there              -> go ahead
set "PROBE=try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/api/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; if (@(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { exit 1 } else { exit 2 }"
rem POLL waits for the server we just started (bounded ~15 s) and opens the URL.
set "POLL=for ($i = 0; $i -lt 60; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/api/health'; if ($r.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:%PORT%/'; exit 0 } } catch { }; Start-Sleep -Milliseconds 250 }; Write-Host '[herdr-dash] no answer after 15 s - open http://127.0.0.1:%PORT%/ yourself'; exit 1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "%PROBE%" >nul 2>nul
if errorlevel 2 goto st_free
if errorlevel 1 goto st_taken
set "STATE=running"
goto state_known

:st_free
set "STATE=free"
goto state_known

:st_taken
set "STATE=taken"

:state_known

if "%DRYRUN%"=="1" goto dryrun

if "%STATE%"=="running" goto already_running
if "%STATE%"=="taken" goto port_taken
goto start_server

rem ---------------------------------------------------------------- dry run
:dryrun
echo [herdr-dash] dry run - nothing is started, stopped or opened.
if "%STATE%"=="running" (
  echo [herdr-dash] port %PORT%: /api/health already answers, so an instance is running.
  echo [herdr-dash] would NOT start a second server. Would open http://127.0.0.1:%PORT%/ and exit 0.
  endlocal
  exit /b 0
)
if "%STATE%"=="taken" (
  echo [herdr-dash] port %PORT%: something is listening that does not answer /api/health.
  echo [herdr-dash] would refuse to start and point at: start.cmd --port 8080
  endlocal
  exit /b 0
)
echo [herdr-dash] port %PORT%: free - nothing is listening there.
echo [herdr-dash] would run: node src/server.js --port %PORT%
echo [herdr-dash] would check the port first: powershell -NoProfile -Command "%PROBE%"
if "%OPEN%"=="1" (
  echo [herdr-dash] would start this in the background while the server runs:
  echo [herdr-dash]   powershell -NoProfile -Command "%POLL%"
) else (
  echo [herdr-dash] --no-open: would NOT open a browser.
)
endlocal
exit /b 0

rem ------------------------------------------------------------ already running
:already_running
echo [herdr-dash] already running on http://127.0.0.1:%PORT%/ - /api/health answers there.
echo [herdr-dash] not starting a second server.
if "%OPEN%"=="1" (
  echo [herdr-dash] opening the browser.
  start "" "http://127.0.0.1:%PORT%/"
)
endlocal
exit /b 0

rem ---------------------------------------------------------------- start it
:start_server
echo [herdr-dash] starting http://127.0.0.1:%PORT%/ - press Ctrl+C or run stop.cmd to stop it.
if "%OPEN%"=="1" (
  echo [herdr-dash] waiting for /api/health, then opening your browser.
  start "herdr-dash browser" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "%POLL%"
)
node src/server.js --port %PORT%
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo [herdr-dash] the server stopped with exit code %RC%.
  pause
)
endlocal
exit /b %RC%

rem ---------------------------------------------------------------- failures
:port_taken
echo [herdr-dash] port %PORT% is busy - something is listening there, and it does not
echo [herdr-dash] answer /api/health, so it is not this herdr-dash server.
echo [herdr-dash] find it with:  netstat -ano ^| findstr :%PORT%
echo [herdr-dash] or start on another port:  start.cmd --port 8080
pause
endlocal
exit /b 1

:bad_port
echo [herdr-dash] --port needs a number, got "%PORT%"
pause
endlocal
exit /b 2

:no_node
echo [herdr-dash] Node.js was not found on PATH - this GUI is a Node program.
echo [herdr-dash] Install Node.js 18 or newer from https://nodejs.org/ , then run this file again.
echo [herdr-dash] Already installed? Add its folder to PATH and reopen this window.
pause
endlocal
exit /b 1

:no_server
echo [herdr-dash] src\server.js is not next to this file - run start.cmd from the herdr-dash folder.
pause
endlocal
exit /b 1
