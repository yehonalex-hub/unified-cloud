@echo off
title Push Unified Cloud to GitHub
echo ========================================================
echo   Pushing Unified Cloud to GitHub and Render
echo   Target: https://github.com/yehonalex-hub/unified-cloud
echo ========================================================
echo.
if exist "C:\Program Files\Git\cmd" set "PATH=%PATH%;C:\Program Files\Git\cmd"
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git is not found in PATH.
    echo Please install Git from https://git-scm.com/download/win or GitHub Desktop.
    echo Once installed, rerun this file to push automatically!
    echo.
    pause
    exit /b
)

cd /d "%~dp0"
if not exist .git (
    echo Initializing Git repository...
    git init
    git branch -M main
    git remote add origin https://github.com/yehonalex-hub/unified-cloud.git
)

echo Adding files...
git add .
echo Committing latest changes...
git commit -m "Update Unified Cloud: README showcase, preview graphics and team bots" >nul 2>nul
echo Pushing to GitHub main branch...
git push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo   [SUCCESS] Pushed to GitHub successfully!
    echo   Render is now deploying your latest changes 24/7!
    echo ========================================================
) else (
    echo.
    echo [NOTE] Push failed. If this is your first push, please make sure
    echo you are logged into GitHub via Git Credential Manager or GitHub Desktop.
)
echo.
pause
