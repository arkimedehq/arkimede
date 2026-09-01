# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

"""
Piper Service — self-hosted, OpenAI-compatible text-to-speech.

Exposes `POST /v1/audio/speech` with the same contract as the OpenAI API
(`model`, `voice`, `input`, `response_format`) so the backend can use it via
the "internal" provider without dedicated code. Engine: Piper (ONNX) —
lightweight and fast on CPU.

Voices are `<id>.onnx` + `<id>.onnx.json` pairs stored in PIPER_MODELS_DIR.
The default voice is pre-downloaded into the Docker image (see Dockerfile);
other voices are fetched on demand from the official HuggingFace repository
(rhasspy/piper-voices) unless PIPER_OFFLINE=1.
"""
import io
import logging
import os
import re
import threading
import time
import urllib.request
import wave
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from piper import PiperVoice
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODELS_DIR    = Path(os.getenv("PIPER_MODELS_DIR", "/models"))
DEFAULT_VOICE = os.getenv("PIPER_VOICE", "it_IT-paola-medium")
OFFLINE       = os.getenv("PIPER_OFFLINE", "0") == "1"

# HuggingFace layout: <lang>/<lang_REGION>/<name>/<quality>/<voice-id>.onnx[.json]
HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
# Voice ids like `it_IT-paola-medium`: validated before touching the FS/network.
VOICE_ID_RE = re.compile(r"^([a-z]{2,3})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$")

ready = False
_load_lock = threading.Lock()


def ensure_voice(voice_id: str) -> Path:
    """Returns the local .onnx path for a voice, downloading it if missing."""
    m = VOICE_ID_RE.match(voice_id)
    if not m:
        raise HTTPException(status_code=400, detail=f"Invalid voice id: {voice_id!r}")

    onnx = MODELS_DIR / f"{voice_id}.onnx"
    if onnx.exists() and (MODELS_DIR / f"{voice_id}.onnx.json").exists():
        return onnx
    if OFFLINE:
        logger.warning(f"Voice {voice_id} not available and PIPER_OFFLINE=1")
        raise HTTPException(status_code=404, detail=f"Voice not available: {voice_id}")

    lang, region, name, quality = m.groups()
    base = f"{HF_BASE}/{lang}/{lang}_{region}/{name}/{quality}/{voice_id}"
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        for suffix in (".onnx", ".onnx.json"):
            target = MODELS_DIR / f"{voice_id}{suffix}"
            tmp = target.with_suffix(target.suffix + ".part")
            logger.info(f"Downloading {voice_id}{suffix} …")
            urllib.request.urlretrieve(f"{base}{suffix}?download=true", tmp)
            tmp.rename(target)
    except Exception as err:
        # Clean partial files so the next attempt starts fresh.
        for suffix in (".onnx", ".onnx.json"):
            (MODELS_DIR / f"{voice_id}{suffix}.part").unlink(missing_ok=True)
        logger.error(f"Download failed for voice {voice_id}: {err}")
        raise HTTPException(status_code=404, detail=f"Voice not available: {voice_id}")
    return onnx


@lru_cache(maxsize=int(os.getenv("PIPER_MAX_VOICES", "4")))
def load_voice(voice_id: str) -> PiperVoice:
    """Loads a voice once and keeps it in an LRU cache of ready models."""
    onnx = ensure_voice(voice_id)
    logger.info(f"Loading Piper voice: {voice_id}")
    return PiperVoice.load(str(onnx))


def synthesize_wav(voice: PiperVoice, text: str) -> bytes:
    """Synthesizes `text` to an in-memory WAV (piper-tts ≥1.3 / ≤1.2 APIs)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        if hasattr(voice, "synthesize_wav"):
            voice.synthesize_wav(text, wav_file)
        else:  # piper-tts ≤1.2 sets the wav params itself
            voice.synthesize(text, wav_file)
    return buf.getvalue()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ready
    with _load_lock:
        load_voice(DEFAULT_VOICE)
    ready = True
    logger.info(f"Piper default voice ready: {DEFAULT_VOICE}")
    yield
    ready = False


app = FastAPI(title="Piper Service", lifespan=lifespan)


class SpeechRequest(BaseModel):
    model: str | None = None          # accepted for OpenAI compatibility, unused
    voice: str | None = None          # falsy → PIPER_VOICE default
    input: str
    response_format: str = "wav"


# Sync endpoint on purpose: synthesis is CPU-bound, FastAPI runs it in the
# threadpool instead of blocking the event loop.
@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="Empty input")
    if req.response_format != "wav":
        # mp3 would need ffmpeg — out of scope for v1.
        raise HTTPException(status_code=400, detail=f"Unsupported response_format: {req.response_format!r} (only 'wav')")

    voice_id = req.voice or DEFAULT_VOICE
    t0 = time.perf_counter()
    with _load_lock:
        voice = load_voice(voice_id)
    audio = synthesize_wav(voice, req.input)
    elapsed = (time.perf_counter() - t0) * 1000
    logger.info(f"speech → {len(audio)} bytes in {elapsed:.0f}ms (voice={voice_id}, input={len(req.input)} char)")
    return Response(content=audio, media_type="audio/wav")


@app.get("/v1/models")
def list_models():
    voices = sorted(p.stem for p in MODELS_DIR.glob("*.onnx")) if MODELS_DIR.is_dir() else []
    return {"object": "list", "data": [{"id": v, "object": "model"} for v in voices]}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "voice":  DEFAULT_VOICE,
        "ready":  ready,
    }
