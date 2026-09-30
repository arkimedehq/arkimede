# Document OCR (RAG indexing)

Status: IMPLEMENTED (2026-09-30) — `ocr-service/`, `backend/src/ocr/`, migration 087.
Italian copy: `OCR_it.md`.

When a PDF or an image is indexed into the RAG, its text is read at an **OCR level**
chosen per document (up to an admin maximum). Every level keeps the native text of
digital PDFs; they differ in how they read scans and the text inside pictures.

| Level | Engine | Where it runs | Good at | Cost |
|---|---|---|---|---|
| `none` | `pdf-parse` (text layer only) | backend | digital PDFs | — |
| `fast` | PyMuPDF + **Tesseract** | ocr-service | scans, mixed PDFs (text + pictures with text) | ~0.2–1 s/page, CPU |
| `structured` | **Docling** (layout + TableFormer) + **RapidOCR** (PaddleOCR models, ONNX) | ocr-service | tables, headings, multi-column layouts → markdown | ~1–8 s/page, CPU, ~1.5 GB RAM |
| `vision` | page rendered by the ocr-service, transcribed by the **vision LLM** | ocr-service + LLM provider | photos, handwriting, very irregular layouts | one LLM call per page |

Mixed PDFs: the `fast` level keeps each page's native text and OCRs **only the image
areas**; a page without usable native text (scan, fonts without a unicode map) is OCRed
in full. `structured` does the same through Docling's pipeline. `vision` sends the page
image plus its native text as a spelling hint.

Measured on test fixtures (Apple Silicon, Docker CPU): a scanned table with a grid is
read perfectly by `structured` (markdown table) while Tesseract (`fast`) loses rows;
accented Italian text is read correctly by both.

## Components

- **`ocr-service/`** (FastAPI, port 9200, not host-exposed): `GET /health` (engines
  available), `POST /v1/extract` (multipart `file`, `engine=fast|structured`),
  `POST /v1/render` (per-page PNG + native text, batched with `first_page`/`max_pages`).
  All models are baked into the image at build time: it works offline.
- **`backend/src/ocr/`**: `OcrService` resolves the level (request or admin default,
  capped by the admin maximum, degraded to the nearest available level) and calls the
  service; `vision` is orchestrated here (render → one vision-model call per page, with
  per-page fallback to the native text). `GET /api/ocr/levels` (users),
  `GET|PATCH /api/admin/config/ocr` (admin).
- **`FilesService.extractText*`** takes an optional `ocrLevel`; PDFs fall back to
  `pdf-parse` when OCR is off, unavailable or failing, exactly as before the service
  existed. Images: `fast`/`structured` first, the vision model when they find no text
  (photos keep getting a searchable description), nothing for an explicit `none`.
- **Indexing is queued**: `POST /api/embed/:fileId` and `POST /api/embed/datasource`
  accept `ocrLevel` and go through the BullMQ `embed-ingest` queue; the user is notified
  when done (the file list refreshes on that notification).
- **UI**: level picker in the chat "Embed in RAG" step and in the chat file panel (only
  for PDFs/images); admin card *Settings → Vector DB → Document OCR* with the
  availability of each level and the default/maximum.

Callers that do not choose (agents' RAG-index tool, the `files` skill, inline chat
attachments) use the admin default.

## Configuration

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `OCR_STRUCTURED` | build | `1` | `1` full image (~4 GB, all levels) · `0` light image (~0.5 GB, `fast` only) |
| `OCR_TESSERACT_LANGS` | build | `eng ita` | Tesseract language packs (Debian names) |
| `OCR_LANGUAGES` | ocr | `ita+eng` | Tesseract languages at runtime |
| `OCR_CONCURRENCY` / `OCR_MAX_PAGES` | ocr | `1` / `500` | parallel jobs / hard page cap |
| `OCR_BASE_URL` | backend | `http://ocr:9200` | service URL |
| `OCR_TIMEOUT_MS` | backend | `1800000` | per-request timeout |
| `OCR_VISION_MAX_PAGES` / `OCR_VISION_CONCURRENCY` | backend | `100` / `2` | `vision` page cap / parallel LLM calls |

Admin settings (`app_config.ocrDefaultLevel`, `ocrMaxLevel`): default `fast`, max `vision`.

The installer asks whether to build the full or the light image. Without the `ocr`
container at all, every level degrades to `none` and images to the vision model — the
pre-OCR behavior.

## Licenses

Tesseract, RapidOCR/PaddleOCR models, Docling layout model: Apache-2.0; Docling: MIT;
TableFormer: CDLA-Permissive-2.0/Apache-2.0; **PyMuPDF: AGPL-3.0** (used under AGPL,
like Arkimede). Marker/Surya were excluded (GPL code, weights with commercial limits).
Details in `THIRD_PARTY_NOTICES.md`.

## Known limits

- `fast` on bordered scanned tables loses cells: use `structured`.
- `vision` availability means "a vision/default model is configured": whether it accepts
  images is only known at call time; a model that rejects images makes each page fall
  back to its native text (logged as a warning).
- Very long documents are truncated at `OCR_MAX_PAGES` (`OCR_VISION_MAX_PAGES` for
  `vision`); the truncation is logged.
