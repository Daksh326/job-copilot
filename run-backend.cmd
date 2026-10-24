@echo off
rem Starts the JobCopilot backend on http://127.0.0.1:8765 (local only).
rem Same as run-backend.ps1, but works without changing PowerShell's script policy.
setlocal
set "BACKEND=%~dp0backend"
set "PY=%BACKEND%\.venv\Scripts\python.exe"
rem A key saved with setx only reaches programs started later; read it from the
rem user environment so already-open terminals work too.
if not defined ANTHROPIC_API_KEY (
  for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v ANTHROPIC_API_KEY 2^>nul ^| find "ANTHROPIC_API_KEY"') do set "ANTHROPIC_API_KEY=%%b"
)
if not exist "%PY%" (
  python -m venv "%BACKEND%\.venv" || exit /b 1
  "%PY%" -m pip install -q -r "%BACKEND%\requirements.txt" || exit /b 1
)
"%PY%" -m uvicorn app.main:app --app-dir "%BACKEND%" --host 127.0.0.1 --port 8765
