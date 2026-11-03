@echo off
rem Stops the loop's own n8n (Agentic Audit Loop): the process that listens on
rem 127.0.0.1:5690, together with its child processes (n8n's task runner, and any
rem command a workflow is running at that moment). A restart that
rem start-n8n-loop.cmd is waiting to make is cancelled too.
rem It never touches the email assistant's n8n on port 5678.
rem This is a hard stop: the window is hidden, so there is no Ctrl+C. A workflow
rem that is running is cut off.
rem To start it again: run the Scheduled Task "n8n Loop (Agentic Audit Loop)", or
rem double-click start-n8n-loop.cmd.
rem After a stop it waits, up to 10 seconds, until the launcher has let go of its
rem lock logs\n8n-loop.lock, so a start right after this script works (Phase 7e).
rem
rem Every run adds one line to logs\stop.log. After its first line the script
rem writes nothing to the window until the work is done, so a window that is
rem stuck (a click in it freezes its output) cannot hold up the stop.
rem After a double-click the window stays open until a key is pressed.

setlocal
echo Looking for the loop's n8n on 127.0.0.1:5690. This takes a few seconds...
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
set "LOGS=%~dp0logs"
if not exist "%LOGS%" mkdir "%LOGS%"
set "OUT=%LOGS%\stop-last-run.txt"
set "FLAG=%LOGS%\stop-requested.flag"
set "STATE_FILE=%LOGS%\launcher-state.txt"
set "LOCK=%LOGS%\n8n-loop.lock"
type nul >"%OUT%"

rem Started by a double-click? Then the parent of this cmd.exe is explorer.exe.
rem N8N_LOOP_NO_PAUSE=1 skips the check and never waits for a key (for the tests).
set "STARTED_BY=a terminal or a script"
set "PAUSE_AT_END="
if not defined N8N_LOOP_NO_PAUSE call :find_parent

set "LOOP_PID="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:" 127\.0\.0\.1:5690 .*LISTENING"') do set "LOOP_PID=%%P"
if not defined LOOP_PID goto not_listening

rem Safety 1: never stop the process that serves port 5678, the email-assistant n8n.
set "OTHER_PID="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":5678 .*LISTENING"') do set "OTHER_PID=%%P"
if "%LOOP_PID%"=="%OTHER_PID%" (
  >>"%OUT%" echo Refusing: PID %LOOP_PID% also listens on port 5678, the email-assistant n8n. Nothing was stopped.
  set "RESULT=refused, PID %LOOP_PID% also listens on port 5678"
  set "EXIT_CODE=1"
  goto finish
)

rem Safety 2: n8n runs on Node. Stop nothing else that happens to use the port.
tasklist /fi "PID eq %LOOP_PID%" /fo csv /nh | findstr /i /c:"node.exe" >nul
if errorlevel 1 (
  >>"%OUT%" echo Refusing: PID %LOOP_PID% listens on 127.0.0.1:5690 but is not node.exe. Nothing was stopped.
  set "RESULT=refused, PID %LOOP_PID% on 127.0.0.1:5690 is not node.exe"
  set "EXIT_CODE=1"
  goto finish
)

rem Tell start-n8n-loop.cmd that this stop was asked for. The flag stays until
rem the next start removes it, so that every launcher still running sees it.
>"%FLAG%" echo stop requested by stop-n8n-loop.cmd

>>"%OUT%" echo Stopping the loop's n8n: PID %LOOP_PID% on 127.0.0.1:5690, with its child processes.
taskkill /pid %LOOP_PID% /t /f >>"%OUT%" 2>&1
set "KILL_EXIT=%errorlevel%"

rem The free port decides, not taskkill's exit code: taskkill also reports an error
rem when one child process was gone already. Up to 10 tries, about 10 seconds.
set "TRIES=0"
:waitfree
netstat -ano -p tcp | findstr /r /c:":5690 .*LISTENING" >nul
if errorlevel 1 goto freed
set /a "TRIES+=1"
if %TRIES% geq 10 goto notfreed
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
goto waitfree

:freed
>>"%OUT%" echo Stopped. Port 5690 is free.
call :wait_lock
set "RESULT=stopped PID %LOOP_PID%, port 5690 is free, taskkill exit code %KILL_EXIT%, %LOCK_RESULT%"
set "EXIT_CODE=0"
goto finish

