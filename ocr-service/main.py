# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

"""
OCR Service — self-hosted document text extraction with selectable engines.

Engines (the backend maps its OCR "levels" onto them):
  fast        PyMuPDF + Tesseract. Keeps the native text layer of each page and
              OCRs only the image areas (mixed PDFs), or the whole page when the
              native text is missing or unreadable (scans, broken font encodings).
  structured  Docling: layout analysis + table structure + RapidOCR on bitmap
              areas, exported as markdown (headings/tables preserved). Optional:
              only present when the image is built with OCR_STRUCTURED=1.

Endpoints:
  GET  /health       → which engines are available
  POST /v1/extract   → text of a PDF/image with the chosen engine
  POST /v1/render    → per-page native text + PNG rendering (for the backend's
                       vision-LLM level, which transcribes each page image)

Both PDFs and images (png/jpeg/webp/tiff/bmp/gif) are accepted. CPU-bound work
runs in FastAPI's threadpool, bounded by OCR_CONCURRENCY.
"""
import base64
import io
import logging
import os
import re
import threading
import time
from functools import lru_cache

import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

LANGUAGES     = os.getenv("OCR_LANGUAGES", "ita+eng")      # Tesseract syntax
OCR_DPI       = int(os.getenv("OCR_DPI", "300"))
MAX_PAGES     = int(os.getenv("OCR_MAX_PAGES", "500"))     # hard cap per request
RENDER_DPI    = int(os.getenv("OCR_RENDER_DPI", "150"))
ARTIFACTS     = os.getenv("DOCLING_ARTIFACTS_PATH") or None
# A page whose native text is shorter than this (non-space chars) is treated as
# a scan and OCRed in full.
MIN_NATIVE_CHARS = int(os.getenv("OCR_MIN_NATIVE_CHARS", "20"))

_slots = threading.BoundedSemaphore(int(os.getenv("OCR_CONCURRENCY", "1")))

IMAGE_TYPES = {"png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"}


def _structured_available() -> bool:
    try:
        import docling  # noqa: F401
        return True
    except ImportError:
        return False


STRUCTURED = _structured_available()

app = FastAPI(title="OCR Service")


# ── helpers ─────────────────────────────────────────────────────────────────

def _kind(filename: str, content_type: str | None) -> str:
    """'pdf' or an image filetype understood by PyMuPDF; 400 otherwise."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    ct = (content_type or "").lower()
    if ext == "pdf" or ct == "application/pdf":
        return "pdf"
    if ext in IMAGE_TYPES:
        return "jpeg" if ext == "jpg" else ext
    if ct.startswith("image/"):
        sub = ct.split("/", 1)[1]
        return "jpeg" if sub == "jpg" else sub
    raise HTTPException(status_code=400, detail=f"Unsupported file type: {filename} ({content_type})")


def _open(data: bytes, kind: str) -> pymupdf.Document:
    """Opens a PDF, or converts an image into a one-page PDF."""
    try:
        if kind == "pdf":
            return pymupdf.open(stream=data, filetype="pdf")
        img = pymupdf.open(stream=data, filetype=kind)
        return pymupdf.open("pdf", img.convert_to_pdf())
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"Cannot open document: {err}")


def _native_is_usable(text: str) -> bool:
    """False for missing text or text from fonts without a unicode mapping."""
    chars = [c for c in text if not c.isspace()]
    if len(chars) < MIN_NATIVE_CHARS:
        return False
    bad = sum(1 for c in chars if c == "�" or (ord(c) < 32))
    return bad / len(chars) < 0.1


def _tidy(text: str) -> str:
    """Trims trailing spaces and collapses runs of blank lines (OCR layout noise)."""
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _page_limit(doc: pymupdf.Document, max_pages: int | None) -> int:
    cap = MAX_PAGES if not max_pages or max_pages <= 0 else min(max_pages, MAX_PAGES)
    return min(doc.page_count, cap)


# ── fast engine: PyMuPDF + Tesseract ────────────────────────────────────────

def extract_fast(data: bytes, kind: str, languages: str, max_pages: int | None) -> dict:
    doc = _open(data, kind)
    n = _page_limit(doc, max_pages)
    pages: list[str] = []
    ocr_pages = 0
    for i in range(n):
        page = doc[i]
        native = page.get_text(sort=True)
        full = not _native_is_usable(native)
        has_images = bool(page.get_images(full=False))
        if not full and not has_images:
            pages.append(_tidy(native))
            continue
        # full=False: keeps the native text and OCRs only the image areas.
        tp = page.get_textpage_ocr(language=languages, dpi=OCR_DPI, full=full)
        pages.append(_tidy(page.get_text(textpage=tp, sort=True)))
        ocr_pages += 1
    text = "\n\n".join(f"--- Page {i + 1} ---\n{t}" if n > 1 else t for i, t in enumerate(pages) if t)
    return {"text": text, "pages": n, "totalPages": doc.page_count, "ocrPages": ocr_pages}


# ── structured engine: Docling ──────────────────────────────────────────────

@lru_cache(maxsize=1)
def _docling_converter():
    """Docling converter, built once (loads the layout/table/OCR models)."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    opts = PdfPipelineOptions(artifacts_path=ARTIFACTS)
    opts.do_ocr = True
    opts.do_table_structure = True
    # RapidOCR (PaddleOCR models): reads scanned tables where Tesseract loses cells.
    opts.ocr_options = RapidOcrOptions()
    return DocumentConverter(format_options={
        InputFormat.PDF:   PdfFormatOption(pipeline_options=opts),
        InputFormat.IMAGE: ImageFormatOption(pipeline_options=opts),
    })


