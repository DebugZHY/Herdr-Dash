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
rem A console already on the port is only worth reopening if it can reach herdr. One
rem that was started from an ordinary window cannot, and would keep showing the pipe
rem failure however often the page is reloaded. So when THIS window is the elevated
rem copy and finds such a console holding the port, it names the pid that holds it
rem and how to replace it - and replaces it only when told to
rem (HD_RESTART_LOW_CONSOLE=1 below). It never kills anything on its own.
rem
rem Double-clicking this file is the normal way to use it. It uses nothing but cmd,
rem node and Windows' own PowerShell.
rem
rem Before any of that, one thing is checked because it cannot be fixed later:
rem can THIS window reach herdr at all? herdr's API is a Windows named pipe, and a
rem pipe belongs to the process that created it. If the user started herdr from an
rem elevated window ("Administrator: ..." in its title), the pipe only accepts
rem elevated clients; a window opened the ordinary way is not elevated, so Windows
rem refuses the connection before herdr sees anything, and the console then reports
rem "herdr pipe error on ping: connect EPERM". tools\pipe-probe.js answers that
rem question with one exit code and this file explains it in plain words.
rem
rem   HD_CTL_PORT=7500   use another console port (7432 by default)
rem   HD_NO_PAUSE=1      never wait for a keypress - for scripts, not for people
rem   HD_NO_OPEN=1       never open a browser. The console is started and kept
rem                      running exactly as usual; the last step - showing the
rem                      page - is skipped, and the URL is printed instead so
rem                      the run still records where it would have gone. Every
rem                      path that could show a page goes through :open, and
rem                      :open holds the only browser launch in this file, so
rem                      this one variable is the whole switch. Set it in every
rem                      automated run: an unattended launcher must not be able
rem                      to put windows on the owner's desktop.
rem   HD_ON_EPERM=elevate | inform   what to do when herdr runs elevated and this
rem                      window does not. INFORMING IS THE DEFAULT: unset, empty,
rem                      "inform", or anything else that is not exactly "elevate"
rem                      explains the situation and carries on to start the console
rem                      here. `HD_ON_EPERM=elevate` is the opt-IN and the only value
rem                      that asks Windows for an elevated copy of this file. It is
rem                      not the default because on this machine that request has
rem                      been measured to be silently dropped - see the long note at
rem                      :pipe_denied - so the honest default is to say so and let
rem                      the console run, not to try something that cannot work here.
rem                      Where the request IS honoured, `elevate` still works and now
rem                      waits to see the console it promised before claiming it.
rem   HD_RESTART_LOW_CONSOLE=1   when this window IS the elevated copy and the
rem                      console already on the port was started un-elevated, that
rem                      console can never reach herdr and would keep showing the
rem                      failure. This stops exactly that process and starts a fresh
rem                      one. Only ever set for a port this file may own: the pid is
rem                      confirmed to be this console, and to be lower than this
rem                      window, before anything is stopped. Unset, nothing is
rem                      stopped - the file only says who holds the port.
rem   HD_PROBE=...       test hook: run THIS command instead of tools\pipe-probe.js
rem                      as the herdr pre-flight. A stub that exits with a chosen
rem                      code (a one-line file holding `@exit /b 3`) walks every
rem                      branch below without touching a real herdr. The exit code
rem                      is the whole interface - stdout is never read. A .js probe
rem                      is run by node, anything else (.cmd, .exe) is run as-is.
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

rem The port probe is the other file this launcher cannot run without (see the
rem note above :after_preflight). Checked instead of assumed: `node` on a file
rem that is not there fails with a code this script would read as "nothing
rem answers", and the launcher would then wait out its full timeout before
rem saying something less true than this line does.
if not exist "tools\port-probe.js" goto no_port_probe

