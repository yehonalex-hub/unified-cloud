@echo off
chcp 65001 >nul
title MyCloud Drive (Z:\) - Unified Cloud
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mount-drive.ps1" %*
if %errorlevel% neq 0 (
    echo.
    pause
)
