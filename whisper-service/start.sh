#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create virtualenv if it does not exist
if [ ! -d ".venv" ]; then
  echo "Creating virtualenv..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# Install/update dependencies
pip install -q -r requirements.txt

# Config from the ROOT .env: ONLY the WHISPER_* variables (no backend secrets).
# Single source shared with docker-compose; this service has no .env of its own.
if [ -f "../.env" ]; then
  export $(grep -E '^WHISPER_' ../.env | xargs)
fi

echo "Starting whisper service on http://localhost:9000"
echo "Model:  ${WHISPER_MODEL:-small}"
echo "Device: ${WHISPER_DEVICE:-cpu} (${WHISPER_COMPUTE_TYPE:-int8})"

uvicorn main:app --host 0.0.0.0 --port 9000 --reload
