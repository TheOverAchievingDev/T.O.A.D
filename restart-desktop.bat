@echo off
setlocal enabledelayedexpansion

REM Symphony desktop dev restart: kills the API + UI dev servers AND the
REM Tauri shell/cargo build, waits for ports + processes to free, then
REM re-launches via start-desktop.bat.
REM
REM Sibling to restart-dev.bat — that one is for web-only mode, this one
REM cleans up the additional Tauri-side processes (cargo, the compiled
REM Symphony AI.exe window, plus any stragglers from a crashed tauri-dev
REM run that leaked file locks on target/debug/).

set "PROJECT_ROOT=%~dp0"

echo.
echo  Symphony desktop dev restart
echo  ----------------------------

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

REM Close the labelled windows from a prior start-desktop.bat run so we
REM don't accumulate orphaned terminal windows.
taskkill /F /FI "WINDOWTITLE eq Symphony API*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Symphony UI*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Symphony Tauri*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Symphony AI*" >nul 2>&1

REM Kill the compiled Tauri shell window if it's running. productName in
REM tauri.conf.json is "Symphony AI" → the cargo-built binary is
REM target/debug/app.exe but presents the window class via productName.
REM Best-effort: kill anything matching the window title.
taskkill /F /IM "Symphony AI.exe" >nul 2>&1
taskkill /F /IM "app.exe" >nul 2>&1

REM Kill any in-flight cargo build that's still holding file locks on
REM target/debug/. Without this a fast restart hits "Access is denied"
REM when cargo tries to rebuild.
taskkill /F /IM cargo.exe >nul 2>&1
taskkill /F /IM rustc.exe >nul 2>&1

REM Give the OS a moment to free the sockets + file locks.
timeout /t 3 /nobreak >nul

echo  Ports clear. Relaunching via start-desktop.bat...
echo.
call "%PROJECT_ROOT%start-desktop.bat"

endlocal
