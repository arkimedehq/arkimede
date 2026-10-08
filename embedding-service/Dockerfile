# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

FROM python:3.12-slim

WORKDIR /app

# System dependencies for torch
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# The image must match the device the service will run on (EMBEDDING_DEVICE, chosen by
# install.sh). On `cpu` — the default, and the only option without an NVIDIA GPU — torch
# comes from the CPU-only index: the plain PyPI wheel drags in the whole CUDA stack
# (cuBLAS, cuDNN, NCCL…, > 2 GB, on x86_64 AND aarch64) that would never be used, tripling
# the image. Installing torch up front satisfies the requirement, so the pip below reuses it.
# On `cuda` we deliberately fall through to PyPI, which ships the CUDA-enabled wheel.
ARG EMBEDDING_DEVICE=cpu
RUN if [ "$EMBEDDING_DEVICE" = "cpu" ]; then \
      pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch>=2.5,<3"; \
    fi \
    && pip install --no-cache-dir -r requirements.txt

# Pre-download the model into the image (avoids a download on first startup).
# Default BAAI/bge-m3 (~2.3 GB of weights → the image grows accordingly); an existing
# install keeps the model its .env names (EMBEDDING_MODEL). Changing the model of an
# install that already has vectors needs the admin re-embed job.
ARG MODEL_NAME=BAAI/bge-m3
# Large single-file downloads (bge-m3 ships one 2.27 GB pytorch_model.bin) fail on the
# hub's default 10 s read timeout over slow links: raise the timeouts and retry the step.
# Only the files the model needs are fetched (not the repo's onnx/ copy).
ENV HF_HUB_DOWNLOAD_TIMEOUT=120 HF_HUB_ETAG_TIMEOUT=60
RUN for attempt in 1 2 3; do \
      python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${MODEL_NAME}')" && exit 0; \
      echo "model download failed (attempt $attempt), retrying in 15 s"; sleep 15; \
    done; exit 1

COPY main.py .

ENV EMBEDDING_MODEL=${MODEL_NAME}
ENV EMBEDDING_DEVICE=${EMBEDDING_DEVICE}

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
