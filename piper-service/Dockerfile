# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Pre-download the default voice into the image (avoids a download on first
# startup; /models is seeded into the named volume on its first mount).
ARG PIPER_VOICE=it_IT-paola-medium
RUN python -c "from main import ensure_voice; ensure_voice('${PIPER_VOICE}')"

ENV PIPER_VOICE=${PIPER_VOICE}
ENV PIPER_MODELS_DIR=/models

EXPOSE 9100

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9100"]
