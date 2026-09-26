@echo off
REM Install dsh-appearance into the desktop profile (ASCII only on purpose).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Plugin.ps1" -Profile desktop
echo.
pause
