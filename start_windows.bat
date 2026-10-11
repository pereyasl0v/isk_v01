@echo off
setlocal
cd /d "%~dp0"
if exist .venv\Scripts\python.exe goto run
call setup_windows.bat
if errorlevel 1 exit /b 1
:run
echo Starting local app at http://127.0.0.1:8000
echo Keep this window open. Press Ctrl+C to stop.
.venv\Scripts\python.exe run.py
if errorlevel 1 pause
