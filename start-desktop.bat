@echo off
setlocal enabledelayedexpansion

REM Symphony desktop dev launcher.
REM
REM IMPORTANT: This script does NOT spawn the Node API server itself.
REM The Tauri shell (src-tauri/src/main.rs) spawns the API server as a
REM child process with the correct TOAD_PROJECT_CWD env var derived from
REM the user's saved active-project. If we ALSO spawn the API here, two
REM API servers race for port 3001 and the bat-spawned one (with the
REM wrong cwd — Symphony's own install dir) often wins. That has caused
REM agents to spawn inside Symphony's folder and read its source. See
REM PROJECT.md §4: the agent isolation contract requires the sidecar's
REM projectCwd to come from Tauri's `switch_project` flow, not from
REM `process.cwd()` of a bat-spawned npm run.
REM
REM This script:
REM   - Starts ONLY the Tauri shell, which internally spawns:
REM       - the Node API server (with TOAD_PROJECT_CWD set correctly)
REM       - the Vite UI dev server (via tauri.conf.json beforeDevCommand)
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
echo    API:     http://127.0.0.1:3001  (spawned by Tauri with correct TOAD_PROJECT_CWD)
echo    UI:      http://localhost:5173  (proxied by Tauri webview)
echo    Shell:   Tauri desktop (Symphony AI window)
if defined VITE_TOAD_API_TOKEN (
  echo    Auth:    on  ^(token loaded from .toad\api-token^)
) else (
  echo    Auth:    off
)
echo.
echo  One new console window will open. Close it to stop the dev environment.
echo  The Tauri window will open shortly after Vite binds to port 5173.
echo.

REM Tauri shell — internally spawns BOTH the Node API server (with
REM TOAD_PROJECT_CWD env var from the persisted active-project) AND the
REM Vite UI dev server (via beforeDevCommand from tauri.conf.json).
REM Inherit VITE_TOAD_API_TOKEN so the proxied UI sees it.
start "Symphony Tauri" cmd /k "cd /d "%TOAD_UI%" && set "VITE_TOAD_API_TOKEN=!VITE_TOAD_API_TOKEN!" && npm run tauri:dev"

REM No browser-open step — Tauri opens its own window once cargo builds
REM and Vite is reachable. First build can take ~30-60s.

endlocal
