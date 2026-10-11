@echo off
setlocal
cd /d "%~dp0"
if exist .venv\Scripts\python.exe goto install
where py >nul 2>nul
if errorlevel 1 goto fallback
py -3 -m venv .venv
if errorlevel 1 goto failed
goto install
:fallback
where python >nul 2>nul
if errorlevel 1 goto missing
python -m venv .venv
if errorlevel 1 goto failed
:install
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
if errorlevel 1 goto failed
echo Ready. Run start_windows.bat
exit /b 0
:missing
echo Install Python 3.12 or newer from python.org with Python Launcher.
:failed
echo Setup failed. Copy the error text, without API keys.
pause
exit /b 1
