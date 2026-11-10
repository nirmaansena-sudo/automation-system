@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Nirmaan Sena - automation system
cd /d "%~dp0"

echo.
echo  ==============================================
echo    Nirmaan Sena - automation system
echo  ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto :oldnode

if not exist "node_modules\h3-js\package.json" (
  echo  Installing the pinned local hex-grid library ^(first start only^)...
  call npm ci --omit=dev --ignore-scripts --no-fund
  if errorlevel 1 (
    echo  Dependency install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem The database must not live inside OneDrive (sync can lock or corrupt it).
echo %CD% | findstr /I "OneDrive" >nul
if not errorlevel 1 (
  set "NS_DEFAULT_DATA_DIR=%LOCALAPPDATA%\NirmaanSena\data"
  echo  This folder is inside OneDrive, so the database is kept in:
  echo    !NS_DEFAULT_DATA_DIR!
  echo  ^(set DATA_DIR in the .env file to choose another place^)
  echo.
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo  Created .env from .env.example ^(WhatsApp simulator mode^).
  echo.
)

echo  Starting... the dashboard opens in your browser.
echo  Keep this window open while you use the system. Close it to stop.
echo.
node --disable-warning=ExperimentalWarning server\main.js --open
echo.
echo  The system has stopped. Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo  Node.js is not installed on this computer.
echo.
echo  1. Install Node.js LTS ^(version 22 or newer^) from https://nodejs.org
echo     or open PowerShell and run:  winget install OpenJS.NodeJS.LTS
echo  2. Close this window and double-click start-windows.bat again.
echo.
pause
exit /b 1

:oldnode
echo  Your Node.js is too old. Please install Node.js 22.13 or newer from https://nodejs.org
echo.
pause
exit /b 1
