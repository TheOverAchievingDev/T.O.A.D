@echo off
setlocal enabledelayedexpansion

REM Symphony desktop dev launcher: starts the backend API server and the
REM Tauri desktop shell (which internally spawns the Vite UI dev server
REM via tauri.conf.json's beforeDevCommand, so we don't open a separate
REM UI window). Use this instead of start-dev.bat when you need the
REM desktop-only features (native folder picker, native dialogs, IPC).
REM
REM Web-only mode (start-dev.bat) is faster to iterate on UI but cannot
REM exercise Tauri APIs like the folder picker — pick the script that
REM matches what you need to test.

set "PROJECT_ROOT=%~dp0"
set "TOAD_LOCAL=%PROJECT_ROOT%toad-local"
set "TOAD_UI=%TOAD_LOCAL%\ui"
set "TOKEN_FILE=%TOAD_LOCAL%\.toad\api-token"

REM Pick up an on-disk API token if one exists, so the UI shell sees VITE_TOAD_API_TOKEN.
set "VITE_TOAD_API_TOKEN="
if exist "%TOKEN_FILE%" (
  set /p VITE_TOAD_API_TOKEN=<"%TOKEN_FILE%"
)

echo.
echo  Symphony desktop dev environment
echo  --------------------------------
echo    Project: %PROJECT_ROOT%
echo    API:     http://127.0.0.1:3001
echo    UI:      http://localhost:5173  (proxied by Tauri webview)
echo    Shell:   Tauri desktop (Symphony AI window)
if defined VITE_TOAD_API_TOKEN (
  echo    Auth:    on  ^(token loaded from .toad\api-token^)
) else (
  echo    Auth:    off
)
echo.
echo  Two new console windows will open. Close them to stop the servers.
echo  The Tauri window will open shortly after Vite binds to port 5173.
echo.

REM Backend (HTTP+SSE bridge, persistent SQLite at toad-local\.toad\toad.db).
start "Symphony API" cmd /k "cd /d "%TOAD_LOCAL%" && npm run api:dev"

REM Tauri shell (runs `cargo run` against src-tauri/ AND spawns the Vite UI
REM dev server via beforeDevCommand from tauri.conf.json). Inherit
REM VITE_TOAD_API_TOKEN so the proxied UI sees it.
start "Symphony Tauri" cmd /k "cd /d "%TOAD_UI%" && set "VITE_TOAD_API_TOKEN=!VITE_TOAD_API_TOKEN!" && npm run tauri:dev"

REM No browser-open step — Tauri opens its own window once cargo builds
REM and Vite is reachable. First build can take ~30-60s.

endlocal
