import os
import time
import logging
from contextlib import asynccontextmanager
from typing import Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "mixedbread-ai/mxbai-embed-large-v1")
DEVICE     = os.getenv("EMBEDDING_DEVICE", "cpu")
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))

model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    logger.info(f"Loading embedding model: {MODEL_NAME} on {DEVICE}")
    model = SentenceTransformer(MODEL_NAME, device=DEVICE, truncate_dim=None)
    logger.info(f"Model ready — native dim: {model.get_embedding_dimension()}")
    yield
    model = None


app = FastAPI(title="Embedding Service", lifespan=lifespan)


# ── Pydantic models ───────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    input:      Union[str, list[str]]
    model:      str       = MODEL_NAME
    dimensions: int | None = None
    # Extension to the OpenAI schema (ignored by other providers): retrieval models are
    # asymmetric — the query is embedded with an instruction, the indexed document without.
    # The instruction is NOT hardcoded here: it is the one the model itself declares
    # (config_sentence_transformers.json → prompts), so any model that ships one gets it
    # right and any model that doesn't is left untouched. The caller marks the side; the
    # default is 'document', i.e. no prompt, which is also the pre-existing behaviour.
    input_type: str | None = None    # "query" | "document"


class EmbeddingObject(BaseModel):
    object:    str = "embedding"
    index:     int
    embedding: list[float]


class EmbedUsage(BaseModel):
    prompt_tokens: int
    total_tokens:  int


class EmbedResponse(BaseModel):
    object: str = "list"
    data:   list[EmbeddingObject]
    model:  str
    usage:  EmbedUsage


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/v1/embeddings", response_model=EmbedResponse)
async def create_embeddings(req: EmbedRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    texts = [req.input] if isinstance(req.input, str) else req.input
    if not texts:
        raise HTTPException(status_code=400, detail="Empty input")

    # Prompt of the requested side, only if the loaded model declares one (empty otherwise).
    prompt_name = req.input_type if req.input_type in (model.prompts or {}) else None
    prompt = (model.prompts or {}).get(prompt_name or "", "")

    t0 = time.perf_counter()
    side = f" [{req.input_type}{' + prompt' if prompt else ''}]" if req.input_type else ""
    if len(texts) == 1:
        preview = texts[0][:80].replace("\n", " ")
        logger.info(f"embed{side}: \"{preview}{'…' if len(texts[0]) > 80 else ''}\"")
    else:
        logger.info(f"embed batch{side}: {len(texts)} texts")

    embeddings = model.encode(
        texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
        **({"prompt_name": prompt_name} if prompt else {}),
    )

    if req.dimensions and req.dimensions < embeddings.shape[1]:
        embeddings = embeddings[:, : req.dimensions]

    elapsed = (time.perf_counter() - t0) * 1000
    logger.info(f"embed → {embeddings.shape[1]} dims in {elapsed:.0f}ms")

    total_tokens = sum(len(t) // 4 for t in texts)
    return EmbedResponse(
        model=MODEL_NAME,
        data=[EmbeddingObject(index=i, embedding=vec.tolist()) for i, vec in enumerate(embeddings)],
        usage=EmbedUsage(prompt_tokens=total_tokens, total_tokens=total_tokens),
    )


@app.get("/v1/models")
def list_models():
    dims = model.get_sentence_embedding_dimension() if model else 0
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "dims": dims}]}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model":  MODEL_NAME,
        "device": DEVICE,
        "ready":  model is not None,
    }
