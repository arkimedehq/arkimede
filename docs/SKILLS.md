# Creating a Skill for Arkimede

**Skills** are ZIP packages that extend the AI with executable Python or Node.js scripts.  
The LLM autonomously decides when to use them, based on the instructions in `SKILL.md`.

---

## Table of Contents

1. [Package structure](#1-package-structure)
2. [SKILL.md — frontmatter + full schema](#2-skillmd--frontmatter--full-schema)
3. [Choosing the runner](#3-choosing-the-runner)
4. [Python scripts](#4-python-scripts)
5. [Node.js scripts](#5-nodejs-scripts)
6. [JavaScript scripts (sandbox)](#6-javascript-scripts-sandbox)
7. [SKILL.md — instructions for the LLM (+ @tool marker)](#7-skillmd--instructions-for-the-llm)
   - [7a. Single-script template](#7a-skillmd-template--single-script)
   - [7b. `@tool` marker — selective loading](#7b-tool-marker--selective-loading-for-multi-script-skills)
   - [7c. Canonical tool names — preventing hallucinations](#7c-canonical-tool-names--preventing-hallucinations-on-small-models)
8. [System variables (_config)](#8-system-variables)
9. [Returning downloadable files](#9-returning-downloadable-files)
10. [Internal APIs from scripts](#10-internal-apis-from-scripts)
   - [10a. Saving config vars (secure)](#10a-saving-config-vars-secure)
   - [10b. SQL queries on datasource](#10b-query-on-datasource-sql-mongodb-redis-file-share)
   - [10c. Semantic search in the vector store](#10c-semantic-search-in-the-vector-store)
   - [10d. Indexing data in the vector store](#10d-indexing-data-in-the-vector-store)
   - [10e. Indexing a DataSource file (full pipeline)](#10e-indexing-a-datasource-file-full-pipeline)
   - [10f. Searching the user's files (access-scoped)](#10f-searching-the-users-files-access-scoped)
   - [10g. Invoking another skill (inter-skill)](#10g-invoking-another-skill-inter-skill)
11. [System dependencies (Nix)](#11-system-dependencies-nix)
12. [Daemon scripts (background / watch)](#12-daemon-scripts-background--watch)
13. [Enabling/disabling a skill](#13-enablingdisabling-a-skill)
14. [Uploading, testing and publishing the skill](#14-uploading-testing-and-publishing-the-skill)
15. [GitHub registry (contributing)](#15-github-registry-contributing)
16. [Common patterns](#16-common-patterns)
17. [Creating skills with AI assistance](#17-creating-skills-with-ai-assistance)
18. [Descriptive skills (agentskills.io), Sandbox and compilation](#18-descriptive-skills-agentskillsio-sandbox-and-compilation)

---

## 1. Package structure

```
my-skill.zip
├── SKILL.md          ← REQUIRED: YAML frontmatter (metadata + runtime) + instructions for the LLM
└── scripts/
    ├── main.py       ← main script
    └── helpers.py    ← importable modules (optional)
```

**Creating the ZIP:**
```bash
cd /tmp/my-skill
zip -r /tmp/my-skill-v1.0.0.zip .
# Upload the file in Settings → Skills → Upload ZIP
```

---

## 2. SKILL.md — frontmatter + full schema

The manifest lives in the **YAML frontmatter** at the top of `SKILL.md` (agentskills.io format).
`name` and `description` are **standard** fields — any compatible client reads them for
discovery. Everything related to execution (dependencies, network, config, scripts) sits
under the namespaced **`runtime:`** block, which standard clients ignore. After the closing
`---` line come the Markdown instructions for the LLM.

```markdown
---
name: nome-skill              # kebab-case, unique per user
version: 1.0.0
description: >
  Description for the AI: what this skill does and when to use it.
author: email@example.com
license: MIT

# ── Everything executable under `runtime` (extension, ignored by standard clients) ──
runtime:

  # ── Dependencies ────────────────────────────────────────────────────────
  dependencies:
    python:                   # PyPI packages (for language: python)
      - requests>=2.31
      - pandas>=2.0
      - fpdf2>=2.7
    javascript:               # npm packages (for language: node)
      - puppeteer@22
      - pdf-lib@1.17
    system:
      nix:                    # system tools from nixpkgs — available via subprocess
        - cowsay              # e.g. subprocess.run(['cowsay', 'hello'])
        - imagemagick         # e.g. subprocess.run(['convert', 'in.png', 'out.jpg'])
        - ffmpeg              # e.g. subprocess.run(['ffmpeg', '-i', 'in.mp4', 'out.mp3'])

  # ── Allowed network egress (capability, C1) ───────────────────────────────
  network:                    # domains the skill may connect to at run-time
    - api.open-meteo.com      # absent/[] = NO egress (beyond the registries for install)
    - api.weatherapi.com      # subdomains are included (e.g. .open-meteo.com)
  # With the egress-proxy active, connections to undeclared domains are BLOCKED at the
  # network level. The internal backend (BACKEND_INTERNAL_URL) is ALWAYS reachable (not
  # subject to the allowlist). NB: declare ONLY real HTTP endpoint domains, not OAuth scopes.
  # Honored transparently by BOTH Python and Node skills/daemons — the platform routes their
  #   HTTP(S) through the proxy, so you need NO proxy code in your script.
  # ⚠ A redirect that crosses to an UNDECLARED domain is blocked → declare every domain a
  #   flow touches (e.g. api.x.com that 302-redirects to cdn.x.com needs BOTH).
  # The declared domains are shown in the UI (open the skill → "Network access").
  # LAN/VPN/subnet access is NOT declared here: an admin grants "reserved networks" per-skill
  #   from the UI (Settings → Skills → skill → Reserved networks).
  # DESCRIPTIVE (agentskills.io) skills run via the sandbox, whose network mode (none/egress/open)
  #   is a GLOBAL admin setting; under 'egress' the same allowlist (these domains) applies.

  # ── Filesystem access (capability, C2) ─────────────────────────────────────
  filesystem: none            # none (default) | project | tenant | all
  # Breadth of access to the user's files. Default `none` = the skill sees only the files
  # it receives explicitly (input `format: file-ref`) and its own work dir. The ceiling
  # ALWAYS remains bound to the rights of the identity running the run. Approved in review.

  # ── User-configurable variables in the UI ──────────────────────────────────
  config:
    - key: OUTPUT_DIR
      description: "Directory where generated files are saved"
      default: "${UPLOAD_DIR}/skills-output"   # ${VAR} interpolated with the system vars
      required: false
      secret: false
    - key: API_KEY
      description: "External API key"
      required: true
      secret: true            # value encrypted in the DB, not exposed in the APIs
    # type: datasource → DataSource dropdown (stores UUID); `family` (opt.) filters:
    #   relational | document | keyvalue | fileshare. type: collection → collection dropdown.
    # ⚠️ Read from `_config` (NOT env): cfg = data.get("_config", {}); ds = cfg.get("DATASOURCE_ID")
    - key: DATASOURCE_ID
      description: "DataSource to query/use"
      required: false
      type: datasource
      family: fileshare       # optional — omit to show all DataSources
    - key: VECTOR_COLLECTION
      description: "Vector collection for search/ingest"
      required: false
      type: collection

  # ── Executable scripts ──────────────────────────────────────────────────────
  scripts:
    - filename: scripts/main.py
      language: python        # python | node | javascript
      mode: oneshot           # oneshot (default) | daemon — omittable for normal scripts
      description: >
        Detailed description for the LLM: exactly what this script does,
        when to call it, what input it expects, what it returns.
      input_schema:
        type: object
        required:
          - titolo
        properties:
          titolo:
            type: string
            description: "Document title (plain text)"
          righe:
            type: array
            description: "List of {voce, importo} objects"
          allegato:
            type: string
            format: file-ref    # copy-in: the backend AUTHORIZES the file (canAccess) and
            description: >       #   stages it in the work dir; the script receives a local path.
              File to process (rel path or fileId). The value passed to the script is the
              local path (e.g. /work/inputs/allegato.pdf), not the original path.

    - filename: scripts/watcher.py
      language: python
      mode: daemon            # long-running background process — not invoked by the LLM
      description: >
        Background process. Started via the daemon interface, not by the LLM.
        Emits push events to the backend when it detects changes.
---

# Skill Name

Instructions for the LLM: when to use it, `download_url` rule, examples…
```

> **agentskills.io compatibility** — an external client reads only `name`/`description`
> (+ the Markdown body under the frontmatter) and ignores `runtime`. Skills thus stay
> portable within the ecosystem, while the backend uses `runtime` to expose the scripts as tools.

> **`mode: daemon`** — the script runs as a long-running process.
> It never appears among the tools available to the LLM.
> It is started and stopped from **Settings → Skills → Background**.
> See [section 12](#12-daemon-scripts-background--watch) for the full protocol.

---

## 3. Choosing the runner

| `language` | Runner | Dependencies | Node.js API | When to use it |
|---|---|---|:---:|---|
| `python`     | subprocess `python3`     | PyPI via `pip --target`           | ✗  | Data analysis, PDF with fpdf2, ML, file operations |
| `node`       | subprocess `node`        | npm via `npm install`             | ✅ | Puppeteer, PDF with npm libraries, scraping, `fs`/`https` |
| `javascript` | isolated-vm (V8 sandbox) | npm (pure CJS only, no Node APIs) | ✗  | Pure JSON computation; CJS libraries without native I/O (e.g. lodash, csv-parse) |

> **Rule of thumb:** if you need `require()` or an npm library → `node`. If it's Python → `python`. If it's pure JS without libraries → `javascript`.

### Mode: oneshot vs daemon

| `mode` | Lifecycle | Invoked by | Output |
|--------|--------------|-------------|--------|
| `oneshot` _(default)_ | Start → process → terminate | LLM via tool call | JSON on stdout |
| `daemon` | Runs in background until explicit stop | Daemon interface / API | POST events to `PUSH_URL` |

Scripts with `mode: daemon` never appear as tools available to the LLM.
For the full protocol see [section 12](#12-daemon-scripts-background--watch).

---

## 4. Python scripts

### Base template

```python
#!/usr/bin/env python3
import sys
import json

def main():
    # Read input from stdin (JSON)
    data    = json.load(sys.stdin)
    _config = data.get('_config', {})    # variables injected by the backend

    # Input parameters
    titolo = data.get('titolo', 'Documento')

    # Configuration variables
    upload_dir = _config.get('UPLOAD_DIR', '/app/uploads')
    output_dir = _config.get('OUTPUT_DIR', f"{upload_dir}/skills-output")
    app_name   = _config.get('APP_NAME', 'Arkimede')

    # ... logic ...

    # Output (last valid JSON line on stdout = result)
    print(json.dumps({
        "success": True,
        "result":  "skill output",
        "message": "Operation completed successfully"
    }))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"success": False, "error": str(e), "stack": traceback.format_exc()}))
        sys.exit(1)
```

### Using PyPI dependencies

```python
# Declared in SKILL.md → runtime.dependencies.python
# PYTHONPATH is set automatically by the runner
import pandas as pd
import requests

# Works without manual installations
df = pd.read_csv('data.csv')
```

### Safe Unicode text (for PDFs with fpdf2)

fpdf2's standard fonts (Helvetica/Arial) only support Latin-1. Use this function:

```python
import unicodedata

_UNICODE_MAP = str.maketrans({
    "‘": "'", "’": "'",   # single quotes
    "“": '"', "”": '"',   # double quotes
    "–": "-", "—": "--",  # dashes
    "…": "...", "•": "-", # ellipsis, bullet
    "€": "EUR", "®": "(R)", "©": "(C)", "™": "TM",
})

def safe_text(text) -> str:
    """Converts text into a Latin-1-safe string for fpdf2."""
    text = str(text) if text is not None else ""
    text = text.translate(_UNICODE_MAP)
    text = unicodedata.normalize("NFC", text)
    return text.encode("latin-1", errors="replace").decode("latin-1")

# Usage
pdf.cell(0, 8, safe_text(titolo))
```

> Italian accented letters (à è é ì ò ù) are already in Latin-1 and require no conversion.

---

## 5. Node.js scripts

### Base template

```javascript
'use strict';
const fs   = require('fs');
const path = require('path');

async function main() {
    // Read input from stdin
    const raw     = fs.readFileSync(0, 'utf8');
    const data    = JSON.parse(raw);
    const _config = data._config ?? {};

    // Input parameters
    const titolo = data.titolo ?? 'Documento';

    // Configuration variables
    const uploadDir = _config.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
    const outputDir = _config.OUTPUT_DIR ?? path.join(uploadDir, 'skills-output');
    const appName   = _config.APP_NAME   ?? 'Arkimede';

    // ... logic ...

    // Output — console.log on stdout, last valid JSON line = result
    console.log(JSON.stringify({
        success: true,
        result:  'output',
        message: 'Operation completed'
    }));
}

main().catch(err => {
    console.log(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
    process.exit(1);
});
```

### Using npm dependencies

```javascript
// Declared in SKILL.md → runtime.dependencies.javascript
// NODE_PATH is set automatically by the runner to .deps/node/node_modules
const puppeteer = require('puppeteer');   // works without a local package.json
const { PDFDocument } = require('pdf-lib');
```

### Generating PDFs with Puppeteer

```javascript
const puppeteer = require('puppeteer');

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const page = await browser.newPage();
await page.setContent(`<!DOCTYPE html><html><body>${html}</body></html>`, { waitUntil: 'networkidle0' });
await page.pdf({ path: outPath, format: 'A4', printBackground: true });
await browser.close();
```

---

## 6. JavaScript scripts (sandbox)

For pure computation on data. Runs in a fully sandboxed V8 Isolate: no access to `require`, `fs`, `process`, network or other Node.js globals. It cannot generate downloadable files — use the `node` runner if you need to write to disk.

**Global variables available in the sandbox:**

| Variable | Description |
|---|---|
| `input` | Input parameters passed by the LLM (JSON object) |
| `config` | The skill's configuration variables — **`config`, not `_config`** |
| `print(str)` | Writes a string to stdout (the only output channel) |
| `console.log(...)` | Alias for `print` |

> **⚠️ Important difference from Python/Node:** config vars are in `config.MY_VAR`, not in `_config.MY_VAR`. The `_config` object does not exist in the JS sandbox.

**Output — two options:**

```javascript
// Option A — explicit return (the value is JSON.stringify'd and appended to stdout)
const numeri = input.numeri || [];
const somma  = numeri.reduce((a, b) => a + b, 0);

return {
    somma,
    media:   somma / numeri.length,
    massimo: Math.max(...numeri),
    minimo:  Math.min(...numeri),
};

// Option B — console.log (preferable for canonical JSON output)
// console.log(JSON.stringify({ somma, media: somma / numeri.length }));
```

> **Note:** assigning to an undeclared variable (`result = {...}`) without `return` produces no output, because the IIFE wrapping the code returns `undefined` unless there is an explicit `return`.

---

## 7. SKILL.md — instructions for the LLM

The `SKILL.md` is injected into the system prompt for the projects the skill is assigned to.  
It is the most important document: it determines when and how the LLM uses the skill.

### 7a. SKILL.md template — single script

````markdown
# Skill Name

> ⚠️ **Canonical tool name:** `skill_nome_skill_main_py`
>
> **Never call** a tool with names like `nome_skill` or `main` — always use the exact name above.

## When to use it

Use this skill **only on explicit user request** — when they ask to:
- [use case 1: e.g. "Make me a PDF with..."]
- [use case 2: e.g. "Generate a report of..."]

**Do not** use it for [cases to exclude: e.g. normal text replies, simple calculations].

---

<!-- @tool: main.py -->
## `main.py` — [Action description]

**Tool name (use this exact name):** `skill_nome_skill_main_py`

### How to use it

Call this tool with:

| Field      | Type     | Required | Description |
|------------|----------|:---:|-------------|
| `param1`   | string   | ✅  | ... |
| `param2`   | number   | ❌  | ... (default: 10) |

> `_config` is injected automatically — do not include it in the input.

## Output and response to the user

The script returns JSON with:
```json
{
  "success": true,
  "filename": "output_1234567890.pdf",
  "download_url": "/api/files/raw?rel=output_1234567890.pdf",
  "size_bytes": 45678,
  "message": "File generated successfully..."
}
```

> **Note (per-user isolation).** Outputs written to `SKILLS_OUTPUT_DIR` land in a
> per-user subdir; the `?rel=` download is confined to it, so `rel` is the **file
> basename** (relative to `SKILLS_OUTPUT_DIR`), **not** `skills-output/<name>`.
> You usually don't even need to build the link: the backend automatically tracks
> the files you produce and surfaces them in the chat/project file panel (and appends
> canonical download links to the tool result).

### ⚠️ Critical rule on download_url

**ALWAYS use the `download_url` field exactly as returned — never modify it.**

- ✅ Correct: `[Download file](/api/files/raw?rel=output_1234567890.pdf)`
- ❌ Wrong: building the URL from `filename`, `path` or other fields; or prefixing `skills-output/`

### How to present the link

```
The file is ready! [Download {filename}]({download_url}) ({size_kb} KB)
```
````

---

### 7b. `@tool` marker — selective loading for multi-script skills

When a skill has **more than one script**, the SKILL.md can become very long and consume many tokens even when the agent needs only one script. The `<!-- @tool: filename.py -->` markers let the system include **only the relevant sections**.

#### How it works

The backend uses the tool loading strategy (semantic_rag / keyword_bm25) to select the active tools. If the SKILL.md contains `@tool` markers, only the section of the selected tool is included:

```
SKILL.md with markers          Selected tools             Sections included in the prompt
─────────────────────────────────────────────────────────────────────────────────
# Skill title                → ALWAYS                   → # Skill title
routing table                                             routing table
                                                          (shared section)
<!-- @tool: script_a.py -->  → skill_nome_script_a_py   → ## script_a.py section
## How to use script_a.py    → SELECTED                  (included)

<!-- @tool: script_b.py -->  → skill_nome_script_b_py   → (filtered out)
## How to use script_b.py    → NOT selected
```

**Typical result:** -40% tokens in the system prompt compared to full loading.

#### Multi-script SKILL.md structure with markers

````markdown
# Skill Name

> ⚠️ **IMPORTANT — Exact tool names to use in the calls:**
>
> | Action | **Tool name to invoke** |
> |--------|--------------------------|
> | Action A | **`skill_nome_skill_script_a_py`** |
> | Action B | **`skill_nome_skill_script_b_py`** |
>
> **Never call** a tool with names like `nome_skill`, `script_a` — always use the exact names above.

## General notes / Multi-step workflow

> ℹ️ All text before the first `<!-- @tool -->` marker is the **shared section**
> and is ALWAYS included in the prompt, regardless of the selected tools.
> Use it for: introduction, canonical names table, general notes, multi-step workflow.

<!-- @tool: script_a.py -->
## `script_a.py` — Action A description

**Tool name (use this exact name):** `skill_nome_skill_script_a_py`

### Input

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `param1` | string | ✅ | ... |

### Output

```json
{ "success": true, "result": "...", "message": "..." }
```

<!-- @tool: script_b.py -->
## `script_b.py` — Action B description

**Tool name (use this exact name):** `skill_nome_skill_script_b_py`

### Input
...
````

#### Rules

- The **name in the marker** must match **exactly** the `filename` declared in `runtime.scripts`, without the `scripts/` prefix: write `<!-- @tool: list_emails.py -->`, not `<!-- @tool: scripts/list_emails.py -->`
- The marker is a standard HTML comment — it is ignored by Markdown rendering but intercepted by the backend parser
- If the SKILL.md **contains no markers**, it is included in full (backward compatible)
- With the `always_inject_all` strategy all SKILL.md files are loaded in full (no filtering)
- **Even single-script skills** should have the `<!-- @tool: filename -->` marker for consistency and to enable selective filtering in the future

---

### 7c. Canonical tool names — preventing hallucinations on small models

LLM models with few parameters (≤ 14B) tend to hallucinate the tool name using the
**skill name** (`gmail`, `pdf`) or the **script name** (`send_email`, `generate_pdf`)
instead of the full canonical name. The SKILL.md must explicitly discourage this.

#### Canonical name formula

The backend generates the tool name with this logic (from `skill-tool.factory.ts → buildToolName`):

```
skill_{skill_name}_{script_filename}
```

where:
- `skill_name` → the `name:` field of the `SKILL.md` frontmatter, with `-` → `_`, all lowercase
- `script_filename` → filename without `scripts/`, all non-alphanumeric characters → `_`,
  `__` sequences reduced to `_`, all lowercase

**Examples:**

| `name` in frontmatter | Script | Canonical tool name |
|---|---|---|
| `gmail` | `scripts/send_email.py` | `skill_gmail_send_email_py` |
| `gmail` | `scripts/list_emails.py` | `skill_gmail_list_emails_py` |
| `pdf-generator-html` | `scripts/generate_pdf.js` | `skill_pdf_generator_html_generate_pdf_js` |
| `dxf-analyzer` | `scripts/analyze_dxf.py` | `skill_dxf_analyzer_analyze_dxf_py` |
| `file-lookup` | `scripts/find_file.js` | `skill_file_lookup_find_file_js` |
| `ascii-art` | `scripts/banner.py` | `skill_ascii_art_banner_py` |
| `ascii-art` | `scripts/image_ascii.py` | `skill_ascii_art_image_ascii_py` |
| `mia-skill` | `scripts/run.py` | `skill_mia_skill_run_py` |

> **Note:** scripts with `mode: daemon` in the `SKILL.md` frontmatter are **not registered** as
> LangGraph tools and therefore have no canonical name. Include them in the SKILL.md with an explicit warning.

#### Mandatory patterns in the SKILL.md

**Shared section (before the first `@tool`)** — always visible to the LLM:

```markdown
> ⚠️ **Canonical tool name:** `skill_xxx_yyy`
>
> **Never call** a tool with names like `xxx`, `yyy` — always use the exact name above.
```

For multi-script skills, use a table:

```markdown
> ⚠️ **IMPORTANT — Exact tool names:**
>
> | Action | **Tool name to invoke** |
> |--------|--------------------------|
> | First action | **`skill_xxx_script_a_py`** |
> | Second action | **`skill_xxx_script_b_py`** |
>
> **Never call** a tool with names like `xxx`, `script_a` — always use the exact names above.
```

**Section for each script** — right after the H2 title:

```markdown
<!-- @tool: script.py -->
## `script.py` — Title

**Tool name (use this exact name):** `skill_xxx_script_py`
```

**Daemon scripts** — no tool name, only a warning:

```markdown
<!-- @tool: daemon.py -->
## `daemon.py` — Background monitoring

> ⚠️ **This script is NEVER invoked by the LLM** — there is no `skill_xxx_daemon_py` tool.
> It is managed by the application via the background interface (Settings → Background).
```

#### Common errors from small models and their solutions

| Error observed in the log (`tool:xxx`) | Cause | Solution in the SKILL.md |
|---|---|---|
| `tool:gmail` instead of `skill_gmail_send_email_py` | The LLM uses the skill name as the tool | Canonical names table + "Never call" warning at the top |
| `tool:generate_pdf` instead of `skill_pdf_generator_html_generate_pdf_js` | The LLM uses the script name without prefix | `**Tool name:**` in each script section |
| Calls the tool with wrong arguments | Unclear schema | Input table with a Required column |
| Does not pass `file_path` in inter-skill | Missing end-to-end example | Example with explicit canonical names in the comments |

---

## 8. System variables

### 8a. Environment variables (`process.env` / `os.environ`)

Injected directly into the subprocess by the executor — accessible via `process.env` (Node) or `os.environ` (Python). They do **not** arrive in `_config`.

**All scripts (oneshot and daemon):**

| Variable | Node | Python | Description |
|---|:---:|:---:|---|
| `SKILLS_OUTPUT_DIR` | ✅ | ✅ | Directory for generated files (download via `?rel=`). With the broker overlay it points to the job's work dir (automatic copy-out). |
| `SKILL_ID` | ✅ | ✅ | UUID of the running skill |
| `USER_ID` | ✅ | ✅ | Identity the run executes for (C2). Empty only if the run has no identity (fail-closed: no file access). |
| `SKILL_STATE_DIR` | ✅ | ✅ | _(broker overlay only)_ **Per-skill persistent** directory (survives across runs): use it for durable state/cache. In in-process execution it is not set. |
| `BACKEND_INTERNAL_URL` | ✅ | ✅ | Backend base URL (e.g. `http://localhost:3000`) |
| `INTERNAL_TOKEN` | ✅ | ✅ | Key for the `/internal/*` endpoints — see [section 10](#10-internal-apis-from-scripts) |
| `PATH` | ✅ | ✅ | Real host PATH (finds node, python3, system binaries) |
| `HOME` | ✅ | ✅ | **Node:** real host HOME (required for Puppeteer and tools that use `~/.cache`). **Python:** forced to `/tmp` to limit home access. |
| `TMPDIR` | ✅ | ✅ | Forced to `/tmp` for both runners |
| `NODE_PATH` | ✅ | ❌ | Path to the skill's isolated npm dependencies (`.deps/node/node_modules`) |
| `PYTHONPATH` | ❌ | ✅ | Path to the skill's isolated Python dependencies (`.deps/python`) |
| `PYTHONUNBUFFERED` | ❌ | ✅ | `1` — disables stdout buffering (ensures the JSON arrives without delays) |
| `PYTHONDONTWRITEBYTECODE` | ❌ | ✅ | `1` — prevents writing `.pyc` files outside `/tmp` |
| `NO_COLOR` / `FORCE_COLOR` | ✅ | ❌ | Disables ANSI output so it doesn't pollute the JSON |

> **`DATASOURCE_ID` / `VECTOR_COLLECTION`:** these are NOT environment variables. They are config
> vars (with a dedicated dropdown in the UI, see [section 2](#2-skillmd--frontmatter--full-schema)) and are
> read from `_config`: `cfg = data.get("_config", {}); cfg.get("DATASOURCE_ID")`.

> **⚠️ JS sandbox (`language: javascript`):** has no environment variables. It accesses parameters via the `input` and `config` globals injected into the isolate. See [section 6](#6-javascript-scripts-sandbox).

**`mode: daemon` scripts only** (see [section 12](#12-daemon-scripts-background--watch)):

| Variable | Description |
|---|---|
| `PUSH_URL` | Full endpoint for push events (`POST /internal/daemons/events`) |
| `DAEMON_ID` | UUID of the current daemon (DB record) |
| `USER_ID` | ID of the user who owns the daemon |

### 8b. The skill's configuration variables

They contain **only** the variables defined in `runtime.config` of `SKILL.md` and configured by the user in the UI. The backend may add some system variables such as `APP_NAME`.

How to access them **depends on the runner:**

| Runner | How to read the config vars |
|--------|----------------------------|
| `python` / `node` | `_config` field in the stdin JSON: `data.get("_config", {})` / `data._config ?? {}` |
| `javascript` (isolate) | `config` global injected into the sandbox: `config.MY_VAR` |

```python
# Python and Node — read from _config in the stdin JSON
_config  = data.get('_config', {})
app_name = _config.get('APP_NAME', 'default')  # backend system variable
my_key   = _config.get('MY_API_KEY', '')        # user-configured variable
```

```javascript
// JS sandbox — use the `config` global (not `_config`)
const appName = config.APP_NAME ?? 'default';
const myKey   = config.MY_API_KEY ?? '';
```

---

## 9. Returning downloadable files

### Correct pattern — path relative to UPLOAD_DIR

```python
# Python
import os
from urllib.parse import quote as _quote

upload_dir   = os.path.abspath(_config.get('UPLOAD_DIR', './uploads'))
output_dir   = os.path.abspath(_config.get('OUTPUT_DIR', os.path.join(upload_dir, 'skills-output')))
os.makedirs(output_dir, exist_ok=True)

out_path     = os.path.join(output_dir, f"report_{timestamp}.pdf")
# ... save the file ...

rel_path     = os.path.relpath(out_path, upload_dir)
download_url = f"/api/files/raw?rel={_quote(rel_path)}"

print(json.dumps({
    "success":      True,
    "filename":     os.path.basename(out_path),
    "download_url": download_url,
    "size_bytes":   os.path.getsize(out_path),
    "message":      f"File generated. Download: {download_url}"
}))
```

```javascript
// Node.js
const relPath    = path.relative(uploadDir, outPath).replace(/\\/g, '/');
const downloadUrl = `/api/files/raw?rel=${encodeURIComponent(relPath)}`;

console.log(JSON.stringify({
    success:      true,
    filename:     path.basename(outPath),
    download_url: downloadUrl,
    size_bytes:   fs.statSync(outPath).size,
    message:      `File generated. Download: ${downloadUrl}`
}));
```

**Why `?rel=` and not the absolute path?**  
The absolute filesystem path (`/app/uploads/...`) is not a valid web URL and confuses the LLM, which might try to build wrong URLs. The relative path is safe, portable and unambiguous.

---

## 10. Internal APIs from scripts

The executor injects three environment variables into every subprocess that allow the script
to communicate with the backend via protected internal endpoints:

| Variable | Description |
|---|---|
| `BACKEND_INTERNAL_URL` | Backend base URL (e.g. `http://localhost:3000`) |
| `INTERNAL_TOKEN` | Signed run token (per-execution, unforgeable) — `x-internal-token` header. Carries the identity of the run's user: the backend verifies it and applies the scope. |
| `SKILL_ID` | UUID of the current skill |

> ⚠️ Never include `INTERNAL_TOKEN` in the script's JSON output — it must not end up in the conversation history.

---

## 10a. Saving config vars (secure)

### The problem

Some scripts need to **persist sensitive data** at the end of their execution
(OAuth tokens, refresh tokens, dynamically obtained API keys).  
If these values are returned in the script's JSON output, they appear in the
AI's message and get **saved in the conversation history** of the database — visible to anyone
who has access to the chat.

### The solution: the executor's internal API

The executor injects three environment variables into every subprocess:
- `SKILL_ID` — UUID of the current skill
- `BACKEND_INTERNAL_URL` — backend URL (e.g. `http://localhost:3000`)
- `INTERNAL_TOKEN` — run token signed by the backend, injected per-execution

The script can call `POST {BACKEND_INTERNAL_URL}/internal/skills/{SKILL_ID}/save-config`
to write config vars **directly to the DB**, then return in the output only a confirmation
message with no sensitive data.

### Python template

```python
import os, json, urllib.request, urllib.error

SKILL_ID             = os.environ.get('SKILL_ID', '')
BACKEND_INTERNAL_URL = os.environ.get('BACKEND_INTERNAL_URL', 'http://localhost:3000').rstrip('/')
INTERNAL_TOKEN       = os.environ.get('INTERNAL_TOKEN', '')

def save_config(config: dict) -> None:
    """Saves config vars to the backend without exposing them in the chat output."""
    if not INTERNAL_TOKEN:
        raise ValueError(
            "INTERNAL_TOKEN missing: the script is not running inside a valid "
            "execution (the backend injects it for every run)."
        )
    url     = f"{BACKEND_INTERNAL_URL}/internal/skills/{SKILL_ID}/save-config"
    body    = json.dumps({'config': config}).encode('utf-8')
    request = urllib.request.Request(
        url, data=body,
        headers={
            'Content-Type':       'application/json',
            'x-internal-token': INTERNAL_TOKEN,
        },
        method='POST',
    )
    with urllib.request.urlopen(request) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        if not result.get('ok'):
            raise ValueError(f"Backend responded ok=false: {result}")

# Usage in the script
save_config({
    'MY_TOKEN':  token_value,
    'MY_SECRET': secret_value,
})

# Output: NO credentials — only confirmation
print(json.dumps({
    "success": True,
    "message": "✅ Configuration saved securely."
}))
```

### Node.js template

```javascript
const https = require('https');
const http  = require('http');

const SKILL_ID             = process.env.SKILL_ID             ?? '';
const BACKEND_INTERNAL_URL = (process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const INTERNAL_TOKEN     = process.env.INTERNAL_TOKEN     ?? '';

function saveConfig(config) {
    return new Promise((resolve, reject) => {
        const body   = JSON.stringify({ config });
        const url    = new URL(`${BACKEND_INTERNAL_URL}/internal/skills/${SKILL_ID}/save-config`);
        const lib    = url.protocol === 'https:' ? https : http;
        const req    = lib.request(url, {
            method:  'POST',
            headers: {
                'Content-Type':       'application/json',
                'Content-Length':     Buffer.byteLength(body),
                'x-internal-token': INTERNAL_TOKEN,
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const result = JSON.parse(data);
                result.ok ? resolve(result) : reject(new Error(`ok=false: ${data}`));
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Usage in the script
await saveConfig({ MY_TOKEN: tokenValue, MY_SECRET: secretValue });

// Output: NO credentials
console.log(JSON.stringify({ success: true, message: '✅ Configuration saved securely.' }));
```

### Required configuration

`INTERNAL_TOKEN` is **not configured**: it is minted and signed by the backend on every execution and
injected into the script's environment. On the server side you only need the signing secret in the backend:

```bash
# backend .env
RUN_TOKEN_SECRET=<secret>   # generate with: openssl rand -hex 32 — lives ONLY in the backend
BACKEND_INTERNAL_URL=http://localhost:3000   # in Docker: http://backend:3000
```

> The script receives an opaque single-use token that it **cannot forge**: this is what prevents
> a skill from impersonating another user towards the `/internal/*` endpoints.

### When to use it vs normal output

| Data type | Approach |
|---|---|
| Generated files (PDF, images) | Normal output with `download_url` |
| Computational results | Normal output in the JSON |
| OAuth tokens, refresh tokens | ✅ Internal API — not in the output |
| API keys obtained dynamically | ✅ Internal API — not in the output |
| Passwords, secrets | ✅ Internal API — not in the output |

---

## 10b. Query on datasource (SQL, MongoDB, Redis, file-share)

`POST /internal/datasources/:id/query`

Runs an operation against the datasource configured by the user. The endpoint picks the driver
based on the datasource's **engine**/family:
- **relational** (PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite) → `sql` field;
- **document** (MongoDB) → `mongo` field with the operation spec;
- **key-value** (Redis) → `redis` field with `{ command, args }`;
- **file-share** (SMB/CIFS, SFTP, WebDAV) → `file` field with `{ op, path, ... }`.

`id` = the datasource UUID (config var `type: datasource`, with optional `family` to filter
the dropdown — see [section 2](#2-skillmd--frontmatter--full-schema)).

> 🔐 **Auth & scope:** the call uses the run token (`x-internal-token`); the backend
> verifies that the run's identity has access to the datasource **scope** (personal/team/org).

### Request — relational (`sql`)

```json
{
  "sql":    "SELECT * FROM orders WHERE user_id = ? AND status = ?",
  "params": ["user-123", "pending"],
  "limit":  100
}
```

| Field | Type | Required | Notes |
|---|---|:---:|---|
| `sql` | string | ✅ (relational) | SQL query with `?` / `$N` placeholders (translated and bound by the dialect driver) |
| `params` | array | ❌ | Positional values — **never interpolated into the query** (prepared statements) |
| `limit` | number | ❌ | Max 10,000 — applies the limit in the dialect syntax (LIMIT / TOP / FETCH FIRST) |

### Request — MongoDB (`mongo`)

```json
{
  "mongo": {
    "collection": "orders",
    "op":         "find",
    "filter":     { "userId": "user-123", "status": "pending" },
    "projection": { "_id": 0, "total": 1 },
    "limit":      100
  }
}
```

| `mongo.*` field | Notes |
|---|---|
| `collection`, `op` | required. `op` ∈ find / aggregate / countDocuments / distinct / insertOne / insertMany / updateOne / updateMany / deleteOne / deleteMany |
| `filter`, `pipeline`, `projection`, `sort`, `update`, `document(s)`, `field`, `limit` | depending on the operation |

### Request — Redis (`redis`)

```json
{
  "redis": { "command": "HGETALL", "args": ["user:42"] }
}
```

| `redis.*` field | Notes |
|---|---|
| `command` | required. Redis command (GET, HGETALL, LRANGE, SCAN, SET, …) |
| `args` | array of command arguments |

### Request — file-share (`file`)

```json
{
  "file": { "op": "read", "path": "documenti/report.txt" }
}
```

| `file.*` field | Notes |
|---|---|
| `op` | required: `list` / `read` / `write` / `delete` |
| `path` | path **relative to the base** of the share (path-traversal guard on the backend side) |
| `content` | base64 (only for `op: write`) |
| `recursive` | boolean (only for `op: delete` on a folder) |

Response in `rows`: `list` → list of `{name,path,type,size,mtime}`; `read` → `[{path,content(base64),size,encoding}]`
(max 10 MB); `write`/`delete` → `[{path, ok:true}]`.

> The endpoint applies **ownership/scope** on the run token's identity (see above).
> The read-only / opt-in capabilities apply instead to the `sql`/`mongo` **tools** used by the agent.

### Response

```json
{ "rows": [...], "count": 42, "engine": "mysql" }
```

### Python template

```python
import os, json, urllib.request

DATASOURCE_ID = _config.get('DATASOURCE_ID', '')  # config var — from stdin _config, NOT env

def query_datasource(sql: str, params=None, limit=None) -> list:
    body = json.dumps({'sql': sql, 'params': params or [], 'limit': limit}).encode()
    url  = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/datasources/{DATASOURCE_ID}/query"
    req  = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type':       'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())['rows']

# Usage in the script — DATASOURCE_ID comes from os.environ, no input parameters needed
rows = query_datasource('SELECT * FROM products WHERE active = ?', [1], limit=50)
```

### Node.js template

```javascript
const http = require('http');

const DATASOURCE_ID = _config.DATASOURCE_ID ?? '';  // config var — from stdin _config, NOT env

async function queryDatasource(sql, params = [], limit = null) {
    const body = JSON.stringify({ sql, params, limit });
    const url  = new URL(`/internal/datasources/${DATASOURCE_ID}/query`,
                         process.env.BACKEND_INTERNAL_URL);
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json',
                       'x-internal-token': process.env.INTERNAL_TOKEN },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data).rows));
        });
        req.on('error', reject);
        req.end(body);
    });
}

// Usage — DATASOURCE_ID comes from process.env, not needed as an input parameter
const rows = await queryDatasource('SELECT * FROM products WHERE active = ?', [1], 50);
```

> The endpoint is authenticated by the signed run token (`x-internal-token`), which carries the
> verified identity of the run's user; on that identity the backend applies the resource scope.

---

## 10c. Semantic search in the vector store

`POST /internal/vector/search`

Semantic search on a Qdrant collection. The backend takes care of embedding `query_text`.

### Request

```json
{
  "collection":      "my-collection",
  "query_text":      "waterproof running shoes",
  "limit":           15,
  "score_threshold": 0.7
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `collection` | string | — | Name of the Qdrant collection |
| `query_text` | string | — | Text to embed and search |
| `limit` | number | 15 | Max 200 results |
| `score_threshold` | number | 0.0 | Filters out results below the threshold (0–1) |

### Response

```json
{
  "results": [
    { "id": "uuid", "score": 0.92, "payload": { "text": "...", "source": "..." } }
  ],
  "count": 3
}
```

### Python template

```python
import os, json, urllib.request

VECTOR_COLLECTION = _config.get('VECTOR_COLLECTION', '')  # config var — from stdin _config, NOT env

def vector_search(query: str, limit=15, threshold=0.7) -> list:
    body = json.dumps({
        'collection':      VECTOR_COLLECTION,
        'query_text':      query,
        'limit':           limit,
        'score_threshold': threshold,
    }).encode()
    url = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/vector/search"
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type':       'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())['results']

# Usage — VECTOR_COLLECTION comes from os.environ, not needed as an input parameter
results = vector_search(data.get('query'), limit=10, threshold=0.75)
for r in results:
    print(r['payload'].get('text', ''), r['score'])
```

---

## 10d. Indexing data in the vector store

`POST /internal/vector/ingest`

Batch-indexes a list of items into the collection (embedding + upsert in Qdrant).
With `recreate=true` it recreates the collection from scratch (full refresh).

### Request

```json
{
  "collection": "my-collection",
  "recreate":   false,
  "items": [
    { "id": "item-1", "text": "text to index", "payload": { "source": "doc.pdf" } }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `collection` | string | Name of the collection |
| `recreate` | boolean | Default `false` — with `true` it deletes and recreates the collection |
| `items[].id` | string | Unique item ID (used as `_item_id` in the payload) |
| `items[].text` | string | Text to embed |
| `items[].payload` | object | Optional metadata stored alongside the vector |

Embeddings are generated in batches of 50 items at a time.

### Response

```json
{ "indexed": 42, "errors": 0, "collection": "my-collection" }
```

### Python template

```python
import os, json, urllib.request

VECTOR_COLLECTION = _config.get('VECTOR_COLLECTION', '')  # config var — from stdin _config, NOT env

def vector_ingest(items: list, recreate=False) -> dict:
    body = json.dumps({'collection': VECTOR_COLLECTION, 'recreate': recreate, 'items': items}).encode()
    url  = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/vector/ingest"
    req  = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type':       'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Combined use with query_datasource — index a product catalog from SQL
rows = query_datasource('SELECT id, name, description FROM products', limit=1000)
items = [
    {'id': str(r['id']), 'text': f"{r['name']}: {r['description']}", 'payload': {'name': r['name']}}
    for r in rows
]
result = vector_ingest(items, recreate=True)
# result = { "indexed": 150, "errors": 0, "collection": "prodotti" }
```

---

## 10e. Indexing a DataSource file (full pipeline)

`POST /internal/embed/datasource`

Different from [§10d](#10d-indexing-data-in-the-vector-store): here the skill **neither reads nor extracts** anything.
It only provides `(source, path)` and the whole pipeline is the backend's: reading the file from the
DataSource, text extraction (PDF/DOCX/XLSX/OCR), chunking, embedding and upsert into the vector store.

It is the same capability as `POST /api/embed/datasource`, exposed to the skill via the run token.
Indexing is **queued (asynchronous)**: the endpoint returns immediately and the user is
notified when the job finishes. The identity is the run's (`USER_ID`); the scope check on access
to the source is applied inside the backend (no escalation).

### Request

```json
{
  "source":     "uuid-of-the-datasource",
  "path":       "documenti/report-2026.pdf",
  "collection": "my-collection"
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `source` | string | — | ID of the DataSource (file-share) or `local` for the local fileshare |
| `path` | string | — | Path of the file inside the source |
| `collection` | string | _(opt.)_ | Destination collection; if omitted, the backend uses the default one |

> `source` follows the same semantics as the `DATASOURCE_ID` of [§10b](#10b-query-on-datasource-sql-mongodb-redis-file-share):
> put it in a **config var** (DataSource dropdown in the UI) and read it from `_config`, or use `local`.

### Response

Indexing is asynchronous: it normally returns `queued`. For small files it may return `inline`.

```json
{ "status": "queued", "jobId": "42", "filename": "report-2026.pdf" }
```

```json
{ "status": "inline", "chunks": 18, "collection": "my-collection", "filename": "report-2026.pdf" }
```

### Python template

```python
import os, json, urllib.request

def embed_datasource(source: str, path: str, collection: str = None) -> dict:
    body = {'source': source, 'path': path}
    if collection:
        body['collection'] = collection
    url = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/embed/datasource"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
        'Content-Type':     'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Usage — source from a DataSource config var (or 'local'); path from input
DATASOURCE_ID = data.get('_config', {}).get('DATASOURCE_ID', 'local')
res = embed_datasource(DATASOURCE_ID, data['path'])
# res = { "status": "queued", "jobId": "42", "filename": "report-2026.pdf" }
print("Indexing started, you will receive a notification when the job finishes.")
```

---

## 10f. Searching the user's files (access-scoped)

`GET /internal/files/search`

Searches through the run user's files in an **access-aware** way: it returns only the files
visible to that identity (respecting the personal/team/org/project scope). It is the
**correct** way for a skill to find the user's files — do **not** scan the
filesystem, which would expose files of other tenants.

### Request (query string)

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `userId` | string | — | **Required.** Use the run's `USER_ID` env (the identity the skill runs for) |
| `q` | string | `""` | Filter on the filename (partial match); empty = all readable files |
| `limit` | number | 50 | Maximum number of results |

### Response

```json
[
  {
    "id":           "uuid",
    "filename":     "report-2026.pdf",
    "rel":          "abcd/report-2026.pdf",
    "download_url": "abcd/report-2026.pdf",
    "size_bytes":   84213,
    "scope":        "personal",
    "modified_at":  "2026-06-15T10:22:00.000Z"
  }
]
```

> `download_url` / `rel` is the relative path for the authenticated download (`?rel=`): see
> [§7 — download_url rule](#7-skillmd--instructions-for-the-llm). To re-index one
> of these files combine it with [§10e](#10e-indexing-a-datasource-file-full-pipeline).

### Python template

```python
import os, json, urllib.request, urllib.parse

def search_files(query: str = '', limit: int = 50) -> list:
    user_id = os.environ.get('USER_ID', '')
    if not user_id:
        return []  # run without identity → no access (fail-closed)
    qs  = urllib.parse.urlencode({'userId': user_id, 'q': query, 'limit': limit})
    url = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/files/search?{qs}"
    req = urllib.request.Request(url, method='GET', headers={
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Usage
for f in search_files(data.get('query', ''), limit=20):
    print(f['filename'], f['download_url'])
```

---

## 10g. Invoking another skill (inter-skill)

`POST /internal/skills/:id/invoke`

Allows a script to **invoke another skill as a service**, without going through
the LangGraph agent. Useful for composing skills (e.g. a "pipeline" skill that orchestrates
an extraction skill + a reporting skill).

**Constraints:** the target skill must have `status='ready'`; the invoked script must be
`mode='task'` (not `daemon`); the `input` must comply with the `input_schema` declared in the
`SKILL.md` frontmatter (runtime.scripts) of the target skill.

### Request

```json
{
  "script":     "recommend.py",
  "input":      { "seed_categories": ["running", "trail"] },
  "timeout_ms": 30000
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `script` | string | — | Filename of the script to run (with or without the `scripts/` prefix) |
| `input` | object | `{}` | Parameters passed to the script via stdin (must match the `input_schema`) |
| `timeout_ms` | number | 30000 | Execution timeout (min 1000); increase it for long operations |

`:id` is the UUID of the target skill (pass it as a **config var**, e.g. `TARGET_SKILL_ID`).

### Response

```json
{ "success": true, "output": { "...": "..." }, "raw": "...", "duration_ms": 123, "exit_code": 0 }
```

If the script errors (`exit_code != 0`) the response stays HTTP 200 with `success: false`:

```json
{ "success": false, "output": null, "raw": "", "exit_code": 1, "stderr": "Traceback ...", "duration_ms": 50 }
```

> Other codes: **404** skill not found or not `ready` · **400** nonexistent script / daemon / malformed input · **503** skill-executor unreachable.

### Python template

```python
import os, json, urllib.request

def invoke_skill(skill_id: str, script: str, payload: dict, timeout_ms: int = 30000) -> dict:
    body = json.dumps({'script': script, 'input': payload, 'timeout_ms': timeout_ms}).encode()
    url  = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/skills/{skill_id}/invoke"
    req  = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type':     'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Usage — TARGET_SKILL_ID from a config var
target = data.get('_config', {}).get('TARGET_SKILL_ID', '')
res = invoke_skill(target, 'recommend.py', {'seed_categories': ['running']})
if res['success']:
    print(json.dumps(res['output']))
else:
    print('Invoked skill failed:', res.get('stderr', '')[:500])
```

---

## 11. System dependencies (Nix)

The executor integrates [Nix](https://nixos.org/), a package manager that installs system tools
**isolated per skill**, without version conflicts and without requiring root privileges.

### How it works

```
Upload ZIP
  ↓ backend calls POST /install with nix_deps: ["cowsay", "ffmpeg"]
  ↓ executor: nix profile install nixpkgs#cowsay nixpkgs#ffmpeg \
                 --profile /app/skills/{id}/.nix
  ↓ .nix/bin/cowsay  →  symlink to /nix/store/hash.../bin/cowsay
  ↓ status: ready

Running a script
  ↓ runner prepends PATH = .nix/bin : original PATH
  ↓ subprocess.run(['cowsay', ...])  →  finds the Nix binary ✅
```

Each skill has its own **isolated Nix profile** in `.nix/`:
```
/app/skills/
├── skill-abc/
│   ├── scripts/
│   ├── .deps/python/          ← pip packages
│   └── .nix/                  ← isolated Nix profile
│       └── bin/
│           ├── cowsay         → /nix/store/ybkwq4z...-cowsay-3.7/bin/cowsay
│           └── convert        → /nix/store/m3x9p2q...-imagemagick-7.1/bin/convert
└── skill-def/
    └── .nix/                  ← different versions, no conflict
```

### Declaring Nix dependencies in the frontmatter (runtime.dependencies.system.nix)

```yaml
dependencies:
  python: [requests>=2.31]         # pip, as always
  system:
    nix:
      - cowsay                     # package name in nixpkgs
      - imagemagick
      - ffmpeg
      - pandoc
```

> Search for package names on [search.nixos.org](https://search.nixos.org/packages).
> The name to use is the value in the **"Attribute name"** field (e.g. `python3Packages.requests`).

### Using Nix tools in scripts

```python
# Python — subprocess calls the Nix binary (already in the PATH)
import subprocess, sys, json

def main():
    data    = json.load(sys.stdin)
    testo   = data.get('testo', 'hello')

    result = subprocess.run(
        ['cowsay', testo],
        capture_output=True, text=True, check=True
    )
    print(json.dumps({ 'success': True, 'output': result.stdout }))

if __name__ == '__main__':
    try: main()
    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'stack': traceback.format_exc()}))
        sys.exit(1)
```

```javascript
// Node.js — execFile calls the Nix binary
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');

async function main() {
    const data  = JSON.parse(fs.readFileSync(0, 'utf8'));
    const testo = data.testo ?? 'hello';

    const { stdout } = await execFileAsync('cowsay', [testo]);
    console.log(JSON.stringify({ success: true, output: stdout }));
}
main().catch(e => { console.log(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
```

### Package names — common examples

| Tool | nixpkgs name | Notes |
|---|---|---|
| ImageMagick | `imagemagick` | `convert`, `mogrify`, `identify` |
| FFmpeg | `ffmpeg` | `ffmpeg`, `ffprobe` |
| Pandoc | `pandoc` | document conversion |
| Ghostscript | `ghostscript` | PDF manipulation |
| `cowsay` | `cowsay` | — |
| `boxes` | `boxes` | — |
| `toilet` | `toilet` | — |
| SQLite CLI | `sqlite` | `sqlite3` |
| `jq` | `jq` | — |
| `poppler` | `poppler_utils` | `pdftotext`, `pdfinfo` |
| `wkhtmltopdf` | `wkhtmltopdf` | HTML → PDF via WebKit |

### Constraints and operational notes

**Persistence:** the Nix store (`/nix`) is mounted as a Docker named volume (`nix_store`).
Packages survive container rebuilds — they are re-downloaded only if the volume
is deleted manually.

**First install:** on the first startup with an empty volume, the entrypoint installs Nix (~2 min).
Subsequent installations are instant thanks to the volume cache.

**Cleanup:** when a skill is deleted, its `.nix/` directory (the symlinks) is
removed automatically along with the rest. The paths in `/nix/store` remain until you
run `nix-collect-garbage` (periodic volume maintenance).

**nixpkgs only:** for security, only simple `nixpkgs` package names are allowed
(e.g. `cowsay`, `python3Packages.requests`). Arbitrary URLs, GitHub flakes and local paths
are blocked by the validation in `install.ts`.

---

## 12. Daemon scripts (background / watch)

A daemon is a script with `mode: daemon` in the `SKILL.md` frontmatter. It runs as a
long-running background process and communicates with the backend via HTTP push events —
it returns nothing on stdout and is never called by the LLM.

### Protocol

```
Startup
  ↓ executor launches the process and passes _config via stdin (JSON)
  ↓ process reads stdin, initializes
  ↓ monitoring loop
      → detects an event → POST PUSH_URL (JSON)
      → waits for the configured interval
  ↓ SIGTERM received → graceful shutdown → process terminates
```

### Available environment variables

| Variable | Description |
|---|---|
| `PUSH_URL` | Full URL to send events to (`POST`) |
| `DAEMON_ID` | Daemon UUID (included in every event) |
| `SKILL_ID` | Skill UUID (included in every event) |
| `USER_ID` | Owner user ID (included in every event) |
| `INTERNAL_TOKEN` | `x-internal-token` header required by `PUSH_URL` |

### Event format (POST to PUSH_URL)

```json
{
  "skill_id":   "uuid-skill",
  "user_id":    "uuid-user",
  "daemon_id":  "uuid-daemon",
  "event_type": "event_name",
  "payload":    { "key": "value" }
}
```

The `event_type` field is free-form. Recommended conventions:

| `event_type` | When to emit it | Typical payload |
|---|---|---|
| `custom_name` | Skill-specific event | Any JSON object |
| `auth_error` | Expired token / critical authentication error | `{ "error": "message" }` |
| `daemon_exit` | Right before terminating due to error | `{ "exit_code": 1 }` — usually emitted automatically by the executor |

> **`daemon_exit`** is emitted automatically by the executor when the process terminates.
> You do not need to emit it manually unless you want to do so before `sys.exit()`.

### Python template

```python
#!/usr/bin/env python3
"""
watcher.py — background daemon.

Protocol:
  1. Read _config from stdin JSON at startup
  2. Initialize resources (API clients, connections, etc.)
  3. Loop: monitor → push_event() → wait
  4. SIGTERM / SIGINT → _running = False → clean exit
"""
import sys, json, os, time, signal, logging, urllib.request

# ── Logging to stderr (does not pollute stdout) ────────────────────────────────
logging.basicConfig(stream=sys.stderr, level=logging.INFO,
    format='[watcher] %(asctime)s %(levelname)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('watcher')

# ── Variables injected by the executor ────────────────────────────────────────
PUSH_URL     = os.environ.get('PUSH_URL', '')
DAEMON_ID    = os.environ.get('DAEMON_ID', '')
SKILL_ID     = os.environ.get('SKILL_ID', '')
USER_ID      = os.environ.get('USER_ID', '')
INTERNAL_KEY = os.environ.get('INTERNAL_TOKEN', '')

# ── Graceful shutdown ──────────────────────────────────────────────────────────
_running = True

def _handle_signal(sig, frame):
    global _running
    log.info(f'Signal {sig} received — shutting down...')
    _running = False

signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT,  _handle_signal)

# ── Push event ───────────────────────────────────────────────────────────────
def push_event(event_type: str, payload: dict) -> None:
    """Sends an event to the backend via PUSH_URL."""
    if not PUSH_URL:
        log.warning('PUSH_URL not configured — event ignored')
        return
    body = json.dumps({
        'skill_id':   SKILL_ID,
        'user_id':    USER_ID,
        'daemon_id':  DAEMON_ID,
        'event_type': event_type,
        'payload':    payload,
    }).encode('utf-8')
    req = urllib.request.Request(PUSH_URL, data=body, method='POST', headers={
        'Content-Type':       'application/json',
        'x-internal-token': INTERNAL_KEY,
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            log.debug(f'Event {event_type} sent (HTTP {resp.status})')
    except Exception as e:
        log.warning(f'Error sending event {event_type}: {e}')

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    # 1. Read _config from stdin
    try:
        raw  = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        log.error(f'Error reading stdin: {e}')
        sys.exit(1)

    cfg = data.get('_config', {})

    # 2. Read configuration (values from config + fallback to defaults)
    api_key       = cfg.get('MY_API_KEY', '')
    poll_interval = int(cfg.get('MY_POLL_INTERVAL') or 30)

    if not api_key:
        log.error('MY_API_KEY not configured')
        sys.exit(1)

    if not PUSH_URL:
        log.error('PUSH_URL not available')
        sys.exit(1)

    log.info(f'Daemon started (polling every {poll_interval}s)')

    # 3. Main loop
    while _running:
        time.sleep(poll_interval)
        if not _running:
            break

        try:
            # --- monitoring logic ---
            nuovi_elementi = controlla_aggiornamenti(api_key)  # replace with your logic

            if nuovi_elementi:
                push_event('nuovi_elementi', {
                    'count': len(nuovi_elementi),
                    'items': nuovi_elementi,
                })

        except Exception as e:
            log.error(f'Error during polling: {e}')
            # Critical, unrecoverable errors → emit auth_error / terminate
            if 'unauthorized' in str(e).lower() or 'invalid_grant' in str(e).lower():
                push_event('auth_error', {'error': str(e)})
                sys.exit(1)
            # Transient errors (network, rate limit) → keep looping

    log.info('Daemon terminated')

if __name__ == '__main__':
    main()
```

### Reading `GMAIL_POLL_INTERVAL` (or any config) from `_config`

The user-configurable variables in `runtime.config` (SKILL.md frontmatter) are injected
into `_config` (read from stdin), **not** into the environment variables.
Always read them from `cfg = data.get('_config', {})`:

```python
# ✅ Correct — reads from the skill's config (user-configurable in the UI)
poll_interval = int(cfg.get('MY_POLL_INTERVAL') or os.environ.get('MY_POLL_INTERVAL') or 30)

# ❌ Wrong — os.environ does not contain the skill's config
poll_interval = int(os.environ.get('MY_POLL_INTERVAL', 30))
```

### Common errors

| Error | Cause | Solution |
|--------|-------|-----------|
| Daemon terminates immediately | Incomplete `_config` | Validate required fields at startup and `sys.exit(1)` with a clear log |
| `PUSH_URL` empty | Script started outside the executor | Check that `mode: daemon` is in the `SKILL.md` frontmatter |
| Event push silently fails | Missing `x-internal-token` header | Always use `INTERNAL_KEY` in the request header |
| Token expired in loop | Error not handled as critical | Distinguish transient errors (continue) from critical ones (emit `auth_error` + `sys.exit(1)`) |

---

## 13. Enabling/disabling a skill

Each skill has an `enabled` flag (boolean, default `true`). You can disable it from the UI
(switch in the skill drawer, "My skills" tab) or via API:

```http
PATCH /api/skills/:id/enabled
Authorization: Bearer <jwt>
Content-Type: application/json

{ "enabled": false }
```

Allowed for the skill owner or an admin. Applies to any scope (`personal` / `team` / `org`).

**Immediate effects:**
- The skill is **not loaded** as a tool by the agent on the next request
- Its `SKILL.md` is **not included** in the system prompt (filter in `buildSkillSystemPromptSelective`)
- The skill remains in the DB and keeps its configuration, scripts and project assignments
- It can be re-enabled at any time with `{ "enabled": true }`

> **Use case:** a skill under maintenance, a costly skill to activate only when needed,
> a skill in testing before admin approval.

---

## 14. Uploading, testing and publishing the skill

### Flow — Manual upload

1. **Create the ZIP package** from the skill's root directory
2. **Upload:** Settings → Skills → "My skills" tab → Upload ZIP
3. **Wait for installation** — the badge shows `installing`, then `ready` (or `error`)
   - If `error`: click the badge → full installation log
   - Use "Reinstall" to retry without re-uploading the ZIP
4. **Configure the variables** — in the skill drawer → "Configure" tab
5. **Assign to projects** — "Assign" tab → select the projects
6. **Test in the chat** of an assigned project

### Flow — Installation from the marketplace

**Public GitHub registry:**
1. Same "Public skills" tab — the section shows the skills from the configured registry
2. Search by name, description, author or tag
3. Click **"Install"** — the backend downloads the ZIP from GitHub and installs it
4. The badge shows `installing...` → then `ready`

### Sharing a skill (internal use)

1. The skill must be in `ready` status
2. Skill drawer → **Visibility** → choose the scope:
   - **Team** → the skill is published **immediately** to the team members (no review); you can do this if you are the **team owner** or an admin
   - **Org** → the scope becomes `org` (pending review)
3. (Only `org`) the admin approves from the "Review" tab → the skill appears for all users
4. To withdraw it: set the scope back to **Personal**

### Testing the script directly (without the UI)

```bash
# Call the executor directly (port configured in .env.executor, default 4000)
curl -X POST http://localhost:4000/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "skill_id": "uuid-of-the-skill",
    "filename": "scripts/main.py",
    "language": "python",
    "input": { "titolo": "Test", "righe": [{"voce": "Prodotto", "importo": 100}] },
    "config": { "OUTPUT_DIR": "/tmp/test-output" },
    "timeout_ms": 30000
  }'
```

**Executor HTTP codes:**

| Code | When |
|--------|--------|
| `200` | Execution completed successfully (`exit_code: 0`) |
| `201` | Daemon started successfully |
| `400` | Malformed request or unsupported language |
| `404` | Daemon not found |
| `422` | Script terminated with an error (`exit_code ≠ 0`); the body contains `stdout`/`stderr` |
| `429` | Too many scripts running simultaneously (`MAX_CONCURRENT` reached) |
| `500` | Internal executor error (spawn failed, etc.) |

> When a script **times out**, the executor sends `SIGKILL` to the process and returns `exit_code: 124` with `stderr` prefixed by `[KILLED: timeout Nms]`.

---

## 15. GitHub registry (contributing)

The registry is a public GitHub repository (configurable via `SKILLS_REGISTRY_URL` in the backend `.env`). To publish a skill:

### Registry repository structure

```
skills/
├── registry.json               ← index of all skills
└── skills/
    └── nome-skill/
        ├── nome-skill-v1.0.0.zip
        └── README.md
```

### registry.json format

```json
{
  "version": "1",
  "updatedAt": "2026-05-23T00:00:00Z",
  "skills": [
    {
      "name":        "nome-skill",
      "version":     "1.0.0",
      "description": "Description for the marketplace",
      "author":      "Your Name",
      "license":     "MIT",
      "languages":   ["python"],
      "tags":        ["pdf", "report"],
      "scriptCount": 1,
      "dependencies": { "python": ["fpdf2>=2.7"], "javascript": [] },
      "downloadUrl": "https://raw.githubusercontent.com/githubUser/skills/main/skills/my-skill/1.0.0/my-skill-1.0.0.zip",
      "homepage": "https://github.com/githubUser/skills/tree/main/skills/my-skill",
      "publishedAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

### Custom registry (self-hosted or corporate)

```bash
# .env (root)
SKILLS_REGISTRY_URL=https://raw.githubusercontent.com/mia-org/skills/main/registry.json
SKILLS_REGISTRY_CACHE_TTL_MS=600000          # cache TTL (default 5 min)
SKILLS_REGISTRY_ALLOWED_DOMAINS=cdn.mia-org.com  # extra domains for ZIP downloads
```

---

## 16. Common patterns

### PDF with a table (Python, fpdf2)

```yaml
# SKILL.md — frontmatter
runtime:
  dependencies:
    python: [fpdf2>=2.7]
  scripts:
    - filename: scripts/main.py
      language: python
      input_schema:
        type: object
        required: [title, rows]
        properties:
          title: { type: string }
          rows:  { type: array, description: "List of {voce, importo}" }
```

```python
# scripts/main.py
from fpdf import FPDF
import sys, json, os
from urllib.parse import quote as _quote

def safe_text(t):
    import unicodedata
    _MAP = str.maketrans({"‘":"'","’":"'","“":'"',"”":'"',
                          "–":"-","—":"--","€":"EUR"})
    t = str(t or "").translate(_MAP)
    t = unicodedata.normalize("NFC", t)
    return t.encode("latin-1", errors="replace").decode("latin-1")

def main():
    data    = json.load(sys.stdin)
    _config = data.get("_config", {})
    title   = data.get("title", "Documento")
    rows    = data.get("rows", [])
    upload_dir = os.path.abspath(_config.get("UPLOAD_DIR", "./uploads"))
    output_dir = os.path.abspath(_config.get("OUTPUT_DIR", os.path.join(upload_dir, "skills-output")))
    os.makedirs(output_dir, exist_ok=True)

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, safe_text(title), ln=True)
    pdf.set_font("Helvetica", size=11)
    for r in rows:
        pdf.cell(0, 8, safe_text(f"{r.get('voce','')}  {r.get('importo','')}"), ln=True)

    import time
    fname    = f"report_{int(time.time())}.pdf"
    out_path = os.path.join(output_dir, fname)
    pdf.output(out_path)

    rel = os.path.relpath(out_path, upload_dir)
    print(json.dumps({
        "success": True, "filename": fname,
        "download_url": f"/api/files/raw?rel={_quote(rel)}",
        "size_bytes": os.path.getsize(out_path),
        "message": f"PDF '{title}' generated. Download: /api/files/raw?rel={_quote(rel)}"
    }))

if __name__ == "__main__":
    try: main()
    except Exception as e:
        import traceback
        print(json.dumps({"success": False, "error": str(e), "stack": traceback.format_exc()}))
        sys.exit(1)
```

---

### PDF from HTML (Node.js, Puppeteer)

```yaml
# SKILL.md — frontmatter
runtime:
  dependencies:
    javascript: [puppeteer@22]
  scripts:
    - filename: scripts/generate.js
      language: node
      input_schema:
        type: object
        required: [title, content]
        properties:
          title:   { type: string, description: "Title (plain text)" }
          content: { type: string, description: "HTML body" }
```

```javascript
// scripts/generate.js
'use strict';
const fs   = require('fs');
const path = require('path');

async function main() {
    const data      = JSON.parse(fs.readFileSync(0, 'utf8'));
    const _config   = data._config ?? {};
    const title     = data.title ?? 'Documento';
    const content   = data.content ?? '';
    const uploadDir = _config.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
    const outputDir = _config.OUTPUT_DIR ?? path.join(uploadDir, 'skills-output');
    fs.mkdirSync(outputDir, { recursive: true });

    const puppeteer = require('puppeteer');
    const browser   = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>body{font-family:Arial;padding:40px;} h1{color:#1a56db;}</style>
        </head><body><h1>${title}</h1>${content}</body></html>`,
        { waitUntil: 'networkidle0' });

    const fname   = `doc_${Date.now()}.pdf`;
    const outPath = path.join(outputDir, fname);
    await page.pdf({ path: outPath, format: 'A4', printBackground: true });
    await browser.close();

    const relPath    = path.relative(uploadDir, outPath).replace(/\\/g, '/');
    const downloadUrl = `/api/files/raw?rel=${encodeURIComponent(relPath)}`;
    console.log(JSON.stringify({
        success: true, filename: fname, download_url: downloadUrl,
        size_bytes: fs.statSync(outPath).size,
        message: `PDF generated. Download: ${downloadUrl}`
    }));
}
main().catch(e => { console.log(JSON.stringify({success:false,error:e.message})); process.exit(1); });
```

---

### Calling an external API (Python)

```yaml
config:
  - key: API_KEY
    description: "API key"
    required: true
    secret: true
```

```python
import requests

api_key  = _config.get("API_KEY", "")
response = requests.get("https://api.example.com/data",
                        headers={"Authorization": f"Bearer {api_key}"})
result   = response.json()
```

---

## 17. Creating skills with AI assistance

Use this prompt in chat (or ask the agent directly):

**Oneshot skill (single script):**
```
Create a skill for Arkimede that [feature description].

Specs:
- Language: [python | node | javascript]
- Input: [list of fields with type and description]
- Output: [what it should return / which files to generate]
- Dependencies: [any PyPI or npm libraries]
- Configurations: [any configurable variables]

Generate:
1. SKILL.md: YAML frontmatter (name, description, runtime with deps/config/scripts+input_schema)
   + clear instructions for the LLM in the body (when to use it, ⚠️ download_url rule)
2. scripts/main.[py|js] working and testable

Follow these conventions:
- stdin/stdout JSON protocol
- _config for injected system variables
- download_url always with ?rel= (never an absolute path)
- safe_text() for text in Python PDFs (fpdf2)
- Node template: readFileSync(0,'utf8') → JSON.parse → console.log(JSON.stringify(...))
```

**Multi-script skill (with @tool markers):**
```
Create a skill for Arkimede with multiple scripts: [script_1.py, script_2.py, ...].

For each script:
- Separate description, input and output

Generate:
1. SKILL.md with frontmatter (runtime.scripts: all scripts + separate input_schema)
   and in the body the <!-- @tool: script_name.py --> markers for each script.
   Required structure:
   - Shared section (before the first marker): title, routing table (which script for which action)
   - One <!-- @tool: ... --> section per script: input, output, examples
3. All scripts working

⚠️ The name in the marker must match exactly the filename in runtime.scripts (without "scripts/").
```

**Skill with a daemon (watch/monitor):**
```
Create a skill for Arkimede that [feature description] and includes a monitoring
daemon that notifies the backend when [condition to monitor].

Daemon specs:
- Language: python
- Poll every: [N seconds, configurable]
- Emitted event: [event_name] with payload { [fields] }
- Critical errors: [when to terminate the daemon]
- Configurations: [required config variables, e.g. API_KEY, POLL_INTERVAL]

Generate:
1. SKILL.md with frontmatter runtime.scripts (mode: daemon for the background script) + runtime.config
2. SKILL.md with a daemon section (⚠️ NOT invoked by the LLM, push event format)
3. scripts/daemon_[name].py with: reading _config from stdin, graceful shutdown on SIGTERM,
   push_event() with x-internal-token header, handling transient vs critical errors
```

---

## Summary checklist

Before uploading the skill, verify:

**Oneshot script:**
- [ ] `SKILL.md` with frontmatter: `name`, `version`, `description`, `runtime.scripts`
- [ ] `SKILL.md` present with clear instructions and the `download_url` rule
- [ ] The SKILL.md **shared section** contains the callout with the canonical tool names (`skill_{name}_{script}`) and the "Never call" warning
- [ ] **Each script section** has the line `**Tool name (use this exact name):** \`skill_xxx_yyy\``
- [ ] Use the `<!-- @tool: script_name.py -->` marker for **every** script (even a single script), name without the `scripts/` prefix
- [ ] Each script returns JSON on stdout (last valid line)
- [ ] Paths of saved files computed with `os.path.abspath()` / `path.resolve()`
- [ ] `download_url` uses `?rel=` relative to `UPLOAD_DIR`
- [ ] No dependency on local paths in the output (no absolute filesystem paths in the final JSON)
- [ ] The script handles errors with `try/except` or `.catch()` and reports them in JSON
- [ ] **Sensitive data** (OAuth tokens, secrets): saved via the internal API, never in the script's output
- [ ] **System tools** declared in `dependencies.system.nix` (do not call undeclared binaries)

**Daemon script (in addition):**
- [ ] `mode: daemon` set in the `SKILL.md` frontmatter (runtime.scripts) for the background script
- [ ] The daemon reads `_config` from stdin at startup (not from `os.environ`)
- [ ] Configurable variables read from `cfg = data.get('_config', {})`, not from `os.environ`
- [ ] SIGTERM/SIGINT handling with `signal.signal()` for graceful shutdown
- [ ] `push_event()` always includes `skill_id`, `user_id`, `daemon_id`, `event_type`, `payload`
- [ ] `x-internal-token` header present in every request to `PUSH_URL`
- [ ] Critical errors (auth, missing config): `push_event('auth_error', ...)` + `sys.exit(1)`
- [ ] Transient errors (network, rate limit): log + keep looping (no exit)
- [ ] The SKILL.md states that the daemon must NOT be invoked by the LLM

---

## 18. Descriptive skills (agentskills.io), Sandbox and compilation

A skill can be **typed** or **descriptive** (`kind` field, derived at install time):

| | `typed` | `descriptive` |
|---|---|---|
| Frontmatter | has `runtime.scripts` with `input_schema` | **no** script manifest (only `name`/`description` + `scripts/`) |
| Exposure | each script is a **LangGraph tool** (typed RPC) | no tool: injected instructions, execution **via Sandbox** |
| Format | project extension | **"pure" agentskills.io** (portable 1:1) |

### Descriptive skills (pure agentskills.io format)

A folder with `SKILL.md` (minimal `name`+`description` frontmatter + instructions) and a `scripts/` (+ `references/`, `assets/`, any file). On use, the backend **stages** the skill's files into `/workspace/skills/<name>/` of the sandbox; the agent reads the instructions and runs the scripts from there with `run_in_sandbox` (e.g. `python skills/<name>/scripts/x.py`). Staging is **refreshed** if the skill is updated.

### Sandbox (`run_in_sandbox`)

A built-in tool to run **arbitrary code/shell** (`python`/`node`/`shell`) in an ephemeral hardened container-job, with a **per-chat persistent workspace** (files and installed deps persist across turns).

- **Enablement** (admin → Settings → AI → Sandbox): global master switch (default OFF) + team/project allowlist. Admin always allowed.
- **Isolation**: container-job via broker (cap-drop ALL, read-only, non-root uid, limits). **Fail-closed** without a broker (in-process only with `SANDBOX_ALLOW_INPROCESS=1`, dev).
- **Network**: `none` (default) | `egress` (allowlist proxy) | `open` (full internet). With `open` the agent installs deps at runtime: `pip install --user <pkg>` / `npm install <pkg>` (they persist in the workspace).
- **`apt`/system packages**: NOT installable (non-root container + read-only rootfs) — only language packages.
- **Hygiene**: per-TTL workspace GC, per-session disk quota, download of files generated from the chat.

### Compile to tool (descriptive → typed)

From the descriptive skill's drawer, **"Compile to tool"** asks the **AI** to infer an `input_schema` for each script (from the code + `SKILL.md`); you review/edit the proposal and **confirm**. The manifest is written into `runtime.scripts` in the `SKILL.md` frontmatter (source of truth, one-directional) and a reinstall promotes the skill to `typed`, exposing the scripts as typed tools. API: `POST /api/skills/:id/propose-compilation` → `POST /api/skills/:id/compile`.

---

*Version: May 2026 — includes Marketplace + GitHub Registry + internal APIs (secure config vars, SQL queries on datasource, semantic search and vector store indexing) + Daemon (background / watch) + JS sandbox with `input`/`config` globals + system dependencies via Nix + `@tool` markers for selective SKILL.md + **Enabled toggle** (enable/disable skills without deleting them) + **SSE file events** (automatic detection of files produced by tools via `onToolResult`) + **agentskills.io compat** (SKILL.md with frontmatter, descriptive skills) + **Sandbox** (`run_in_sandbox`: arbitrary code/shell, per-chat workspace, gated network) + **Compile to tool** (descriptive→typed, AI proposes + confirm)*
