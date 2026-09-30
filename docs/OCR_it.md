# OCR dei documenti (indicizzazione RAG)

Stato: IMPLEMENTATO (2026-09-30) — `ocr-service/`, `backend/src/ocr/`, migration 087.
Copia inglese: `OCR.md`.

Quando un PDF o un'immagine viene indicizzato nel RAG, il testo viene letto con un
**livello OCR** scelto per ogni documento (fino a un massimo impostato dall'admin). Ogni
livello conserva il testo nativo dei PDF digitali; cambiano nel modo in cui leggono le
scansioni e il testo dentro le immagini.

| Livello | Motore | Dove gira | Ottimo per | Costo |
|---|---|---|---|---|
| `none` | `pdf-parse` (solo testo digitale) | backend | PDF digitali | — |
| `fast` | PyMuPDF + **Tesseract** | ocr-service | scansioni, PDF misti (testo + immagini con testo) | ~0,2–1 s/pagina, CPU |
| `structured` | **Docling** (layout + TableFormer) + **RapidOCR** (modelli PaddleOCR, ONNX) | ocr-service | tabelle, titoli, layout a colonne → markdown | ~1–8 s/pagina, CPU, ~1,5 GB RAM |
| `vision` | pagina renderizzata dall'ocr-service, trascritta dal **modello LLM di visione** | ocr-service + provider LLM | foto, scrittura a mano, layout molto irregolari | una chiamata LLM per pagina |

PDF misti: il livello `fast` tiene il testo nativo di ogni pagina e fa l'OCR **solo delle
aree immagine**; una pagina senza testo nativo utilizzabile (scansione, font senza mappa
unicode) viene passata in OCR per intero. `structured` fa lo stesso con la pipeline di
Docling. `vision` invia l'immagine della pagina più il suo testo nativo come suggerimento
per l'ortografia esatta.

Misurato sui documenti di prova (Apple Silicon, Docker CPU): una tabella scansionata con
griglia viene letta perfettamente da `structured` (tabella markdown), mentre Tesseract
(`fast`) perde delle righe; il testo italiano accentato viene letto correttamente da
entrambi.

## Componenti

- **`ocr-service/`** (FastAPI, porta 9200, non esposta sull'host): `GET /health` (motori
  disponibili), `POST /v1/extract` (multipart `file`, `engine=fast|structured`),
  `POST /v1/render` (PNG per pagina + testo nativo, a blocchi con `first_page`/`max_pages`).
  Tutti i modelli sono inclusi nell'immagine in fase di build: funziona offline.
- **`backend/src/ocr/`**: `OcrService` risolve il livello (richiesto o predefinito admin,
  limitato dal massimo admin, degradato al livello disponibile più vicino) e chiama il
  servizio; `vision` è orchestrato qui (render → una chiamata al modello di visione per
  pagina, con ripiego sul testo nativo pagina per pagina). `GET /api/ocr/levels` (utenti),
  `GET|PATCH /api/admin/config/ocr` (admin).
- **`FilesService.extractText*`** accetta un `ocrLevel` opzionale; i PDF tornano a
  `pdf-parse` quando l'OCR è spento, non disponibile o fallisce, esattamente come prima
  del servizio. Immagini: prima `fast`/`structured`, poi il modello di visione se non
  trovano testo (le foto continuano ad avere una descrizione ricercabile), niente con
  `none` esplicito.
- **Indicizzazione in coda**: `POST /api/embed/:fileId` e `POST /api/embed/datasource`
  accettano `ocrLevel` e passano per la coda BullMQ `embed-ingest`; l'utente riceve una
  notifica al termine (la lista file si aggiorna su quella notifica).
- **UI**: selettore del livello nel passaggio "Embed in RAG" della chat e nel pannello file
  della chat (solo per PDF/immagini); card admin *Impostazioni → Vector DB → OCR
  documenti* con la disponibilità di ogni livello e predefinito/massimo.

Chi non sceglie (tool RAG-index degli agenti, skill `files`, allegati inline in chat) usa
il predefinito admin.

## Configurazione

| Variabile | Dove | Default | Significato |
|---|---|---|---|
| `OCR_STRUCTURED` | build | `1` | `1` immagine completa (~4 GB, tutti i livelli) · `0` leggera (~0,5 GB, solo `fast`) |
| `OCR_TESSERACT_LANGS` | build | `eng ita` | pacchetti lingua Tesseract (nomi Debian) |
| `OCR_LANGUAGES` | ocr | `ita+eng` | lingue Tesseract a runtime |
| `OCR_CONCURRENCY` / `OCR_MAX_PAGES` | ocr | `1` / `500` | job paralleli / limite pagine |
| `OCR_BASE_URL` | backend | `http://ocr:9200` | URL del servizio |
| `OCR_TIMEOUT_MS` | backend | `1800000` | timeout per richiesta |
| `OCR_VISION_MAX_PAGES` / `OCR_VISION_CONCURRENCY` | backend | `100` / `2` | limite pagine `vision` / chiamate LLM parallele |

Impostazioni admin (`app_config.ocrDefaultLevel`, `ocrMaxLevel`): predefinito `fast`, massimo `vision`.

L'installer chiede se compilare l'immagine completa o quella leggera. Senza alcun
container `ocr`, ogni livello degrada a `none` e le immagini al modello di visione: il
comportamento precedente all'OCR.

## Licenze

Tesseract, modelli RapidOCR/PaddleOCR, modello di layout Docling: Apache-2.0; Docling:
MIT; TableFormer: CDLA-Permissive-2.0/Apache-2.0; **PyMuPDF: AGPL-3.0** (usato sotto AGPL,
come Arkimede). Marker/Surya sono stati esclusi (codice GPL, pesi con limiti commerciali).
Dettagli in `THIRD_PARTY_NOTICES_it.md`.

## Limiti noti

- `fast` sulle tabelle scansionate con bordi perde celle: usare `structured`.
- La disponibilità di `vision` significa "è configurato un modello di visione/predefinito":
  se accetta immagini si scopre solo alla chiamata; un modello che le rifiuta fa ripiegare
  ogni pagina sul suo testo nativo (con un warning nei log).
- I documenti molto lunghi vengono troncati a `OCR_MAX_PAGES` (`OCR_VISION_MAX_PAGES` per
  `vision`); il troncamento viene loggato.
