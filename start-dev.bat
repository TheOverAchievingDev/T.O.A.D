@echo off
setlocal enabledelayedexpansion

REM TOAD dev launcher: starts the backend API server and the Vite UI dev server,
REM then opens the dashboard in the default browser.

set "PROJECT_ROOT=%~dp0"
set "TOAD_LOCAL=%PROJECT_ROOT%toad-local"
set "TOKEN_FILE=%TOAD_LOCAL%\.toad\api-token"

REM Pick up an on-disk API token if one exists, so the UI shell sees VITE_TOAD_API_TOKEN
set "VITE_TOAD_API_TOKEN="
if exist "%TOKEN_FILE%" (
  set /p VITE_TOAD_API_TOKEN=<"%TOKEN_FILE%"
)

echo.
echo  TOAD dev environment
echo  --------------------
echo    Project: %PROJECT_ROOT%
echo    API:     http://127.0.0.1:3001
echo    UI:      http://localhost:5173
if defined VITE_TOAD_API_TOKEN (
  echo    Auth:    on  ^(token loaded from .toad\api-token^)
) else (
  echo    Auth:    off
)
echo.
echo  Two new console windows will open. Close them to stop the servers.
echo.

REM Backend (HTTP+SSE bridge, persistent SQLite at toad-local\.toad\toad.db)
start "TOAD API" cmd /k "cd /d "%TOAD_LOCAL%" && npm run api:dev"

REM UI (Vite dev server). Inherit VITE_TOAD_API_TOKEN if present.
start "TOAD UI" cmd /k "cd /d "%TOAD_LOCAL%\ui" && set "VITE_TOAD_API_TOKEN=!VITE_TOAD_API_TOKEN!" && npm run dev"

REM Give Vite a moment to bind, then open the browser
timeout /t 4 /nobreak >nul
start "" http://localhost:5173

endlocal
