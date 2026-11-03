@echo off
rem Starts the loop's own n8n (Agentic Audit Loop) on this PC, on 127.0.0.1:5690 only.
rem Run at log on by the Scheduled Task "n8n Loop (Agentic Audit Loop)".
rem It is separate from the email assistant's n8n (port 5678) and does not touch it.
rem To stop it, run stop-n8n-loop.cmd.
rem
rem When n8n ends by itself, this script waits 60 seconds and starts it again, at
rem most 3 times in a row. A run that stayed up 10 minutes or more resets that count.
rem Every event is one line in logs\launcher.log.
rem
rem One launcher at a time: this script holds logs\n8n-loop.lock open for its whole
rem life, every restart included. A second launcher cannot open it and exits 0 at once.
rem n8n runs in a hidden window of its own (see :start_n8n); its log is logs\n8n.log.

setlocal
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm;%PATH%"

rem Load settings from .env (blank lines and lines starting with # are skipped).
rem Never start without it: n8n's defaults would listen on every network interface,
rem on the email-assistant n8n's ports, and would keep their data in %USERPROFILE%\.n8n.
if not exist ".env" (
  echo .env not found in %~dp0 - n8n was not started. Copy .env.example to .env first.
  exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"

title n8n loop (5690) - keep this open
if not exist "logs" mkdir "logs"

set "MAX_RESTARTS=3"
set "RESTART_WAIT_S=60"
set "LONG_RUN_S=600"
rem For the tests only: they make the two times short. The Scheduled Task never
rem sets these variables.
if defined N8N_LOOP_TEST_RESTART_WAIT_S set "RESTART_WAIT_S=%N8N_LOOP_TEST_RESTART_WAIT_S%"
if defined N8N_LOOP_TEST_LONG_RUN_S set "LONG_RUN_S=%N8N_LOOP_TEST_LONG_RUN_S%"

rem The lock is an open file: only one launcher at a time can hold logs\n8n-loop.lock.
rem Everything from here to the launcher's end runs inside :run, so the handle is held
rem through every restart. Windows lets go of it when the launcher ends, also after a
rem crash or a power cut: a lock FILE left on the disk blocks nothing.
set "GOT_LOCK="
call :run 9>"logs\n8n-loop.lock"
set "LAUNCHER_EXIT=%errorlevel%"
if not defined GOT_LOCK (
  call :log "another launcher holds logs\n8n-loop.lock: quiet exit 0"
  exit /b 0
)
exit /b %LAUNCHER_EXIT%

:run
set "GOT_LOCK=1"

rem Already running? Exit quietly so this n8n never starts twice. This still matters
rem with the lock: an n8n started by hand, or by a launcher from before the lock, has
rem the port but no lock.
netstat -ano -p tcp | findstr /r /c:":5690 .*LISTENING" >nul
if not errorlevel 1 (
  call :log "port 5690 already listens: n8n was not started, quiet exit 0"
  exit /b 0
)

rem A stop flag left over from an earlier stop must not count for this run.
rem Only a new start removes the flag: see stop-n8n-loop.cmd.
if exist "logs\stop-requested.flag" del "logs\stop-requested.flag" >nul 2>&1
set "RESTARTS=0"

:start_n8n
call :log "start: n8n is starting, restart %RESTARTS% of %MAX_RESTARTS%"
>"logs\launcher-state.txt" echo running
call :epoch STARTED_S
rem n8n is started through PowerShell's Start-Process, which starts a program the way
rem Explorer does: Windows passes none of this script's open handles on. A program
rem started here directly would get the lock's handle, and so would everything it
rem starts: the bot's builder and auditor jobs, which outlive a stop of n8n. The lock
rem would then stay taken after this launcher ended, and the next start would exit.
rem n8n gets this script's environment, .env included, and runs in a hidden window.
set N8N_LOOP_START="%APPDATA%\npm\n8n.cmd" start
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$p = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c ' + [char]34 + $env:N8N_LOOP_START + [char]34) -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode"
set "N8N_EXIT=%errorlevel%"
call :epoch ENDED_S
set /a "RAN_S=ENDED_S-STARTED_S"
del "logs\launcher-state.txt" >nul 2>&1

rem stop-n8n-loop.cmd leaves a flag file when the stop was asked for. Then this
rem script ends with code 0, so the task's "Last Run Result" is 0 after a stop.
if exist "logs\stop-requested.flag" (
  call :log "n8n ended: exit code %N8N_EXIT% after %RAN_S% s, stop flag seen: yes, no restart, launcher exits 0"
  exit /b 0
)

rem Without the flag n8n ended by itself: start it again, unless it did so
rem %MAX_RESTARTS% times in a row already.
if %RAN_S% geq %LONG_RUN_S% set "RESTARTS=0"
if %RESTARTS% geq %MAX_RESTARTS% (
  call :log "n8n ended: exit code %N8N_EXIT% after %RAN_S% s, stop flag seen: no, %MAX_RESTARTS% restarts in a row are used up, launcher exits %N8N_EXIT%"
  exit /b %N8N_EXIT%
)
set /a "RESTARTS+=1"
call :log "n8n ended: exit code %N8N_EXIT% after %RAN_S% s, stop flag seen: no, restart %RESTARTS% of %MAX_RESTARTS% in %RESTART_WAIT_S% s"

rem Wait, and look for the stop flag every second: stop-n8n-loop.cmd cancels a
rem waiting restart that way.
>"logs\launcher-state.txt" echo waiting
set "WAITED_S=0"
:wait
if exist "logs\stop-requested.flag" (
  del "logs\launcher-state.txt" >nul 2>&1
  call :log "stop flag seen during the wait: restart %RESTARTS% cancelled, launcher exits 0"
  exit /b 0
)
if %WAITED_S% geq %RESTART_WAIT_S% goto waited
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
set /a "WAITED_S+=1"
goto wait

:waited
del "logs\launcher-state.txt" >nul 2>&1
netstat -ano -p tcp | findstr /r /c:":5690 .*LISTENING" >nul
if not errorlevel 1 (
  call :log "port 5690 already listens: restart %RESTARTS% not needed, quiet exit 0"
  exit /b 0
)
goto start_n8n

rem ---- subroutines ----

:log
node "%~dp0launcher-util.js" log launcher.log %1 >nul 2>&1
exit /b 0

:epoch
set "%~1=0"
for /f %%T in ('node "%~dp0launcher-util.js" epoch') do set "%~1=%%T"
exit /b 0
