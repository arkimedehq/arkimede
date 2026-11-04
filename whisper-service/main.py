# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

"""
Whisper Service — self-hosted, OpenAI-compatible speech transcription.

Exposes `POST /v1/audio/transcriptions` with the same contract as the OpenAI API
(`file`, `model`, `language`, `prompt`, `response_format`) so the backend can use it via
the "internal" provider without dedicated code.

Two engines, one loaded at a time (same API for both, so the backend, Wyoming,
Home Assistant and voice satellites see no difference). STT_ENGINE picks the one
loaded at start; a request naming a model of the other engine switches to it:

- `whisper` (default): faster-whisper (CTranslate2), int8 on CPU. Pays a fixed
  30 s window per request, so even a short phrase takes ~2 s on a small CPU.
- `parakeet`: NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX) via sherpa-onnx. Time
  proportional to the audio (a short command in a few hundred ms), 25 European
  languages detected automatically (the request's `language` and `prompt` are ignored).

Whisper: the default model (WHISPER_MODEL) is pre-downloaded into the image's
model cache (see Dockerfile); the cache directory is a named volume, so models
fetched on demand survive rebuilds. Runtime model switch (mirrors piper-service
voices): a request may name any model of ALLOWED_MODELS in its `model` field; if
it differs from the loaded one, the service swaps it under a lock (download on
first use). A single model is kept in memory to bound RAM.

Parakeet: the model is downloaded on first use into the same volume
(`<models>/parakeet/<PARAKEET_MODEL>/`), unless PARAKEET_OFFLINE=1.

Engine switch: the `model` field names a Whisper size or PARAKEET_MODEL (the
admin's pick in Settings → Voice & audio, sent by the backend); empty or
"whisper-1" keeps the loaded one. Switching engine frees the loaded model first,
so two models never share the container's memory.
"""
import gc
import io
import os
import re
import time
import shutil
import logging
import tarfile
import threading
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ENGINE       = (os.getenv("STT_ENGINE", "whisper").strip().lower() or "whisper")
if ENGINE not in ("whisper", "parakeet"):
    raise SystemExit(f"STT_ENGINE must be 'whisper' or 'parakeet', not {ENGINE!r}")

MODEL_NAME   = os.getenv("WHISPER_MODEL", "small")
DEVICE       = os.getenv("WHISPER_DEVICE", "cpu")
# int8 on CPU = great speed/RAM tradeoff; float16 recommended on GPU.
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8" if DEVICE == "cpu" else "float16")
# Model cache (HF hub layout). Bind it to a named volume so on-demand downloads persist.
MODELS_DIR   = Path(os.getenv("WHISPER_MODELS_DIR", "/models"))
# Decoding speed: greedy search (beam 1) gives the same text as beam 5 on short voice turns and is faster;
# CPU threads 0 = CTranslate2's default (4): set the host's core count to use all of it.
BEAM_SIZE    = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
CPU_THREADS  = int(os.getenv("WHISPER_CPU_THREADS", "0"))

# Parakeet (sherpa-onnx): model id = the release archive name, also reported by /v1/models.
PARAKEET_MODEL   = os.getenv("PARAKEET_MODEL", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8").strip()
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", PARAKEET_MODEL):
    raise SystemExit(f"PARAKEET_MODEL is not a valid model name: {PARAKEET_MODEL!r}")
PARAKEET_URL     = os.getenv(
    "PARAKEET_MODEL_URL",
    f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{PARAKEET_MODEL}.tar.bz2",
)
# Threads: PARAKEET_THREADS, else WHISPER_CPU_THREADS, else 4.
PARAKEET_THREADS = int(os.getenv("PARAKEET_THREADS", "0")) or CPU_THREADS or 4
PARAKEET_OFFLINE = os.getenv("PARAKEET_OFFLINE", "0") == "1"
PARAKEET_DIR     = MODELS_DIR / "parakeet" / PARAKEET_MODEL
SAMPLE_RATE      = 16_000

# Models an admin may switch to at runtime, smallest → largest (multilingual only:
# the `.en` variants would break the language hint). RAM (int8, CPU) ≈ 0.3 / 0.5 /
# 1 / 2.5 / 4 / 2.5 GB.
ALLOWED_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]
if MODEL_NAME not in ALLOWED_MODELS:
    ALLOWED_MODELS.insert(0, MODEL_NAME)   # custom default from the deployment stays usable

