#!/bin/bash
cd "$(dirname "$0")"
echo
echo " Liberia Gateway Online College - school portal"
echo " ================================================="
echo
openpage() { (open https://nodejs.org/en/download || xdg-open https://nodejs.org/en/download) >/dev/null 2>&1; }
if ! command -v node >/dev/null 2>&1; then
  echo " Node.js is not installed on this computer yet."
  echo " Opening the download page. Install the LTS version,"
  echo " then close this window and double-click this file again."
  openpage; read -n 1 -s -r -p " Press any key to close..."; exit 1
fi
if ! node -e "process.exit(parseInt(process.versions.node)>=22?0:1)"; then
  echo " Your Node.js is too old. This portal needs Node.js version 22 or newer."
  echo " Opening the download page. Install the LTS version,"
  echo " then close this window and double-click this file again."
  openpage; read -n 1 -s -r -p " Press any key to close..."; exit 1
fi
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo " First start: setting things up. This takes a minute or two..."
  echo
  rm -rf node_modules
  if ! npm install; then
    echo
    echo " Setup failed. Check your internet connection and try again."
    echo " If it still fails, take a screenshot of this window and send it for help."
    read -n 1 -s -r -p " Press any key to close..."
    exit 1
  fi
fi
if [ ! -f data/lgou.db ]; then
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
echo " The portal has stopped. If you see an error above, take a screenshot and send it for help."
read -n 1 -s -r -p " Press any key to close..."