echo(%CTL_PORT%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 goto bad_port

rem ------------------------------------------------- herdr pre-flight (the pipe)
rem Runs BEFORE the console probe, and only on the no-argument path: a command line
rem like `herdr-dash.cmd status` is the console CLI and must stay exactly as it was.
rem
rem tools\pipe-probe.js opens one fresh connection to herdr's named pipe, sends one
rem ping and exits with the verdict. That exit code is the ONLY thing used here -
rem the probe's stdout is thrown away, so the probe stays free to print whatever a
rem human would want to read. An absent probe is not an error: skip and carry on.
rem   0  reachable              -> say nothing, carry on (the normal case)
rem   3  denied (EPERM)        -> herdr is elevated and this window is not; explain
rem   4  missing (no pipe)     -> herdr is not running; say so in one line
rem   others                   -> unexpected; say so in one line, carry on
rem The `>nul 2>&1` is deliberate: this asks the probe for its exit code, not for
rem its text, and the text would otherwise land on a path meant to be quiet.
if not exist "tools\pipe-probe.js" goto after_preflight
set "PROBE_CLI=tools\pipe-probe.js"
set "PROBE_RUN=node"
if not "%HD_PROBE%"=="" set "PROBE_CLI=%HD_PROBE%"
rem The probe is JavaScript, so node runs it. A test stub is usually a .cmd, and
rem node cannot run one of those - it would read `@exit /b 3` as JavaScript and
rem fail with its own exit code, testing nothing. So anything that is not a .js
rem file is run as a command in its own right - and `call` is not optional there:
rem running a second .cmd without it hands over control for good and this file
rem would never see an exit code, or its own next line, again.
if /i not "%PROBE_CLI:~-3%"==".js" set "PROBE_RUN=call"
%PROBE_RUN% "%PROBE_CLI%" >nul 2>&1
set "PRC=%errorlevel%"
if "%PRC%"=="0" goto after_preflight
if "%PRC%"=="3" goto pipe_denied
if "%PRC%"=="4" goto pipe_missing
echo [herdr-dash] herdr's pipe answered with an unexpected failure (code %PRC%); continuing.
goto after_preflight

:after_preflight
rem ONE probe answers the whole "who is on this port?" question with one exit code:
rem   0  the console answers /api/status   -> just open the page
rem   2  something answers, but not the console -> start nothing, say so
rem   1  nothing answers there             -> start the console hidden, then wait
rem It talks HTTP itself through node (already required by this project) so the
rem launcher needs no curl, no port sniffing and no administrator rights.
rem
rem It lives in tools\port-probe.js rather than in a `node -e` line here, for
rem the reason spelled out at :pipe_denied: that line was 489 characters, and a
rem line longer than cmd's scan buffer makes cmd lose its place when it looks up
rem a label. The exit code is the whole interface; the probe's one line of text
rem is not read, exactly as with tools\pipe-probe.js above.
node "tools\port-probe.js" %CTL_PORT% >nul 2>&1
set "RC=%errorlevel%"
if "%RC%"=="0" goto console_up
if "%RC%"=="2" goto foreign

echo [herdr-dash] the console is not up on http://127.0.0.1:%CTL_PORT%/ - starting it hidden.

rem ------------------------------------------------------------- starting one
rem One place starts a console, so the ordinary fresh-start path and the
rem replace-a-stale-console one (:stale_console) cannot drift apart. Whoever
rem arrives here has already said WHY it is being started.
:start_console
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
node "tools\port-probe.js" %CTL_PORT% >nul 2>&1
set "RC=%errorlevel%"
if "%RC%"=="0" goto open
if "%RC%"=="2" goto foreign
if %TRY% GEQ 20 goto no_answer
ping -n 2 127.0.0.1 >nul
goto wait

rem ---------------------------------------------------------------- the console
:open
echo [herdr-dash] console: http://127.0.0.1:%CTL_PORT%/ (up).

rem HD_NO_OPEN=1 stops at the line above. Every path in this file that would
rem ever show a page comes through here, and `start ""` below is the only thing
rem in the whole file that launches a browser - so one test on one variable
rem covers all of them. Nothing else changes: the console is already up and
rem keeps running, it is only the page that is not opened. A test run sets this
rem so that running the launcher cannot spawn windows on the owner's desktop.
if "%HD_NO_OPEN%"=="1" goto open_withheld

echo [herdr-dash] opening it in your browser - the app is started and stopped from there.
start "" "http://127.0.0.1:%CTL_PORT%/"
endlocal & exit /b 0

:open_withheld
rem Says what was skipped and where to go instead, so a test log still carries
rem the URL it was meant to open - the point is to withhold the browser, not
rem the information.
echo [herdr-dash] HD_NO_OPEN=1 - no browser opened. Open that URL yourself to use it.
endlocal & exit /b 0

rem ----------------------------------------- a console is already on that port
rem Arriving here means something answered on the port exactly the way herdr-dash's
rem console does, so nothing is started and the page is simply opened. That is the
rem right thing only if that console can reach herdr. One started from an ordinary
rem (Medium) window cannot - the pipe refuses it - and its page shows the failure
rem for ever after. So when THIS window is the elevated copy, the one that CAN
rem reach herdr, it is worth asking who really holds the port.
rem
rem Cost: this is the only place a token-il.ps1 spawn (~1 s) happens, and it is
rem reached only when the console already answers AND this window carries the
rem elevated marker. The ordinary fresh-start path - the common one - never pays
rem for it, and neither does the EPERM path when it is the Medium window (no
rem marker, so this is skipped at the first check).
:console_up
if not "%HD_ELEVATED%"=="1" goto open
if not exist "tools\token-il.ps1" goto open

rem Who listens on the console port? The same answer this file gives everywhere
rem else - netstat, LISTENING rows only. The trailing space in ":PORT " is what
rem stops :7432 from matching :17432.
set "UP_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":%CTL_PORT% "') do set "UP_PID=%%p"
if "%UP_PID%"=="" goto open

rem token-il.ps1 prints one line, `pid=<n> integrity=<LEVEL> source=<...>`. Take
rem the middle token and drop the key, which leaves "=MEDIUM": the leading "=" is
rem nothing but what is left of the separator. Comparing that - rather than the
rem bare word - keeps the other two fields free to change shape. Do NOT be tempted
rem to tidy it away with `%UP_IL:=%`: that is not the strip-an-equals-sign idiom it
rem looks like, cmd mis-parses it, and the entire file then fails to load with
rem a "was unexpected at this time" syntax error. No output at all leaves UP_IL
rem empty, which is treated exactly like an unreadable one: no kill.
set "UP_IL="
for /f "tokens=2" %%i in ('powershell -NoProfile -File "tools\token-il.ps1" -ProcessId %UP_PID% 2^>nul') do set "UP_IL=%%i"
set "UP_IL=%UP_IL:integrity=%"
if /i "%UP_IL%"=="=MEDIUM" goto stale_console
if /i "%UP_IL%"=="=LOW" goto stale_console
rem Anything else - HIGH, SYSTEM, unknown, empty - is left strictly alone. A HIGH
rem console is already good, and an unreadable token is not evidence of anything.
goto open

:stale_console
rem The "=" was only ever the separator; drop it before this is ever printed.
set "UP_IL=%UP_IL:~1%"
rem The port is held by a console lower than this window: it can never reach herdr.
rem Stopping it is the destructive choice, so it is opt-in. Every guard above had
rem to pass first - the port still answering as this console, a pid that resolved,
rem and a level that read MEDIUM or LOW - and HD_RESTART_LOW_CONSOLE has to name
rem this port's owner. An unset variable only ever reaches the warning below.
if /i not "%HD_RESTART_LOW_CONSOLE%"=="1" goto stale_console_warn
taskkill /F /PID %UP_PID% >nul 2>&1
echo [herdr-dash] replaced the un-elevated console on port %CTL_PORT%: pid %UP_PID% (%UP_IL%) could not reach herdr

rem The port is not free the instant the process dies, so wait for it - but for a
rem bounded number of tries and never an unbounded wait. The probe is this file's
rem own, so "free" means exactly "nothing answers as the console here any more".
set /a UP_TRY=0
:stale_wait
set /a UP_TRY+=1
node "tools\port-probe.js" %CTL_PORT% >nul 2>&1
set "RC=%errorlevel%"
if "%RC%"=="1" goto start_console
if %UP_TRY% GEQ 10 goto stale_busy
ping -n 2 127.0.0.1 >nul
goto stale_wait

:stale_busy
echo [herdr-dash] port %CTL_PORT% is still answering after %UP_TRY% checks - that console did not
echo [herdr-dash] let go of it. A second console cannot bind it anyway, so the page is opened as
echo [herdr-dash] it is; nothing more is done here.
goto open

:stale_console_warn
echo [herdr-dash] the console on port %CTL_PORT% was started without elevation (pid %UP_PID%,
echo [herdr-dash] %UP_IL%) - it cannot reach herdr, so its page will keep showing the
echo [herdr-dash] pipe failure however often it is reloaded. To replace it, either:
echo [herdr-dash]   re-run this file with HD_RESTART_LOW_CONSOLE=1
echo [herdr-dash]   ...or stop it yourself and run this file again:  taskkill /F /PID %UP_PID%
echo [herdr-dash] nothing was stopped here - this file does not kill anything on its own.
goto open

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

:no_port_probe
echo [herdr-dash] tools\port-probe.js is not next to this file, so there is no way to tell
echo [herdr-dash] whether a console is already on port %CTL_PORT% - and this file will not guess
echo [herdr-dash] by starting a second one. It ships beside hdctl.js; if it is missing, this
echo [herdr-dash] copy of herdr-dash is incomplete.
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

rem ---------------------------------------- herdr's pipe: unreachable, and why
rem These two are NOT failures of this launcher: the console still opens, and it is
rem usually still worth opening - it can show the log and the port, and it says
rem plainly that herdr itself is out of reach. So both carry on to the console.

rem ------------------------------------- the label bug this file was fixed for
rem `goto pipe_denied` used to fail here with "The system cannot find the batch
rem label specified - pipe_denied", exit 1 - which made the whole elevated-
rem relaunch path unreachable, however correct the code on it was. The label was
rem there. cmd just could not find it, and whether it found a given label
rem changed after edits that were nowhere near it: inserting filler lines fixed
rem it, deleting an unrelated chunk fixed it, shortening a long line fixed it.
rem THAT LAST ONE WAS A RED HERRING. The real cause was measured by running
rem copies of this file that differed in exactly one respect:
rem   same content, endings LF only, 22135 bytes  -> label NOT found
rem   same content, endings CRLF,    22539 bytes  -> label found
rem   same content, LF, 40 lines deleted, 20731   -> label found
rem The CRLF copy is LARGER than the failing one and still works, so this was
rem never about size, and after the long lines were removed the longest line
rem here is 152 characters and it still failed. It is about BARE LF LINE
rem ENDINGS: cmd's batch reader and its label scan want a line terminator they
rem can see, and once the file is big enough to be read in more than one block,
rem a bare-LF file desyncs the scan and the label lookups start depending on
rem byte offsets. Every "fix" above was really just moving bytes until the
rem offsets happened to land right again - which is why it passed one day and
rem failed the next, and why the bisect looked arbitrary.
rem So the fix is that this file ends its lines with CRLF. Two consequences:
rem   1. do not convert it back to LF, and do not let an editor rewrite the
rem      endings; that is the whole fix, and it is invisible; and
rem   2. keeping lines short is still worth doing (a 489-character
rem      `set PROBE=...` is now tools\port-probe.js and a 249-character
rem      `powershell -Command "..."` is now tools\elevate-self.ps1), but as
rem      hardening, not as the cure.
rem The verification that matters is not reading the file but running it: the
rem acceptance runs for this change drive the EPERM path, because that is the
rem path the unfound label sat on.

:pipe_missing
echo [herdr-dash] herdr is not running (no herdr server on this pipe) - the console will still open; start herdr first.
goto after_preflight

:pipe_denied
rem The block is four lines on purpose: what is true and what it costs. It must
rem NOT promise a console, because on this path there may never be one - the
rem elevation below can be accepted by Windows and still start nothing, and this
rem file now says so and exits nonzero instead of claiming otherwise. Wrapped by
rem hand to about 79 columns.
echo [herdr-dash] herdr is running elevated (Administrator) and this window is not -
echo [herdr-dash] so Windows refuses the pipe to every non-elevated process. This
echo [herdr-dash] window cannot start or stop the app while that is true, and a
echo [herdr-dash] console opened from it cannot either.

rem INFORMING IS THE DEFAULT. Only HD_ON_EPERM=elevate asks Windows for an
rem elevated copy; unset, empty, "inform" or a typo all explain the situation and
rem carry on here. That is the owner's decision, and the reason is measured: on
rem this machine the automatic request is silently DROPPED - Windows returns
rem success, no prompt appears, and no elevated process ever runs. A default that
rem tries a thing that cannot work here, and then has to apologise for it, is
rem worse than a default that says what is true and leaves the console running.
if /i not "%HD_ON_EPERM%"=="elevate" goto pipe_denied_manual
rem The marker is how the elevated copy is told what it is. If it is already set
rem then this IS that copy (or someone set it by hand) and elevating again could
rem only ever produce another prompt, and another, and another. So: never twice.
if "%HD_ELEVATED%"=="1" goto pipe_denied_manual

rem A console answering BEFORE the attempt changes what the success below is
rem allowed to claim: if one was already there, an answer afterwards proves
rem nothing about the elevated copy having started, and :el_up says so rather
rem than taking the credit. Only ever reached on this branch, which now needs
rem HD_ON_EPERM=elevate to be entered at all.
rem EL_WAS_UP is a FLAG, not the probe's exit code: 1 means "a console was
rem already answering". Two traps met here, both measured, both silent:
rem   * the probe answers 0 for "a console is there", so keeping its exit code
rem     and testing that for truth INVERTS the test - the first version did
rem     that and sent every clean port down the ambiguous path;
rem   * a successful `set` RESETS errorlevel to 0, so an `if errorlevel` that
rem     comes after a `set` reads the set, not the probe. Hence: read
rem     %errorlevel% into a variable on the very next line, then compare the
rem     variable. Never put a command between a probe and an errorlevel test.
node "tools\port-probe.js" %CTL_PORT% >nul 2>&1
set "EL_PROBE=%errorlevel%"
set "EL_WAS_UP=0"
if "%EL_PROBE%"=="0" set "EL_WAS_UP=1"

:el_runas
rem Start-Process -Verb RunAs is the same request Explorer's "Run as administrator"
rem makes. The command handed to the elevated cmd is
rem   set HD_ELEVATED=1&&call "<this file>" <arguments>
rem - the marker first, so the elevated copy cannot elevate again, then this whole
rem file, which means the elevated copy does its own port probe and starts its own
rem console.
rem The relaunch itself is tools\elevate-self.ps1, for the same reason the port
rem probe is tools\port-probe.js: inline, this was 249 characters of nested quotes
rem - over this file's line limit, and the kind of line whose correctness depends
rem on cmd and PowerShell agreeing about quotes. Only this file's path is passed on
rem the command line; a path cannot contain a quote. %* is left where it was in
rem HD_RL_ARGS in the environment, so the user's own quoting cannot be mangled.
rem -ErrorAction Stop inside that script still makes a refused prompt terminating,
rem which is worth having - but it is no longer what the exit code means. On this
rem machine the call can return SUCCESS and start nothing at all, which is why
rem nothing past this line trusts it. Errorlevel 1 only ends the wait early.
set "HD_RL_EXE=%~f0"
set "HD_RL_ARGS=%*"
powershell -NoProfile -File "tools\elevate-self.ps1" -Exe "%HD_RL_EXE%"
if errorlevel 1 goto el_fail

:el_wait
rem NEVER REPORT AN UNOBSERVED SUCCESS. Both routes above only ASK; neither can
rem tell whether anything ran. So wait for the thing actually wanted - the console
rem answering on CTL_PORT - in this file's own ping idiom, and treat its absence as
rem the failure it is. Bounded: 8 tries of about a second each, so this cannot hang,
rem and the loop body waits on nothing else.
set /a EL_TRY=0
:el_wait_loop
set /a EL_TRY+=1
node "tools\port-probe.js" %CTL_PORT% >nul 2>&1
if not errorlevel 1 goto el_up
if %EL_TRY% GEQ 8 goto el_fail
ping -n 2 127.0.0.1 >nul
goto el_wait_loop

:el_up
if "%EL_WAS_UP%"=="1" goto el_up_ambiguous
echo [herdr-dash] the elevated copy came up: the console is answering on port %CTL_PORT%.
echo [herdr-dash] open http://127.0.0.1:%CTL_PORT%/ - it can reach herdr.
endlocal & exit /b 0

:el_up_ambiguous
rem A console answered - but one was answering before the attempt too, so this file
rem did not observe the thing it was trying to achieve and will not claim it did.
echo [herdr-dash] a console is answering on port %CTL_PORT%, but one was answering before
echo [herdr-dash] this attempt as well, so this file cannot tell whether the elevated copy
echo [herdr-dash] started or the old console is still the one there. Open
echo [herdr-dash] http://127.0.0.1:%CTL_PORT%/ - if its herdr field still reads unreachable,
echo [herdr-dash] that is the old console, and nothing here replaced it.
endlocal & exit /b 0

:pipe_denied_manual
echo [herdr-dash] start this from an elevated shell: right-click herdr-dash.cmd -^> Run as administrator
echo [herdr-dash] ...or run herdr itself from a NON-elevated terminal (then no elevation is needed anywhere)
goto after_preflight

:el_fail
rem The honest ending, and the one this file used to get wrong: the block above used
rem to promise a console, and then exit 0 having started nothing at all. Either
rem Windows refused the request, or - measured on this machine - it accepted it and
rem silently dropped it with no prompt and no error. Those look identical from here
rem and both mean no console is coming, so this says so and exits nonzero.
rem Only reached with HD_ON_EPERM=elevate, so it is the opt-in that is being
rem reported on, not a default anyone was handed.
echo [herdr-dash] no console came up - the automatic elevation attempt started nothing.
echo [herdr-dash] Windows was asked and never produced a running process. A machine
echo [herdr-dash] configured to allow elevation without prompting does this silently, so
echo [herdr-dash] it is not a sign you did anything wrong. Routes that do work:
echo [herdr-dash] start this from an elevated shell: right-click herdr-dash.cmd -^> Run as administrator
echo [herdr-dash] ...or run herdr itself from a NON-elevated terminal (then no elevation is needed anywhere)
set "RC=1"
goto fail

:fail
rem A failure is worth reading, so this window waits - unless automation said not to.
if not "%HD_NO_PAUSE%"=="1" pause
endlocal & exit /b %RC%
