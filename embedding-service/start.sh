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

# Config from the ROOT .env: ONLY the EMBEDDING_* variables (no backend secrets).
# Single source shared with docker-compose; this service has no .env of its own.
if [ -f "../.env" ]; then
  export $(grep -E '^EMBEDDING_' ../.env | xargs)
fi

echo "Starting embedding service on http://localhost:8000"
echo "Model:  ${EMBEDDING_MODEL:-mixedbread-ai/mxbai-embed-large-v1}"
echo "Device: ${EMBEDDING_DEVICE:-cpu}"

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
