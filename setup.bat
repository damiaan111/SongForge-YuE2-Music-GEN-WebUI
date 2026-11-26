@echo off
rem Installs SongForge. Double-click this file, or run it from a terminal.
rem
rem   setup.bat                 choose what to install from a menu
rem   setup.bat --yes           install everything required, no questions
rem   setup.bat --yes --with-lyrics   ... and the optional lyrics writer
rem   setup.bat --detect        print what was detected on this computer
rem
rem Windows blocks unsigned .ps1 files from running when double-clicked, so this
rem wrapper starts the real script with that check relaxed for this one process.
rem Nothing about the system-wide execution policy is changed.
title SongForge setup
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
exit /b %ERRORLEVEL%
