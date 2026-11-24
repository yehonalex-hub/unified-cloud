@echo off
chcp 65001 >nul
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -ArgumentList '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File','\"%~dp0mount-drive.ps1\"' -WindowStyle Hidden"
exit
