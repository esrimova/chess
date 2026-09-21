@echo off
rem Double-click to play. Opens a browser at the board.
cd /d "%~dp0"
python server.py %*
if errorlevel 1 pause