:notfreed
rem n8n is still there, so the flag must not stay: a later crash would look like a stop.
del "%FLAG%" >nul 2>&1
>>"%OUT%" echo Not stopped: port 5690 still listens after about 10 seconds. taskkill ended with exit code %KILL_EXIT%.
set "RESULT=not stopped, PID %LOOP_PID% still listens on port 5690, taskkill exit code %KILL_EXIT%"
set "EXIT_CODE=1"
goto finish

:not_listening
rem Nothing listens. The launcher may still be alive: waiting to restart n8n after
rem a crash, or it started n8n a moment ago and the port is not open yet.
set "STATE="
if exist "%STATE_FILE%" set /p STATE=<"%STATE_FILE%"
if "%STATE%"=="waiting" goto cancel_restart
netstat -ano -p tcp | findstr /r /c:":5690 .*LISTENING" >nul && >>"%OUT%" echo Note: something listens on port 5690 on another address. This script does not touch it.
if "%STATE%"=="running" (
  >>"%OUT%" echo No process listens on 127.0.0.1:5690, but the launcher says it started n8n.
  >>"%OUT%" echo If that was less than two minutes ago, n8n is still starting: run this script again in a minute.
  >>"%OUT%" echo Otherwise logs\launcher-state.txt is left over from a crash or a power cut, and nothing is running.
  set "RESULT=nothing listens on 127.0.0.1:5690, launcher state is running, nothing was stopped"
  set "EXIT_CODE=1"
  goto finish
)
>>"%OUT%" echo Nothing was running: no process listens on 127.0.0.1:5690.
set "RESULT=nothing was running"
set "EXIT_CODE=0"
goto finish

:cancel_restart
>"%FLAG%" echo stop requested by stop-n8n-loop.cmd
set "TRIES=0"
:waitcancel
if not exist "%STATE_FILE%" goto cancelled
set /a "TRIES+=1"
if %TRIES% geq 6 goto notcancelled
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
goto waitcancel

:cancelled
>>"%OUT%" echo n8n was not running. A restart was waiting: cancelled.
call :wait_lock
set "RESULT=nothing listened on 127.0.0.1:5690, a waiting restart was cancelled, %LOCK_RESULT%"
set "EXIT_CODE=0"
goto finish

:notcancelled
rem No launcher took the flag: the state file was left over from a crash or a power cut.
del "%STATE_FILE%" >nul 2>&1
del "%FLAG%" >nul 2>&1
>>"%OUT%" echo Nothing was running. logs\launcher-state.txt said a restart was waiting, but no launcher answered: the file was left over and is removed.
set "RESULT=nothing was running, a left-over launcher state file was removed"
set "EXIT_CODE=0"
goto finish

:finish
node "%~dp0launcher-util.js" log stop.log "started by %STARTED_BY%: %RESULT%, exit code %EXIT_CODE%" >nul 2>&1
type "%OUT%"
if defined PAUSE_AT_END pause
exit /b %EXIT_CODE%

rem ---- subroutines ----

:wait_lock
rem The launcher lets go of logs\n8n-loop.lock only when it has ended, a moment after
rem n8n ended or the waiting restart was cancelled: it logs its last line first. A
rem start in that moment would find the lock taken and exit quietly. So this opens
rem the file the way the launcher does (a redirection; it fails while the launcher
rem holds it), once a second, up to 10 s. The open is silent and writes nothing.
rem No lock file, or an n8n started by hand without the launcher: free at once.
set "LOCK_S=0"
if not exist "%LOCK%" goto lock_free
:lock_try
2>nul (9>>"%LOCK%" (call )) && goto lock_free
if %LOCK_S% geq 10 goto lock_held
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
set /a "LOCK_S+=1"
goto lock_try
:lock_free
set "LOCK_RESULT=lock free after %LOCK_S% s"
exit /b 0
:lock_held
set "LOCK_RESULT=lock still held after 10 s: the launcher has not exited yet"
>>"%OUT%" echo The launcher still holds logs\n8n-loop.lock after 10 seconds: it has not exited yet. A start right now may exit quietly; wait a moment.
exit /b 0

:find_parent
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$me = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID); $script = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $me.ParentProcessId); $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $script.ParentProcessId); if ($parent -and $parent.Name -eq 'explorer.exe') { exit 10 } else { exit 0 }" >nul 2>&1
if not "%errorlevel%"=="10" exit /b 0
set "STARTED_BY=a double-click in Explorer"
set "PAUSE_AT_END=1"
exit /b 0
