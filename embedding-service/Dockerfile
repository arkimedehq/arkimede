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

# Pre-download the model into the image (avoids a download on first startup)
ARG MODEL_NAME=mixedbread-ai/mxbai-embed-large-v1
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${MODEL_NAME}')"

COPY main.py .

ENV EMBEDDING_MODEL=${MODEL_NAME}
ENV EMBEDDING_DEVICE=${EMBEDDING_DEVICE}

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
