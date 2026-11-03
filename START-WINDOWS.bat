@echo off
title Liberia Gateway Online College - school portal
cd /d "%~dp0"
echo.
echo  Liberia Gateway Online College - school portal
echo  =================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed on this computer yet.
  echo  Opening the download page. Install the "LTS" version,
  echo  then close this window and double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
node -e "process.exit(parseInt(process.versions.node)>=22?0:1)"
if errorlevel 1 (
  echo  Your Node.js is too old. This portal needs Node.js version 22 or newer.
  echo  Opening the download page. Install the "LTS" version,
  echo  then close this window and double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
node -e "require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  echo  First start: setting things up. This takes a minute or two...
  echo.
  if exist node_modules rmdir /s /q node_modules
  call npm install
  if errorlevel 1 (
    echo.
    echo  Setup failed. Check that this computer is connected to the internet.
    echo  Then close this window and double-click this file again.
    echo  If it still fails, take a photo or screenshot of this window and send it for help.
    pause
    exit /b 1
  )
)
if not exist data\lgou.db (
  echo.
  echo  Choose a password for the admin account. You will log in as: admin
  set /p ADMIN_PASSWORD= Admin password: 
)
echo.
echo  Starting the school portal...
echo  Your browser will open at http://localhost:3000
echo  Keep this window open while you use the site. Close it to stop the site.
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
node server.js
echo.
echo  The portal has stopped. If you see an error above, take a screenshot of this window and send it for help.
pause
