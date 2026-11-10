@echo off
setlocal EnableExtensions EnableDelayedExpansion
title n8n - Nirmaan Sena workflows
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js first ^(see start-windows.bat^).
  pause
  exit /b 1
)
echo %CD% | findstr /I "OneDrive" >nul
if not errorlevel 1 set "NS_DEFAULT_DATA_DIR=%LOCALAPPDATA%\NirmaanSena\data"

rem Load the settings n8n needs (backend URL, automation key, shared secret, AI key).
for /f "usebackq delims=" %%L in (`node scripts\n8n-env.js cmd`) do %%L

echo.
echo  Starting n8n on http://localhost:5678  ^(first start downloads n8n, this can take a few minutes^)
echo  Then: create your n8n owner account, import the files in n8n\workflows and publish them.
echo  Guide: n8n\README.md
echo.
call npx --yes n8n
pause
