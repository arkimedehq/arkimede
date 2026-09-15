# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

"""
Whisper Service — self-hosted, OpenAI-compatible speech transcription.

Exposes `POST /v1/audio/transcriptions` with the same contract as the OpenAI API
(`file`, `model`, `language`, `response_format`) so the backend can use it via
the "internal" provider without dedicated code. Engine: faster-whisper
(CTranslate2) — lightweight and fast on CPU with int8 quantization.

The default model (WHISPER_MODEL) is pre-downloaded into the image's model cache
(see Dockerfile) to avoid the download on first startup; the cache directory is
a named volume, so models fetched on demand survive rebuilds.

Runtime model switch (mirrors piper-service voices): a request may name any
model of ALLOWED_MODELS in its `model` field; if it differs from the loaded
one, the service swaps it under a lock (download on first use). A single model
is kept in memory to bound RAM — the admin picks the size that fits the host.
"""
import io
import os
import time
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_NAME   = os.getenv("WHISPER_MODEL", "small")
DEVICE       = os.getenv("WHISPER_DEVICE", "cpu")
# int8 on CPU = great speed/RAM tradeoff; float16 recommended on GPU.
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8" if DEVICE == "cpu" else "float16")
# Model cache (HF hub layout). Bind it to a named volume so on-demand downloads persist.
MODELS_DIR   = Path(os.getenv("WHISPER_MODELS_DIR", "/models"))

# Models an admin may switch to at runtime, smallest → largest (multilingual only:
# the `.en` variants would break the language hint). RAM (int8, CPU) ≈ 0.3 / 0.5 /
# 1 / 2.5 / 4 / 2.5 GB.
ALLOWED_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]
if MODEL_NAME not in ALLOWED_MODELS:
    ALLOWED_MODELS.insert(0, MODEL_NAME)   # custom default from the deployment stays usable

model: WhisperModel | None = None
current_model: str = MODEL_NAME
_swap_lock = threading.Lock()


def load_model(name: str) -> WhisperModel:
    logger.info(f"Loading Whisper model: {name} on {DEVICE} ({COMPUTE_TYPE})")
    t0 = time.perf_counter()
    m = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE, download_root=str(MODELS_DIR))
    logger.info(f"Whisper model {name} ready in {(time.perf_counter() - t0) * 1000:.0f}ms")
    return m


def is_downloaded(name: str) -> bool:
    """True if the model snapshot is already in the cache (HF hub layout, Systran repos)."""
    return any(MODELS_DIR.glob(f"models--Systran--faster-whisper-{name}/snapshots/*/model.bin"))


def ensure_model(name: str) -> WhisperModel:
    """Returns the loaded model, swapping to `name` first if it differs (one model in RAM)."""
    global model, current_model
    if model is not None and name == current_model:
        return model
    with _swap_lock:
        if model is not None and name == current_model:
            return model
        new = load_model(name)          # download on first use; the old one keeps serving meanwhile
        old, model, current_model = model, new, name
        del old
        return model


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model = load_model(MODEL_NAME)
    yield
    model = None


app = FastAPI(title="Whisper Service", lifespan=lifespan)


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str | None = Form(default=None, alias="model"),
    language: str | None = Form(default=None),
    response_format: str = Form(default="json"),
):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio")

    # `model` = requested size; empty/"whisper-1" (OpenAI default id) → the loaded one.
    requested = (model_name or "").strip()
    if requested and requested != "whisper-1" and requested not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model {requested!r} (allowed: {', '.join(ALLOWED_MODELS)})")
    active = ensure_model(requested) if requested and requested != "whisper-1" else model

    t0 = time.perf_counter()
    # faster-whisper accepts a file-like object; av/ffmpeg decodes the container (webm/ogg/wav/mp3).
    segments, info = active.transcribe(
        io.BytesIO(data),
        language=language or None,
        vad_filter=True,   # filter out silence → fewer hallucinations on mute stretches
    )
    text = "".join(seg.text for seg in segments).strip()
    elapsed = (time.perf_counter() - t0) * 1000
    logger.info(
        f"transcribe → {len(text)} char in {elapsed:.0f}ms "
        f"(model={current_model}, lang={info.language}, p={info.language_probability:.2f})"
    )

    if response_format == "text":
        return text
    return {"text": text}


@app.get("/v1/models")
def list_models():
    """Current model first (the backend probes data[0]), then the other switchable sizes."""
    ordered = [current_model] + [m for m in ALLOWED_MODELS if m != current_model]
    return {"object": "list", "data": [
        {"id": m, "object": "model", "current": m == current_model, "downloaded": m == current_model or is_downloaded(m)}
        for m in ordered
    ]}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model":  current_model,
        "device": DEVICE,
        "ready":  model is not None,
    }
