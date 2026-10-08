#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese
"""
gen-deploy-bundle.py — builds the PULL-based deploy bundle (arkimedehq/arkimede-deploy)
from this repo, so the bundle never drifts from the source compose files.

    ./scripts/gen-deploy-bundle.py <out_dir>

Writes into <out_dir>:
  - docker-compose.hub*.yml  generated from docker-compose.yml and its overlays: every
    first-party `build:` becomes the pre-built image
    ${ARKIMEDE_IMAGE_PREFIX:-ghcr.io/arkimedehq/arkimede}-<image>:<tag> (the images that
    .github/workflows/release-images.yml publishes); the local-only `runner` build service
    is dropped (the broker pulls the runner image by name);
  - the static bundle files from deploy/ (installer, updater, README, …);
  - .env.example and LICENSE copied from the repo root;
  - scripts/backup.sh and scripts/postgres-to-pgvector.sh (used by update-hub.sh).

Line-based on purpose: it keeps every comment of the source files and needs no YAML
library. It understands the layout used by our compose files (2-space service keys,
4-space service fields) and fails loudly on anything it does not recognise.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREFIX = "${ARKIMEDE_IMAGE_PREFIX:-ghcr.io/arkimedehq/arkimede}"
VERSION = "${ARKIMEDE_VERSION:-latest}"

# source compose file → bundle file
FILES = {
    "docker-compose.yml": "docker-compose.hub.yml",
    "docker-compose.broker.yml": "docker-compose.hub.broker.yml",
    "docker-compose.egress.yml": "docker-compose.hub.egress.yml",
    "docker-compose.novoice.yml": "docker-compose.hub.novoice.yml",
}

# compose service → (published image name, tag). Images with build-time variants
# (embedding cpu/cuda, ocr full/light) take their tag from a dedicated variable that
# install-hub.sh sets to "<version>[-variant]".
IMAGES = {
    "backend": ("backend", VERSION),
    "frontend": ("frontend", VERSION),
    "skill-executor": ("executor", VERSION),
    "embedding": ("embedding", "${EMBEDDING_IMAGE_TAG:-latest}"),
    "whisper": ("whisper", VERSION),
    "piper": ("piper", VERSION),
    "ocr": ("ocr", "${OCR_IMAGE_TAG:-latest}"),
    "broker": ("broker", VERSION),
    "egress-proxy": ("egress-proxy", VERSION),
}
DROPPED_SERVICES = {"runner"}  # build-only helper: the broker pulls the runner image itself
# Local image names used by the source overlays → published refs.
LOCAL_IMAGE_REFS = {
    "pa-runner": PREFIX + "-runner:" + VERSION,
    "pa-broker": PREFIX + "-broker:" + VERSION,
    "pa-egress-proxy": PREFIX + "-egress-proxy:" + VERSION,
}


def banner(src_name: str) -> str:
    return (
        "# GENERATED from " + src_name + " of https://github.com/arkimedehq/arkimede by\n"
        "# scripts/gen-deploy-bundle.py — do not edit here: change the source compose file.\n"
        "# First-party services PULL pre-built images (ghcr.io/arkimedehq/arkimede-<service>)\n"
        "# instead of building from source; pin ARKIMEDE_VERSION in .env for reproducibility.\n"
    )


def indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def transform(src_name: str, text: str) -> str:
    lines = text.splitlines()
    # The source header documents the build-based usage: keep only the licence lines.
    head = 0
    while head < len(lines) and (lines[head].strip() == "" or lines[head].lstrip().startswith("#")):
        head += 1
    licence = [ln for ln in lines[:head] if ln.startswith(("# SPDX", "# Copyright"))]
    lines = lines[head:]
    out: list[str] = []
    in_services = False
    service = None
    skip_indent = None      # skipping a block deeper than this indent
    image_written = set()
    for line in lines:
        stripped = line.strip()
        ind = indent(line)

        if skip_indent is not None:
            if stripped == "" or ind > skip_indent:
                continue
            skip_indent = None

        if ind == 0 and stripped and not stripped.startswith("#"):
            in_services = stripped == "services:"
            service = None

        if in_services and ind == 2 and stripped.endswith(":") and not stripped.startswith("#"):
            service = stripped[:-1]
            if service in DROPPED_SERVICES:
                # Its leading comment block describes the dropped service too.
                while out and (out[-1].strip() == "" or (out[-1].lstrip().startswith("#") and indent(out[-1]) == 2)):
                    out.pop()
                skip_indent = 2
                continue

        if service and ind == 4 and stripped == "build:":
            if service not in IMAGES:
                sys.exit(src_name + ": service '" + service + "' has a build: but no published image mapping")
            name, tag = IMAGES[service]
            if service not in image_written:
                out.append("    image: " + PREFIX + "-" + name + ":" + tag)
                image_written.add(service)
            skip_indent = 4
            continue

        if service and ind == 4 and stripped.startswith("image:"):
            ref = stripped.split(":", 1)[1].strip()
            if ref in LOCAL_IMAGE_REFS or service in image_written:
                if service not in image_written:
                    out.append("    image: " + LOCAL_IMAGE_REFS[ref])
                    image_written.add(service)
                continue

        if not stripped.startswith("#"):
            for local, published in LOCAL_IMAGE_REFS.items():
                line = line.replace(": " + local, ": " + published)
        out.append(line)

    body = "\n".join(out).rstrip("\n") + "\n"
    for ln in body.splitlines():
        if ln.strip().startswith("#"):
            continue
        if ln.strip() == "build:":
            sys.exit(src_name + ": a build: block survived the transform")
        for local in LOCAL_IMAGE_REFS:
            if ": " + local in ln:
                sys.exit(src_name + ": unresolved local image reference left: " + ln.strip())
    return "\n".join(licence) + "\n\n" + banner(src_name) + "\n" + body


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: gen-deploy-bundle.py <out_dir>")
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)

    for src, dst in FILES.items():
        (out / dst).write_text(transform(src, (ROOT / src).read_text()))

    shutil.copytree(ROOT / "deploy", out, dirs_exist_ok=True)
    shutil.copy2(ROOT / ".env.example", out / ".env.example")
    shutil.copy2(ROOT / "LICENSE", out / "LICENSE")
    (out / "scripts").mkdir(exist_ok=True)
    for script in ("backup.sh", "postgres-to-pgvector.sh"):
        shutil.copy2(ROOT / "scripts" / script, out / "scripts" / script)

    print("deploy bundle written to " + str(out))


if __name__ == "__main__":
    main()