engine: str = ENGINE                    # engine currently loaded: "whisper" | "parakeet"
model: WhisperModel | None = None
current_model: str = MODEL_NAME if ENGINE == "whisper" else PARAKEET_MODEL
_swap_lock = threading.Lock()
parakeet = None                        # sherpa_onnx.OfflineRecognizer when engine == "parakeet"


# ── Whisper ───────────────────────────────────────────────────────────────────

def load_model(name: str) -> WhisperModel:
    logger.info(f"Loading Whisper model: {name} on {DEVICE} ({COMPUTE_TYPE}, {CPU_THREADS or 'default'} threads, beam {BEAM_SIZE})")
    t0 = time.perf_counter()
    m = WhisperModel(name, device=DEVICE, compute_type=COMPUTE_TYPE, cpu_threads=CPU_THREADS,
                     download_root=str(MODELS_DIR))
    logger.info(f"Whisper model {name} ready in {(time.perf_counter() - t0) * 1000:.0f}ms")
    return m


def is_downloaded(name: str) -> bool:
    """True if the model snapshot is already in the cache (HF hub layout, Systran repos)."""
    return any(MODELS_DIR.glob(f"models--Systran--faster-whisper-{name}/snapshots/*/model.bin"))


def resolve_model(requested: str) -> tuple[str, str]:
    """(engine, model) a request asks for; empty or "whisper-1" (OpenAI default id) → the loaded one."""
    if not requested or requested == "whisper-1":
        return engine, current_model
    if requested == PARAKEET_MODEL:
        return "parakeet", PARAKEET_MODEL
    if requested in ALLOWED_MODELS:
        return "whisper", requested
    raise HTTPException(status_code=400, detail=f"Unknown model {requested!r} (allowed: {', '.join(ALLOWED_MODELS + [PARAKEET_MODEL])})")


def _load(target: str, name: str):
    return load_parakeet() if target == "parakeet" else load_model(name)


def ensure_model(target: str, name: str) -> None:
    """Loads `name` of engine `target` if it is not the loaded one (one model in RAM).
    Between Whisper sizes the old model keeps serving while the new one loads; across
    engines the old one is freed first, and reloaded if the new one fails."""
    global model, parakeet, engine, current_model
    if target == engine and name == current_model and is_ready():
        return
    with _swap_lock:
        if target == engine and name == current_model and is_ready():
            return
        if target == "parakeet" and PARAKEET_OFFLINE and not parakeet_downloaded():
            raise HTTPException(status_code=503, detail=f"{PARAKEET_MODEL} is not downloaded and PARAKEET_OFFLINE=1")
        prev = (engine, current_model)
        if target != engine:
            logger.info(f"Switching engine {engine} ({current_model}) → {target} ({name})")
            model = parakeet = None
            gc.collect()
        try:
            loaded = _load(target, name)    # download on first use
        except Exception as exc:
            logger.error(f"Loading {name} failed: {exc}")
            if prev[0] != target:           # the previous engine was freed: bring it back
                restored = _load(*prev)
                model, parakeet = (restored, None) if prev[0] == "whisper" else (None, restored)
            raise HTTPException(status_code=503, detail=f"Could not load {name}: {exc}")
        if target == "parakeet":
            model, parakeet = None, loaded
        else:
            old, model = model, loaded
            del old
        engine, current_model = target, name


# ── Parakeet ──────────────────────────────────────────────────────────────────

def parakeet_downloaded() -> bool:
    return (PARAKEET_DIR / "tokens.txt").is_file()


def download_parakeet() -> None:
    """Fetches and unpacks the sherpa-onnx release archive into PARAKEET_DIR (atomically)."""
    if parakeet_downloaded():
        return
    if PARAKEET_OFFLINE:
        raise RuntimeError(f"Parakeet model {PARAKEET_MODEL} not in {PARAKEET_DIR} and PARAKEET_OFFLINE=1")
    root = PARAKEET_DIR.parent
    root.mkdir(parents=True, exist_ok=True)
    archive = root / f".{PARAKEET_MODEL}.tar.bz2.part"
    staging = root / f".{PARAKEET_MODEL}.extract"
    logger.info(f"Downloading Parakeet model {PARAKEET_MODEL} from {PARAKEET_URL}")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(PARAKEET_URL, timeout=60) as res, open(archive, "wb") as out:
            total = int(res.headers.get("Content-Length") or 0)
            done, next_log = 0, 0.1
            while chunk := res.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                if total and done / total >= next_log:
                    logger.info(f"  … {done * 100 // total}% of {total // (1 << 20)} MB")
                    next_log += 0.1
        shutil.rmtree(staging, ignore_errors=True)
        with tarfile.open(archive, "r:bz2") as tar:
            tar.extractall(staging, filter="data")
        # The archive holds one top-level folder named like the model.
        unpacked = next((p for p in staging.iterdir() if (p / "tokens.txt").is_file()), None)
        if unpacked is None:
            raise RuntimeError(f"{PARAKEET_URL}: no tokens.txt in the archive")
        os.replace(unpacked, PARAKEET_DIR)
    finally:
        archive.unlink(missing_ok=True)
        shutil.rmtree(staging, ignore_errors=True)
    logger.info(f"Parakeet model {PARAKEET_MODEL} downloaded in {time.perf_counter() - t0:.0f}s")


