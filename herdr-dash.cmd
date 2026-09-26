@echo off
rem ---------------------------------------------------------------------------
rem herdr-dash - the one thing to click. It makes sure the control console is
rem running, then opens it. The console (http://127.0.0.1:7432/) is a small local
rem page that shows the app's status - running / stopped / started outside, with
rem port, PID, uptime, herdr's version and protocol, and the tail of the server
rem log - and starts, stops and restarts the app.
rem
rem   herdr-dash.cmd                            start the console if needed, open it
rem   herdr-dash.cmd status                     ... with arguments: the console's CLI
rem   herdr-dash.cmd start|stop|restart [--app-port M]
rem
rem With an argument nothing is decided here: the words go to `node tools/hdctl.js`
rem unchanged and its exit code and its output come straight back out, so a refusal
rem stays a refusal and a success is never invented.
rem
rem Without one, the console is started HIDDEN and the page is opened only once it
rem really answers. The console keeps running after its window is gone, which is why
rem the app survives closing the page. A second console is never started: if the
rem console already answers, the page is just opened; if something that is NOT the
rem console answers on the port, this says so and starts nothing.
rem
rem Double-clicking this file is the normal way to use it. It needs no administrator
rem rights and uses nothing but cmd and Windows' own PowerShell.
rem
rem   HD_CTL_PORT=7500   use another console port (7432 by default)
rem   HD_NO_PAUSE=1      never wait for a keypress - for scripts, not for people
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
cd /d "%~dp0"
set "HD_DIR=%~dp0"
set "CTL_PORT=7432"
if not "%HD_CTL_PORT%"=="" set "CTL_PORT=%HD_CTL_PORT%"

if not "%~1"=="" goto cli

rem ---------------------------------------------------------------- no arguments
where node >nul 2>nul
if errorlevel 1 goto no_node
if not exist "tools\hdctl.js" goto no_console

echo(%CTL_PORT%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 goto bad_port

rem ONE probe answers the whole "who is on this port?" question with one exit code:
rem   0  the console answers /api/status   -> just open the page
rem   2  something answers, but not the console -> start nothing, say so
rem   1  nothing answers there             -> start the console hidden, then wait
rem It talks HTTP itself through node (already required by this project) so the
rem launcher needs no curl, no port sniffing and no administrator rights.
set "PROBE=const h=require('http'),port=Number(process.argv[1]);const get=(p,t)=>new Promise(r=>{const q=h.get({host:'127.0.0.1',port:port,path:p,timeout:t},s=>{let b='';s.on('data',d=>b+=d);s.on('end',()=>r({code:s.statusCode,body:b}))});q.on('error',()=>r(null));q.on('timeout',()=>{q.destroy();r(null)})});(async()=>{const s=await get('/api/status',2500);if(s&&s.code===200&&s.body.indexOf('ctl')>=0)process.exit(0);const w=await get('/',1500);if(w)process.exit(2);process.exit(1)})();"

node -e "%PROBE%" %CTL_PORT%
set "RC=%errorlevel%"
if "%RC%"=="0" goto open
if "%RC%"=="2" goto foreign

echo [herdr-dash] the console is not up on http://127.0.0.1:%CTL_PORT%/ - starting it hidden.
set "CTL_ARGS=tools\hdctl.js"
if not "%HD_CTL_PORT%"=="" set "CTL_ARGS=tools\hdctl.js --port %CTL_PORT%"
rem -WindowStyle Hidden is the point: the console is a page, not a window to keep.
rem -WorkingDirectory is passed explicitly (as an environment variable, so a path
rem with spaces or quotes cannot break the command line) because the console finds
rem src\server.js and _cache\logs\ relative to the folder it runs in.
rem (No -ExecutionPolicy Bypass: that switch only concerns .ps1 FILES, and nothing
rem here runs a file - inline -Command is not subject to the execution policy, so
rem this launcher does not ask anyone to weaken a security default.)
powershell -NoProfile -Command "Start-Process -FilePath node -ArgumentList ($env:CTL_ARGS -split ' ') -WindowStyle Hidden -WorkingDirectory $env:HD_DIR"
if errorlevel 1 goto start_failed

set /a TRY=0
:wait
set /a TRY+=1
node -e "%PROBE%" %CTL_PORT%
set "RC=%errorlevel%"
if "%RC%"=="0" goto open
if "%RC%"=="2" goto foreign
if %TRY% GEQ 20 goto no_answer
ping -n 2 127.0.0.1 >nul
goto wait

rem ---------------------------------------------------------------- the console
:open
echo [herdr-dash] console: http://127.0.0.1:%CTL_PORT%/ (up).
echo [herdr-dash] opening it in your browser - the app is started and stopped from there.
start "" "http://127.0.0.1:%CTL_PORT%/"
endlocal & exit /b 0

rem ------------------------------------------------ arguments: the console's CLI
:cli
where node >nul 2>nul
if errorlevel 1 goto no_node
node "tools\hdctl.js" %*
set "RC=%errorlevel%"
rem one line on purpose: %RC% has to be read BEFORE endlocal throws away this scope.
endlocal & exit /b %RC%

rem ------------------------------------------------------------------ refusals
:foreign
echo [herdr-dash] something is already listening on http://127.0.0.1:%CTL_PORT%/ and it is not
echo [herdr-dash] the herdr-dash console: its /api/status does not answer the way hdctl does.
echo [herdr-dash] nothing was started - the console could not have that port anyway.
echo [herdr-dash] stop whatever holds the port, or use another one:  set HD_CTL_PORT=7500
set "RC=1"
goto fail

:no_answer
echo [herdr-dash] the console was started but did not answer http://127.0.0.1:%CTL_PORT%/ within 20 s.
echo [herdr-dash] run it in the open to see what it says:  node tools\hdctl.js
set "RC=1"
goto fail

:start_failed
echo [herdr-dash] could not start the console (PowerShell refused to launch it).
echo [herdr-dash] run it in the open to see what it says:  node tools\hdctl.js
set "RC=1"
goto fail

:no_console
echo [herdr-dash] tools\hdctl.js is not next to this file, so there is no console to start.
echo [herdr-dash] the app itself can still be run directly:  node src\server.js
set "RC=1"
goto fail

:bad_port
echo [herdr-dash] the console port has to be a number, got "%CTL_PORT%" (from HD_CTL_PORT).
set "RC=2"
goto fail

:no_node
echo [herdr-dash] Node.js was not found on PATH - this console is a Node program.
echo [herdr-dash] Install Node.js 18 or newer from https://nodejs.org/ , then run this file again.
echo [herdr-dash] Already installed? Add its folder to PATH and reopen this window.
set "RC=1"
goto fail

:fail
rem A failure is worth reading, so this window waits - unless automation said not to.
if not "%HD_NO_PAUSE%"=="1" pause
endlocal & exit /b %RC%
