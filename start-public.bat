@echo off
cd /d "%~dp0"
echo Starting Unified Cloud Server + Internet Tunnel...
start "UnifiedCloudServer" cmd /k node server.js
timeout /t 2 /nobreak >nul
cloudflared.exe tunnel --url http://localhost:3456
pause