def _model_file(prefix: str) -> str:
    """encoder/decoder/joiner file of the model folder (the int8 one when both exist)."""
    found = sorted(PARAKEET_DIR.glob(f"{prefix}*.onnx"), key=lambda p: ("int8" not in p.name, p.name))
    if not found:
        raise RuntimeError(f"{PARAKEET_DIR}: no {prefix}*.onnx")
    return str(found[0])


def load_parakeet():
    import sherpa_onnx

    download_parakeet()
    logger.info(f"Loading Parakeet model: {PARAKEET_MODEL} ({PARAKEET_THREADS} threads)")
    t0 = time.perf_counter()
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=_model_file("encoder"),
        decoder=_model_file("decoder"),
        joiner=_model_file("joiner"),
        tokens=str(PARAKEET_DIR / "tokens.txt"),
        num_threads=PARAKEET_THREADS,
        sample_rate=SAMPLE_RATE,
        model_type="nemo_transducer",
        decoding_method="greedy_search",
    )
    logger.info(f"Parakeet model {PARAKEET_MODEL} ready in {(time.perf_counter() - t0) * 1000:.0f}ms")
    return rec


def parakeet_transcribe(data: bytes) -> tuple[str, float]:
    """Text and audio duration (s). Same decoding as Whisper: av/ffmpeg → 16 kHz mono float32."""
    samples = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    if samples.size == 0:
        return "", 0.0
    stream = parakeet.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    parakeet.decode_stream(stream)
    return stream.result.text.strip(), samples.size / SAMPLE_RATE


# ── App ───────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, parakeet
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if ENGINE == "parakeet":
        parakeet = load_parakeet()
    else:
        model = load_model(MODEL_NAME)
    yield
    model = None
    parakeet = None


app = FastAPI(title="Whisper Service", lifespan=lifespan)


def is_ready() -> bool:
    return (parakeet if engine == "parakeet" else model) is not None


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_name: str | None = Form(default=None, alias="model"),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
    response_format: str = Form(default="json"),
):
    if not is_ready():
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio")

    ensure_model(*resolve_model((model_name or "").strip()))

    if engine == "parakeet":
        t0 = time.perf_counter()
        text, seconds = parakeet_transcribe(data)
        elapsed = (time.perf_counter() - t0) * 1000
        logger.info(f"transcribe → {len(text)} char in {elapsed:.0f}ms (model={PARAKEET_MODEL}, lang=auto, audio={seconds:.1f}s)")
    else:
        t0 = time.perf_counter()
        # faster-whisper accepts a file-like object; av/ffmpeg decodes the container (webm/ogg/wav/mp3).
        segments, info = model.transcribe(
            io.BytesIO(data),
            language=language or None,
            # The expected words (OpenAI's `prompt`): proper names and places come out right.
            initial_prompt=(prompt or "").strip()[:1000] or None,
            beam_size=BEAM_SIZE,
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
    """Current model first (the backend probes data[0]), then the others it can switch to."""
    options = [("whisper", m) for m in ALLOWED_MODELS] + [("parakeet", PARAKEET_MODEL)]
    ordered = [(engine, current_model)] + [o for o in options if o[1] != current_model]
    return {"object": "list", "data": [
        {"id": name, "object": "model", "engine": eng, "current": name == current_model,
         "downloaded": name == current_model or (parakeet_downloaded() if eng == "parakeet" else is_downloaded(name))}
        for eng, name in ordered
    ]}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "engine": engine,
        "model":  current_model,
        "device": DEVICE if engine == "whisper" else "cpu",
        "ready":  is_ready(),
    }
