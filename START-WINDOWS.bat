@echo off
title Liberia Gateway Online University - school portal
cd /d "%~dp0"
echo.
echo  Liberia Gateway Online University - school portal
echo  =================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed on this computer yet.
  echo  Opening the download page. Install the "LTS" version,
  echo  then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
if not exist node_modules (
  echo  First start: setting things up. This takes a minute or two...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  Setup failed. Check that this computer is connected to the internet and try again.
    pause
    exit /b 1
  )
)
if not exist data (
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
echo  The portal has stopped.
pause
