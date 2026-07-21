"""
Whisper Service — self-hosted, OpenAI-compatible speech transcription.

Exposes `POST /v1/audio/transcriptions` with the same contract as the OpenAI API
(`file`, `model`, `language`, `response_format`) so the backend can use it via
the "internal" provider without dedicated code. Engine: faster-whisper
(CTranslate2) — lightweight and fast on CPU with int8 quantization.

The model is pre-downloaded into the Docker image (see Dockerfile) to avoid
the download on first startup.
"""
import io
import os
import time
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_NAME   = os.getenv("WHISPER_MODEL", "small")
DEVICE       = os.getenv("WHISPER_DEVICE", "cpu")
# int8 on CPU = great speed/RAM tradeoff; float16 recommended on GPU.
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8" if DEVICE == "cpu" else "float16")

model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    logger.info(f"Loading Whisper model: {MODEL_NAME} on {DEVICE} ({COMPUTE_TYPE})")
    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    logger.info("Whisper model ready")
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

    t0 = time.perf_counter()
    # faster-whisper accepts a file-like object; av/ffmpeg decodes the container (webm/ogg/wav/mp3).
    segments, info = model.transcribe(
        io.BytesIO(data),
        language=language or None,
        vad_filter=True,   # filter out silence → fewer hallucinations on mute stretches
    )
    text = "".join(seg.text for seg in segments).strip()
    elapsed = (time.perf_counter() - t0) * 1000
    logger.info(
        f"transcribe → {len(text)} char in {elapsed:.0f}ms "
        f"(lang={info.language}, p={info.language_probability:.2f})"
    )

    if response_format == "text":
        return text
    return {"text": text}


@app.get("/v1/models")
def list_models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model":  MODEL_NAME,
        "device": DEVICE,
        "ready":  model is not None,
    }
