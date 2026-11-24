@echo off
cd /d "%~dp0"
echo Starting Unified Cloud at http://localhost:3456 ...
start "" http://localhost:3456
node server.js
pause
