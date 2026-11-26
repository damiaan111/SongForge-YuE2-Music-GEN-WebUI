@echo off
rem Starts SongForge. Double-click this file, or run it from a terminal.
rem
rem   start.bat             this computer only
rem   start.bat -Lan        also reachable from other devices on your network
rem   start.bat -NoBrowser  do not open the browser
rem
rem Windows blocks unsigned .ps1 files from running when double-clicked, so this
rem wrapper starts the real script with that check relaxed for this one process.
rem Nothing about the system-wide execution policy is changed.
title SongForge
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-SongForge.ps1" %*
exit /b %ERRORLEVEL%
