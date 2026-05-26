#!/usr/bin/env bash
# start.sh — POSIX launcher for the TrueVision AI service (macOS / Linux / WSL).
#
# Usage:
#   cd Backend/services/ai
#   chmod +x start.sh
#   ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creating virtualenv at ./.venv ..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "Installing/updating requirements ..."
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

PORT="${AI_PORT:-8001}"
HOST="${AI_HOST:-0.0.0.0}"

echo "Starting uvicorn on ${HOST}:${PORT} ..."
exec uvicorn main:app --host "${HOST}" --port "${PORT}" --reload
