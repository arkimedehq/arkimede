# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

FROM python:3.12-slim

WORKDIR /app

# Tesseract OCR engine + language packs (space-separated Tesseract codes).
ARG TESSERACT_LANGS="eng ita"
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
       $(for l in ${TESSERACT_LANGS}; do printf 'tesseract-ocr-%s ' "$l"; done) \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-structured.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Structured level (Docling; libgl/glib are runtime deps of its OpenCV). OCR_STRUCTURED=0 builds a light image with the
# fast level only (~10x smaller): the backend detects the missing engine at
# runtime and disables the level in the UI.
ARG OCR_STRUCTURED=1
RUN if [ "${OCR_STRUCTURED}" = "1" ]; then \
      apt-get update \
      && GLIB=$(apt-cache show libglib2.0-0t64 >/dev/null 2>&1 && echo libglib2.0-0t64 || echo libglib2.0-0) \
      && apt-get install -y --no-install-recommends libgl1 "$GLIB" \
      && rm -rf /var/lib/apt/lists/* \
      && pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements-structured.txt \
      && docling-tools models download layout tableformer rapidocr -o /opt/docling-models; \
    fi

COPY main.py .

ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models
ENV OMP_NUM_THREADS=2

EXPOSE 9200

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9200"]
