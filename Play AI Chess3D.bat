@echo off
setlocal enabledelayedexpansion
title AI Chess3D
cd /d "%~dp0"

rem  Double-click this to play.
rem
rem  A .bat is here because Windows has no file association for .py unless
rem  Python was installed with one, so double-clicking server.py does nothing
rem  at all -- no error, no window, nothing.
rem
rem  Every candidate below is tried by actually running it, not by checking
rem  that the command exists. The py launcher in particular will happily point
rem  at an interpreter that has been moved or deleted, and reports it as
rem  present right up until you try to start it.

rem  A packaged copy carries its own program and needs no Python at all.
set "EXE="
if exist "%~dp0AIChess3D.exe" set "EXE=%~dp0AIChess3D.exe"
if defined EXE goto :run

set "PY="

call :try "py -3"
if not defined PY call :try "python"
if not defined PY call :try "python3"

rem  Installed but not on PATH -- what a "just for me" install leaves behind.
for %%V in (314 313 312 311 310 39) do (
  if not defined PY call :try "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
  if not defined PY call :try "C:\Python%%V\python.exe"
  if not defined PY call :try "%ProgramFiles%\Python%%V\python.exe"
)

if not defined PY (
  echo.
  echo   AI Chess3D needs Python, and no working one could be found here.
  echo.
  echo   Install it from  https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH" on the first screen.
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

:run
echo.
echo   Starting AI Chess3D...
echo   Close this window to stop the game.
echo.

if defined EXE (
  "%EXE%" %*
) else (
  %PY% "%~dp0server.py" %*
)
set "CODE=%ERRORLEVEL%"

rem  Ctrl-C is how you are meant to stop it, so only hold the window open for
rem  a real failure the player needs to read.
if "%CODE%"=="0" exit /b 0
if "%CODE%"=="2" exit /b 0
if "%CODE%"=="3221225786" exit /b 0

echo.
echo   AI Chess3D stopped with error %CODE%.
echo.
pause
exit /b %CODE%


:try
rem  Accept a candidate only if it can actually run and report its version.
%~1 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
if not errorlevel 1 set "PY=%~1"
exit /b 0
