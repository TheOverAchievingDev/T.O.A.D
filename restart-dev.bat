@echo off
setlocal enabledelayedexpansion

REM Symphony dev restart: kills the API + UI dev servers (port-based so it
REM doesn't murder unrelated node.exe processes like Claude Code), waits a
REM beat for the ports to free, then re-launches via start-dev.bat.
REM
REM Use after every backend (toad-local/src/**) change since `npm run api:dev`
REM does NOT auto-reload on file changes. UI changes hot-reload via Vite and
REM don't need this.

set "PROJECT_ROOT=%~dp0"

echo.
echo  Symphony dev restart
echo  --------------------

REM Backend API: 127.0.0.1:3001
echo  Killing processes on port 3001 (API)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
  echo    Stopping PID %%a
  taskkill /F /PID %%a >nul 2>&1
)

REM UI dev server: localhost:5173
echo  Killing processes on port 5173 (UI)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
  echo    Stopping PID %%a
  taskkill /F /PID %%a >nul 2>&1
)

REM Also kill anything still claiming Vite's HMR WebSocket port (24678 default).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :24678 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM Close the labelled windows from a prior start-dev.bat run so we don't
REM accumulate orphaned terminal windows. Best-effort; ignored if not running.
taskkill /F /FI "WINDOWTITLE eq Symphony API*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Symphony UI*" >nul 2>&1

REM Also clean up any Tauri stragglers in case the user just switched
REM from desktop mode (start-desktop.bat / restart-desktop.bat) to
REM web mode. Otherwise the Tauri window keeps running and points at a
REM stale Vite server.
taskkill /F /FI "WINDOWTITLE eq Symphony Tauri*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Symphony AI*" >nul 2>&1
taskkill /F /IM "Symphony AI.exe" >nul 2>&1
taskkill /F /IM "app.exe" >nul 2>&1

REM Give the OS a moment to free the sockets so the relaunch doesn't EADDRINUSE.
timeout /t 2 /nobreak >nul

echo  Ports clear. Relaunching via start-dev.bat...
echo.
call "%PROJECT_ROOT%start-dev.bat"

endlocal
