@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SAT LAUNCHER - Installer Build
set "APP_VERSION="
set "NODE_DIR="
where node.exe >nul 2>nul
if not errorlevel 1 (
  where npm.cmd >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%P in ('where node.exe') do if not defined NODE_DIR for %%D in ("%%~dpP.") do set "NODE_DIR=%%~fD"
  )
)
if defined NODE_DIR goto node_ready
echo Node.js was not found in PATH. Downloading portable Node.js 22 LTS...
set "TOOLS_DIR=%CD%\.build-tools"
if not exist "%TOOLS_DIR%" mkdir "%TOOLS_DIR%"
set "NODE_VERSION="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$r=Invoke-RestMethod 'https://nodejs.org/dist/index.json'; ($r | Where-Object { $_.version -like 'v22.*' -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1).version"`) do set "NODE_VERSION=%%V"
if not defined NODE_VERSION goto node_download_failed
set "NODE_ZIP=%TOOLS_DIR%\node-%NODE_VERSION%-win-x64.zip"
set "NODE_EXTRACT=%TOOLS_DIR%\node-%NODE_VERSION%-win-x64"
if not exist "%NODE_EXTRACT%\node.exe" (
  echo Downloading %NODE_VERSION%...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip' -OutFile '%NODE_ZIP%'; Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%TOOLS_DIR%' -Force"
  if errorlevel 1 goto node_download_failed
)
set "NODE_DIR=%NODE_EXTRACT%"
if not exist "%NODE_DIR%\npm.cmd" goto node_download_failed
:node_ready
set "PATH=%NODE_DIR%;%PATH%"
for /f "usebackq delims=" %%V in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw package.json | ConvertFrom-Json).version"`) do set "APP_VERSION=%%V"
if not defined APP_VERSION goto version_read_failed
title SAT LAUNCHER %APP_VERSION% - Installer Build
echo Building version: %APP_VERSION%
echo.
echo Installing project dependencies...
call "%NODE_DIR%\npm.cmd" install --no-audit --no-fund
if errorlevel 1 goto dependency_failed
echo.
echo Preparing Electron and Windows installer tools...
call "%NODE_DIR%\npm.cmd" rebuild electron --no-audit --no-fund
if errorlevel 1 goto electron_setup_failed
if not exist "node_modules\electron\dist\electron.exe" goto electron_runtime_missing
echo.
echo Running project checks...
call "%NODE_DIR%\npm.cmd" run check
if errorlevel 1 goto checks_failed
if exist "release\SAT-LAUNCHER-%APP_VERSION%-Setup.exe" del /f /q "release\SAT-LAUNCHER-%APP_VERSION%-Setup.exe"
echo.
echo Building SAT LAUNCHER %APP_VERSION% Setup.exe...
call "%NODE_DIR%\npm.cmd" run dist
if errorlevel 1 goto build_failed
if not exist "release\SAT-LAUNCHER-%APP_VERSION%-Setup.exe" goto artifact_missing
for %%F in ("release\SAT-LAUNCHER-%APP_VERSION%-Setup.exe") do if %%~zF LSS 1048576 goto artifact_too_small
echo.
echo SUCCESS: release\SAT-LAUNCHER-%APP_VERSION%-Setup.exe
start "" "%CD%\release"
pause
exit /b 0
:version_read_failed
echo ERROR: Could not read the version from package.json.
echo Check package.json syntax and confirm Node.js is working.
goto failed
:node_download_failed
echo ERROR: Could not download portable Node.js from nodejs.org.
echo Check your Internet connection or install Node.js 22 LTS manually from https://nodejs.org/.
goto failed
:dependency_failed
echo ERROR: npm install failed. Check the network connection and the npm output above.
goto failed
:checks_failed
echo ERROR: Project checks failed. Read the test output above.
goto failed
:electron_setup_failed
echo ERROR: Could not prepare Electron or the Windows installer tools.
echo Check the npm output and confirm the dependency install scripts are approved in package.json.
goto failed
:electron_runtime_missing
echo ERROR: Electron runtime was not downloaded to node_modules\electron\dist\electron.exe.
echo Check the network connection and the Electron install output above.
goto failed
:build_failed
echo ERROR: Electron Builder failed. Read the output above.
goto failed
:artifact_missing
echo ERROR: The Setup.exe file was not created.
goto failed
:artifact_too_small
echo ERROR: The Setup.exe file is unexpectedly small.
goto failed
:failed
echo.
echo BUILD FAILED. No successful installer is being reported.
pause
exit /b 1