def extract_structured(data: bytes, kind: str, filename: str, max_pages: int | None) -> dict:
    if not STRUCTURED:
        raise HTTPException(status_code=501, detail="Structured engine not installed (build with OCR_STRUCTURED=1)")
    from docling.datamodel.base_models import DocumentStream

    total = _open(data, kind).page_count
    cap = MAX_PAGES if not max_pages or max_pages <= 0 else min(max_pages, MAX_PAGES)
    name = filename if "." in filename else f"{filename}.{kind}"
    # page_range truncates long documents (max_num_pages would reject them).
    result = _docling_converter().convert(
        DocumentStream(name=name, stream=io.BytesIO(data)),
        page_range=(1, min(total, cap)),
    )
    text = result.document.export_to_markdown()
    return {"text": text, "pages": min(total, cap), "totalPages": total, "ocrPages": None}


# ── endpoints ───────────────────────────────────────────────────────────────

@app.post("/v1/extract")
def extract(
    file: UploadFile = File(...),
    engine: str = Form("fast"),
    languages: str | None = Form(None),
    max_pages: int | None = Form(None),
):
    if engine not in ("fast", "structured"):
        raise HTTPException(status_code=400, detail=f"Unknown engine: {engine!r}")
    data = file.file.read()
    name = file.filename or "document"
    kind = _kind(name, file.content_type)
    langs = languages or LANGUAGES
    t0 = time.perf_counter()
    with _slots:
        if engine == "structured":
            out = extract_structured(data, kind, name, max_pages)
        else:
            out = extract_fast(data, kind, langs, max_pages)
    ms = (time.perf_counter() - t0) * 1000
    logger.info(f"extract[{engine}] {name}: {out['pages']}/{out['totalPages']} pages, "
                f"{len(out['text'])} chars in {ms:.0f}ms")
    return {"engine": engine, **out}


@app.post("/v1/render")
def render(
    file: UploadFile = File(...),
    dpi: int | None = Form(None),
    first_page: int = Form(1),
    max_pages: int | None = Form(None),
):
    """Renders pages [first_page, first_page + max_pages) (1-based): callers batch."""
    data = file.file.read()
    name = file.filename or "document"
    doc = _open(data, _kind(name, file.content_type))
    start = max(first_page, 1) - 1
    if start >= min(doc.page_count, MAX_PAGES):
        return {"pages": [], "totalPages": doc.page_count}
    count = min(max_pages or doc.page_count, MAX_PAGES - start)
    end = min(doc.page_count, start + count)
    zoom = (dpi or RENDER_DPI) / 72
    pages = []
    with _slots:
        for i in range(start, end):
            page = doc[i]
            png = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).tobytes("png")
            pages.append({
                "index": i + 1,
                "text": page.get_text(sort=True).strip(),
                "hasImages": bool(page.get_images(full=False)),
                "png": base64.b64encode(png).decode("ascii"),
            })
    logger.info(f"render {name}: pages {start + 1}-{end} of {doc.page_count}")
    return {"pages": pages, "totalPages": doc.page_count}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "engines": {"fast": True, "structured": STRUCTURED},
        "languages": LANGUAGES,
    }
