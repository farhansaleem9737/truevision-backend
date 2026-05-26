# start.ps1 — Windows PowerShell launcher for the TrueVision AI service.
#
# Usage:
#   cd Backend\services\ai
#   .\start.ps1
#
# What it does:
#   1. Creates a venv at .\.venv if missing.
#   2. Activates it.
#   3. Installs requirements (skipped if already satisfied).
#   4. Starts uvicorn with auto-reload.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path ".\.venv")) {
    Write-Host "Creating virtualenv at .\.venv ..."
    python -m venv .venv
}

Write-Host "Activating virtualenv ..."
. .\.venv\Scripts\Activate.ps1

Write-Host "Installing/updating requirements ..."
pip install --upgrade pip > $null
pip install -r requirements.txt

$port = if ($env:AI_PORT) { $env:AI_PORT } else { 8001 }
$host_ = if ($env:AI_HOST) { $env:AI_HOST } else { "0.0.0.0" }

Write-Host "Starting uvicorn on $host_`:$port ..."
uvicorn main:app --host $host_ --port $port --reload
