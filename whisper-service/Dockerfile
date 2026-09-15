# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

FROM python:3.12-slim

WORKDIR /app

# ffmpeg/libav for the audio decoding (webm/ogg/mp3/wav) used by faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the model into the image (avoids a download on first startup)
ARG WHISPER_MODEL=small
ARG WHISPER_COMPUTE_TYPE=int8
# Pre-download the default model into the cache dir. /models is a named volume in
# compose: Docker seeds an empty volume with this content, so the default model is
# available offline and models switched to at runtime persist next to it.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='${WHISPER_COMPUTE_TYPE}', download_root='/models')"

COPY main.py .

ENV WHISPER_MODEL=${WHISPER_MODEL}
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE_TYPE=${WHISPER_COMPUTE_TYPE}
ENV WHISPER_MODELS_DIR=/models

EXPOSE 9000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
