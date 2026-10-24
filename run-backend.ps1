# Starts the JobCopilot backend on http://127.0.0.1:8765 (local only).
# First run creates the virtualenv and installs dependencies.
$ErrorActionPreference = "Stop"
$backend = Join-Path $PSScriptRoot "backend"
$py = Join-Path $backend ".venv\Scripts\python.exe"
# A key saved with setx only reaches programs started later; read it from the
# user environment so already-open terminals work too.
if (-not $env:ANTHROPIC_API_KEY) {
    $env:ANTHROPIC_API_KEY = [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
}
if (-not (Test-Path $py)) {
    python -m venv (Join-Path $backend ".venv")
    & $py -m pip install -q -r (Join-Path $backend "requirements.txt")
}
& $py -m uvicorn app.main:app --app-dir $backend --host 127.0.0.1 --port 8765
