#!/bin/bash
cd "$(dirname "$0")"
echo
echo " Liberia Gateway Online University - school portal"
echo " ================================================="
echo
if ! command -v node >/dev/null 2>&1; then
  echo " Node.js is not installed on this computer yet."
  echo " Opening the download page. Install the LTS version,"
  echo " then double-click this file again."
  (open https://nodejs.org/en/download || xdg-open https://nodejs.org/en/download) >/dev/null 2>&1
  read -n 1 -s -r -p " Press any key to close..."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo " First start: setting things up. This takes a minute or two..."
  echo
  if ! npm install; then
    echo
    echo " Setup failed. Check your internet connection and try again."
    read -n 1 -s -r -p " Press any key to close..."
    exit 1
  fi
fi
if [ ! -d data ]; then
  echo
  echo " Choose a password for the admin account. You will log in as: admin"
  read -s -p " Admin password: " ADMIN_PASSWORD
  echo
  export ADMIN_PASSWORD
fi
echo
echo " Starting the school portal..."
echo " Your browser will open at http://localhost:3000"
echo " Keep this window open while you use the site. Close it to stop the site."
echo
( sleep 4; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null ) &
node server.js
echo
read -n 1 -s -r -p " The portal has stopped. Press any key to close..."
