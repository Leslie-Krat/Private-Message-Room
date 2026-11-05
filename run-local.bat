@echo off
cd /d "%~dp0"
if not exist Zero-Room.net\node_modules (cd Zero-Room.net && call npm install --omit=dev && cd ..)
start "" http://localhost:3000
node run-local.mjs
pause
