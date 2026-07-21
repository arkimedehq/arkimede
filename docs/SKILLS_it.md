# Creare una Skill per Arkimede

Le **Skill** sono pacchetti ZIP che estendono l'AI con script Python o Node.js eseguibili.  
Il LLM decide autonomamente quando usarle, basandosi sulle istruzioni nel `SKILL.md`.

---

## Indice

1. [Struttura del pacchetto](#1-struttura-del-pacchetto)
2. [SKILL.md — frontmatter + schema completo](#2-skillmd--frontmatter--schema-completo)
3. [Scegliere il runner](#3-scegliere-il-runner)
4. [Script Python](#4-script-python)
5. [Script Node.js](#5-script-nodejs)
6. [Script JavaScript (sandbox)](#6-script-javascript-sandbox)
7. [SKILL.md — istruzioni per il LLM (+ marker @tool)](#7-skillmd--istruzioni-per-il-llm)
   - [7a. Template script singolo](#7a-template-skillmd--script-singolo)
   - [7b. Marker `@tool` — caricamento selettivo](#7b-marker-tool--caricamento-selettivo-per-skill-multi-script)
   - [7c. Nomi canonici dei tool — prevenire allucinazioni](#7c-nomi-canonici-dei-tool--prevenire-allucinazioni-su-modelli-piccoli)
8. [Variabili di sistema (_config)](#8-variabili-di-sistema-_config)
9. [Restituire file scaricabili](#9-restituire-file-scaricabili)
10. [API interne dagli script](#10-api-interne-dagli-script)
   - [10a. Salvare config vars (sicuro)](#10a-salvare-config-vars-sicuro)
   - [10b. Query SQL su datasource](#10b-query-sql-su-datasource)
   - [10c. Ricerca semantica nel vector store](#10c-ricerca-semantica-nel-vector-store)
   - [10d. Indicizzare dati nel vector store](#10d-indicizzare-dati-nel-vector-store)
   - [10e. Indicizzare un file di una DataSource (pipeline completa)](#10e-indicizzare-un-file-di-una-datasource-pipeline-completa)
   - [10f. Cercare i file dell'utente (access-scoped)](#10f-cercare-i-file-dellutente-access-scoped)
   - [10g. Invocare un'altra skill (inter-skill)](#10g-invocare-unaltra-skill-inter-skill)
11. [Dipendenze di sistema (Nix)](#11-dipendenze-di-sistema-nix)
12. [Script Daemon (background / watch)](#12-script-daemon-background--watch)
13. [Abilitare/disabilitare una skill](#13-abilitaredisabilitare-una-skill)
14. [Caricare, testare e pubblicare la skill](#14-caricare-testare-e-pubblicare-la-skill)
15. [Registry GitHub (contribuire)](#15-registry-github-contribuire)
16. [Pattern comuni](#16-pattern-comuni)
17. [Creare skill con l'aiuto dell'AI](#17-creare-skill-con-laiuto-dellai)
18. [Skill descrittive (agentskills.io), Sandbox e compilazione](#18-skill-descrittive-agentskillsio-sandbox-e-compilazione)

---

## 1. Struttura del pacchetto

```
my-skill.zip
├── SKILL.md          ← REQUIRED: frontmatter YAML (metadati + runtime) + istruzioni per il LLM
└── scripts/
    ├── main.py       ← script principale
    └── helpers.py    ← moduli importabili (opzionale)
```

**Creare il ZIP:**
```bash
cd /tmp/my-skill
zip -r /tmp/my-skill-v1.0.0.zip .
# Carica il file in Impostazioni → Skills → Upload ZIP
```

---

## 2. SKILL.md — frontmatter + schema completo

Il manifest vive nel **frontmatter YAML** in testa a `SKILL.md` (formato agentskills.io).
`name` e `description` sono campi **standard** — qualsiasi client compatibile li legge per
la discovery. Tutto ciò che riguarda l'esecuzione (dipendenze, rete, config, script) sta
sotto il blocco namespaced **`runtime:`**, che i client standard ignorano. Dopo la riga di
chiusura `---` seguono le istruzioni Markdown per il LLM.

```markdown
---
name: nome-skill              # kebab-case, univoco per utente
version: 1.0.0
description: >
  Descrizione per l'AI: cosa fa questa skill e quando usarla.
author: email@example.com
license: MIT

# ── Tutto l'eseguibile sotto `runtime` (estensione, ignorata dai client standard) ──
runtime:

  # ── Dipendenze ──────────────────────────────────────────────────────────
  dependencies:
    python:                   # pacchetti PyPI (per language: python)
      - requests>=2.31
      - pandas>=2.0
      - fpdf2>=2.7
    javascript:               # pacchetti npm (per language: node)
      - puppeteer@22
      - pdf-lib@1.17
    system:
      nix:                    # tool di sistema da nixpkgs — disponibili via subprocess
        - cowsay              # es. subprocess.run(['cowsay', 'ciao'])
        - imagemagick         # es. subprocess.run(['convert', 'in.png', 'out.jpg'])
        - ffmpeg              # es. subprocess.run(['ffmpeg', '-i', 'in.mp4', 'out.mp3'])

  # ── Egress di rete consentito (capability, C1) ────────────────────────────
  network:                    # domini a cui la skill può connettersi a run-time
    - api.open-meteo.com      # assente/[] = NESSUN egress (oltre ai registry per l'install)
    - api.weatherapi.com      # i sottodomini sono inclusi (es. .open-meteo.com)
  # Con l'egress-proxy attivo le connessioni a domini non dichiarati sono BLOCCATE a
  # livello di rete. Il backend interno (BACKEND_INTERNAL_URL) è SEMPRE raggiungibile (non
  # soggetto all'allowlist). NB: dichiara SOLO domini reali di endpoint HTTP, non scope OAuth.
  # Onorato in modo trasparente da skill/demoni SIA Python SIA Node — la piattaforma instrada
  #   il loro HTTP(S) dal proxy, quindi NON serve codice proxy nello script.
  # ⚠ Un redirect che passa a un dominio NON dichiarato viene bloccato → dichiara ogni dominio
  #   toccato dal flusso (es. api.x.com che fa 302 verso cdn.x.com richiede ENTRAMBI).
  # I domini dichiarati sono mostrati in UI (apri la skill → "Accesso di rete").
  # L'accesso a LAN/VPN/subnet NON si dichiara qui: un admin concede le "reti riservate"
  #   per-skill dalla UI (Settings → Skills → skill → Reti riservate).
  # Le skill DESCRITTIVE (agentskills.io) girano via il sandbox, la cui modalità di rete
  #   (none/egress/open) è un setting GLOBALE dell'admin; con 'egress' vale la stessa allowlist.

  # ── Accesso al filesystem (capability, C2) ────────────────────────────────
  filesystem: none            # none (default) | project | tenant | all
  # Ampiezza dell'accesso ai file dell'utente. Default `none` = la skill vede solo i file
  # che riceve esplicitamente (input `format: file-ref`) e la propria work dir. Il soffitto
  # resta SEMPRE legato ai diritti dell'identità che esegue il run. Approvato in review.

  # ── Variabili configurabili dall'utente nella UI ──────────────────────────
  config:
    - key: OUTPUT_DIR
      description: "Directory dove salvare i file generati"
      default: "${UPLOAD_DIR}/skills-output"   # ${VAR} interpolato con le system vars
      required: false
      secret: false
    - key: API_KEY
      description: "Chiave API esterna"
      required: true
      secret: true            # valore cifrato nel DB, non esposto nelle API
    # type: datasource → dropdown DataSource (salva UUID); `family` (opz.) filtra:
    #   relational | document | keyvalue | fileshare. type: collection → dropdown collection.
    # ⚠️ Si leggono da `_config` (NON env): cfg = data.get("_config", {}); ds = cfg.get("DATASOURCE_ID")
    - key: DATASOURCE_ID
      description: "DataSource da interrogare/usare"
      required: false
      type: datasource
      family: fileshare       # opzionale — ometti per mostrare tutte le DataSource
    - key: VECTOR_COLLECTION
      description: "Collection vettoriale per search/ingest"
      required: false
      type: collection

  # ── Script eseguibili ──────────────────────────────────────────────────────
  scripts:
    - filename: scripts/main.py
      language: python        # python | node | javascript
      mode: oneshot           # oneshot (default) | daemon — omettibile per script normali
      description: >
        Descrizione dettagliata per il LLM: cosa fa esattamente questo script,
        quando chiamarlo, cosa si aspetta in input, cosa restituisce.
      input_schema:
        type: object
        required:
          - titolo
        properties:
          titolo:
            type: string
            description: "Titolo del documento (testo puro)"
          righe:
            type: array
            description: "Lista di oggetti {voce, importo}"
          allegato:
            type: string
            format: file-ref    # copy-in: il backend AUTORIZZA il file (canAccess) e lo
            description: >       #   stagia nella work dir; lo script riceve un path locale.
              File da elaborare (rel path o fileId). Il valore passato allo script è il
              path locale (es. /work/inputs/allegato.pdf), non il path originale.

    - filename: scripts/watcher.py
      language: python
      mode: daemon            # processo long-running background — non invocato dal LLM
      description: >
        Processo background. Avviato tramite l'interfaccia daemon, non dal LLM.
        Emette eventi push al backend quando rileva cambiamenti.
---

# Nome Skill

Istruzioni per il LLM: quando usarla, regola `download_url`, esempi…
```

> **Compatibilità agentskills.io** — un client esterno legge solo `name`/`description`
> (+ il corpo Markdown sotto il frontmatter) e ignora `runtime`. Le skill restano così
> portabili nell'ecosistema, mentre il backend usa `runtime` per esporre gli script come tool.

> **`mode: daemon`** — lo script gira come processo long-running.
> Non compare mai tra gli strumenti disponibili al LLM.
> Si avvia e si ferma dall'interfaccia **Impostazioni → Skills → Background**.
> Vedi la [sezione 12](#12-script-daemon-background--watch) per il protocollo completo.

---

## 3. Scegliere il runner

| `language` | Runner | Dipendenze | Node.js API | Quando usarlo |
|---|---|---|:---:|---|
| `python`     | subprocess `python3`     | PyPI via `pip --target`           | ✗  | Data analysis, PDF con fpdf2, ML, operazioni file |
| `node`       | subprocess `node`        | npm via `npm install`             | ✅ | Puppeteer, PDF con librerie npm, scraping, `fs`/`https` |
| `javascript` | isolated-vm (V8 sandbox) | npm (solo CJS puri, no Node APIs) | ✗  | Computazione pura JSON; librerie CJS senza I/O nativo (es. lodash, csv-parse) |

> **Regola pratica:** se serve `require()` o una libreria npm → `node`. Se è Python → `python`. Se è JS puro senza librerie → `javascript`.

### Mode: oneshot vs daemon

| `mode` | Ciclo di vita | Invocato da | Output |
|--------|--------------|-------------|--------|
| `oneshot` _(default)_ | Avvia → elabora → termina | LLM via tool call | JSON su stdout |
| `daemon` | Gira in background fino allo stop esplicito | Interfaccia daemon / API | POST eventi a `PUSH_URL` |

Gli script `mode: daemon` non compaiono mai come strumenti disponibili al LLM.
Per il protocollo completo vedi la [sezione 12](#12-script-daemon-background--watch).

---

## 4. Script Python

### Template base

```python
#!/usr/bin/env python3
import sys
import json

def main():
    # Leggi input da stdin (JSON)
    data    = json.load(sys.stdin)
    _config = data.get('_config', {})    # variabili iniettate dal backend

    # Parametri di input
    titolo = data.get('titolo', 'Documento')

    # Variabili di configurazione
    upload_dir = _config.get('UPLOAD_DIR', '/app/uploads')
    output_dir = _config.get('OUTPUT_DIR', f"{upload_dir}/skills-output")
    app_name   = _config.get('APP_NAME', 'Arkimede')

    # ... logica ...

    # Output (ultima riga JSON valida su stdout = risultato)
    print(json.dumps({
        "success": True,
        "result":  "output della skill",
        "message": "Operazione completata con successo"
    }))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"success": False, "error": str(e), "stack": traceback.format_exc()}))
        sys.exit(1)
```

### Usare dipendenze PyPI

```python
# Dichiarate in SKILL.md → runtime.dependencies.python
# PYTHONPATH è impostato automaticamente dal runner
import pandas as pd
import requests

# Funziona senza installazioni manuali
df = pd.read_csv('data.csv')
```

### Testo Unicode sicuro (per PDF con fpdf2)

I font standard di fpdf2 (Helvetica/Arial) supportano solo Latin-1. Usa questa funzione:

```python
import unicodedata

_UNICODE_MAP = str.maketrans({
    "‘": "'", "’": "'",   # virgolette singole
    "“": '"', "”": '"',   # virgolette doppie
    "–": "-", "—": "--",  # trattini
    "…": "...", "•": "-", # ellissi, bullet
    "€": "EUR", "®": "(R)", "©": "(C)", "™": "TM",
})

def safe_text(text) -> str:
    """Converte testo in stringa Latin-1 sicura per fpdf2."""
    text = str(text) if text is not None else ""
    text = text.translate(_UNICODE_MAP)
    text = unicodedata.normalize("NFC", text)
    return text.encode("latin-1", errors="replace").decode("latin-1")

# Utilizzo
pdf.cell(0, 8, safe_text(titolo))
```

> Le lettere italiane (à è é ì ò ù) sono già in Latin-1 e non richiedono conversione.

---

## 5. Script Node.js

### Template base

```javascript
'use strict';
const fs   = require('fs');
const path = require('path');

async function main() {
    // Leggi input da stdin
    const raw     = fs.readFileSync(0, 'utf8');
    const data    = JSON.parse(raw);
    const _config = data._config ?? {};

    // Parametri di input
    const titolo = data.titolo ?? 'Documento';

    // Variabili di configurazione
    const uploadDir = _config.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
    const outputDir = _config.OUTPUT_DIR ?? path.join(uploadDir, 'skills-output');
    const appName   = _config.APP_NAME   ?? 'Arkimede';

    // ... logica ...

    // Output — console.log su stdout, ultima riga JSON valida = risultato
    console.log(JSON.stringify({
        success: true,
        result:  'output',
        message: 'Operazione completata'
    }));
}

main().catch(err => {
    console.log(JSON.stringify({ success: false, error: err.message, stack: err.stack }));
    process.exit(1);
});
```

### Usare dipendenze npm

```javascript
// Dichiarate in SKILL.md → runtime.dependencies.javascript
// NODE_PATH è impostato automaticamente dal runner verso .deps/node/node_modules
const puppeteer = require('puppeteer');   // funziona senza package.json locale
const { PDFDocument } = require('pdf-lib');
```

### Generare PDF con Puppeteer

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

## 6. Script JavaScript (sandbox)

Per computazione pura su dati. Gira in un V8 Isolate completamente sandboxato: nessun accesso a `require`, `fs`, `process`, rete o altri global Node.js. Non può generare file scaricabili — usa il runner `node` se hai bisogno di scrivere su disco.

**Variabili globali disponibili nel sandbox:**

| Variabile | Descrizione |
|---|---|
| `input` | Parametri di input passati dal LLM (oggetto JSON) |
| `config` | Variabili di configurazione della skill — **`config`, non `_config`** |
| `print(str)` | Scrive una stringa sullo stdout (unico canale di output) |
| `console.log(...)` | Alias di `print` |

> **⚠️ Differenza importante rispetto a Python/Node:** le config vars sono in `config.MY_VAR`, non in `_config.MY_VAR`. L'oggetto `_config` non esiste nel sandbox JS.

**Output — due opzioni:**

```javascript
// Opzione A — return esplicito (il valore viene JSON.stringify'ato e aggiunto allo stdout)
const numeri = input.numeri || [];
const somma  = numeri.reduce((a, b) => a + b, 0);

return {
    somma,
    media:   somma / numeri.length,
    massimo: Math.max(...numeri),
    minimo:  Math.min(...numeri),
};

// Opzione B — console.log (preferibile per output JSON canonico)
// console.log(JSON.stringify({ somma, media: somma / numeri.length }));
```

> **Nota:** assegnare a una variabile non dichiarata (`result = {...}`) senza `return` non produce alcun output, perché l'IIFE che avvolge il codice restituisce `undefined` a meno che non ci sia un `return` esplicito.

---

## 7. SKILL.md — istruzioni per il LLM

Il `SKILL.md` viene iniettato nel system prompt per i progetti a cui la skill è assegnata.  
È il documento più importante: determina quando e come il LLM usa la skill.

### 7a. Template SKILL.md — script singolo

````markdown
# Nome Skill

> ⚠️ **Nome tool canonico:** `skill_nome_skill_main_py`
>
> **NON chiamare mai** un tool con nomi come `nome_skill` o `main` — usa sempre il nome esatto sopra.

## Quando usarla

Usa questa skill **solo su richiesta esplicita dell'utente** — quando chiede di:
- [caso d'uso 1: es. "Fammi un PDF con..."]
- [caso d'uso 2: es. "Genera un report di..."]

**Non** usarla per [casi da escludere: es. risposte normali di testo, calcoli semplici].

---

<!-- @tool: main.py -->
## `main.py` — [Descrizione azione]

**Tool name (usa questo nome esatto):** `skill_nome_skill_main_py`

### Come usarla

Chiama questo tool con:

| Campo      | Tipo     | Obbligatorio | Descrizione |
|------------|----------|:---:|-------------|
| `param1`   | string   | ✅  | ... |
| `param2`   | number   | ❌  | ... (default: 10) |

> `_config` viene iniettato automaticamente — non includerlo nell'input.

## Output e risposta all'utente

Lo script restituisce JSON con:
```json
{
  "success": true,
  "filename": "output_1234567890.pdf",
  "download_url": "/api/files/raw?rel=output_1234567890.pdf",
  "size_bytes": 45678,
  "message": "File generato con successo..."
}
```

> **Nota (isolamento per-utente).** Gli output scritti in `SKILLS_OUTPUT_DIR` finiscono
> in una sottodir per-utente; il download `?rel=` è confinato lì, quindi `rel` è il
> **basename** del file (relativo a `SKILLS_OUTPUT_DIR`), **non** `skills-output/<nome>`.
> Di solito non serve nemmeno costruire il link: il backend traccia automaticamente i
> file che produci e li mostra nel pannello file di chat/progetto (e accoda i link di
> download canonici al risultato del tool).

### ⚠️ Regola critica sul download_url

**Usa SEMPRE il campo `download_url` esattamente come restituito — non modificarlo mai.**

- ✅ Corretto: `[Scarica file](/api/files/raw?rel=output_1234567890.pdf)`
- ❌ Sbagliato: costruire URL da `filename`, `path` o altri campi; o mettere il prefisso `skills-output/`

### Come presentare il link

```
Il file è pronto! [Scarica {filename}]({download_url}) ({size_kb} KB)
```
````

---

### 7b. Marker `@tool` — caricamento selettivo per skill multi-script

Quando una skill ha **più di uno script**, il SKILL.md può diventare molto lungo e consumare molti token anche quando l'agente ha bisogno di un solo script. I marker `<!-- @tool: filename.py -->` permettono al sistema di includere **solo le sezioni pertinenti**.

#### Come funziona

Il backend usa la strategia di tool loading (semantic_rag / keyword_bm25) per selezionare i tool attivi. Se il SKILL.md contiene marker `@tool`, viene inclusa solo la sezione del tool selezionato:

```
SKILL.md con marker           Tool selezionati           Sezioni incluse nel prompt
─────────────────────────────────────────────────────────────────────────────────
# Titolo skill               → SEMPRE                   → # Titolo skill
routing table                                             routing table
                                                          (sezione condivisa)
<!-- @tool: script_a.py -->  → skill_nome_script_a_py   → ## script_a.py section
## Come usare script_a.py    → SELEZIONATO               (inclusa)

<!-- @tool: script_b.py -->  → skill_nome_script_b_py   → (filtrata)
## Come usare script_b.py    → NON selezionato
```

**Risultato tipico:** -40% token nel system prompt rispetto al caricamento completo.

#### Struttura SKILL.md multi-script con marker

````markdown
# Nome Skill

> ⚠️ **IMPORTANTE — Nomi tool esatti da usare nelle chiamate:**
>
> | Azione | **Nome tool da invocare** |
> |--------|--------------------------|
> | Azione A | **`skill_nome_skill_script_a_py`** |
> | Azione B | **`skill_nome_skill_script_b_py`** |
>
> **NON chiamare mai** un tool con nomi come `nome_skill`, `script_a` — usa sempre i nomi esatti sopra.

## Note generali / Workflow multi-step

> ℹ️ Tutto il testo prima del primo marker `<!-- @tool -->` è la **sezione condivisa**
> ed è SEMPRE inclusa nel prompt, indipendentemente dai tool selezionati.
> Usala per: introduzione, tabella nomi canonici, note generali, workflow multi-step.

<!-- @tool: script_a.py -->
## `script_a.py` — Descrizione azione A

**Tool name (usa questo nome esatto):** `skill_nome_skill_script_a_py`

### Input

| Campo | Tipo | Obbligatorio | Descrizione |
|-------|------|:---:|-------------|
| `param1` | string | ✅ | ... |

### Output

```json
{ "success": true, "result": "...", "message": "..." }
```

<!-- @tool: script_b.py -->
## `script_b.py` — Descrizione azione B

**Tool name (usa questo nome esatto):** `skill_nome_skill_script_b_py`

### Input
...
````

#### Regole

- Il **nome nel marker** deve corrispondere **esattamente** al `filename` dichiarato in `runtime.scripts`, senza il prefisso `scripts/`: scrivi `<!-- @tool: list_emails.py -->`, non `<!-- @tool: scripts/list_emails.py -->`
- Il marker è un commento HTML standard — viene ignorato dal rendering Markdown ma intercettato dal parser del backend
- Se il SKILL.md **non contiene marker**, viene incluso interamente (backward compatible)
- Con la strategia `always_inject_all` tutti i SKILL.md vengono caricati per intero (nessun filtro)
- **Anche le skill con un solo script** devono avere il marker `<!-- @tool: filename -->` per coerenza e per abilitare il filtro selettivo in futuro

---

### 7c. Nomi canonici dei tool — prevenire allucinazioni su modelli piccoli

I modelli LLM con pochi parametri (≤ 14B) tendono ad allucinare il nome del tool usando il
**nome della skill** (`gmail`, `pdf`) o il **nome dello script** (`send_email`, `generate_pdf`)
anziché il nome canonico completo. Il SKILL.md deve scoraggiarlo esplicitamente.

#### Formula del nome canonico

Il backend genera il nome del tool con questa logica (da `skill-tool.factory.ts → buildToolName`):

```
skill_{skill_name}_{script_filename}
```

dove:
- `skill_name` → campo `name:` del frontmatter di `SKILL.md`, con `-` → `_`, tutto minuscolo
- `script_filename` → nome file senza `scripts/`, tutti i caratteri non alfanumerici → `_`,
  sequenze `__` ridotte a `_`, tutto minuscolo

**Esempi:**

| `name` nel frontmatter | Script | Nome tool canonico |
|---|---|---|
| `gmail` | `scripts/send_email.py` | `skill_gmail_send_email_py` |
| `gmail` | `scripts/list_emails.py` | `skill_gmail_list_emails_py` |
| `pdf-generator-html` | `scripts/generate_pdf.js` | `skill_pdf_generator_html_generate_pdf_js` |
| `dxf-analyzer` | `scripts/analyze_dxf.py` | `skill_dxf_analyzer_analyze_dxf_py` |
| `file-lookup` | `scripts/find_file.js` | `skill_file_lookup_find_file_js` |
| `ascii-art` | `scripts/banner.py` | `skill_ascii_art_banner_py` |
| `ascii-art` | `scripts/image_ascii.py` | `skill_ascii_art_image_ascii_py` |
| `mia-skill` | `scripts/run.py` | `skill_mia_skill_run_py` |

> **Nota:** gli script con `mode: daemon` nel frontmatter di `SKILL.md` **non vengono registrati** come tool
> LangGraph e quindi non hanno un nome canonico. Includili nel SKILL.md con un avviso esplicito.

#### Pattern obbligatori nel SKILL.md

**Sezione condivisa (prima del primo `@tool`)** — sempre visibile al LLM:

```markdown
> ⚠️ **Nome tool canonico:** `skill_xxx_yyy`
>
> **NON chiamare mai** un tool con nomi come `xxx`, `yyy` — usa sempre il nome esatto sopra.
```

Per skill multi-script, usa una tabella:

```markdown
> ⚠️ **IMPORTANTE — Nomi tool esatti:**
>
> | Azione | **Nome tool da invocare** |
> |--------|--------------------------|
> | Prima azione | **`skill_xxx_script_a_py`** |
> | Seconda azione | **`skill_xxx_script_b_py`** |
>
> **NON chiamare mai** un tool con nomi come `xxx`, `script_a` — usa sempre i nomi esatti sopra.
```

**Sezione per ogni script** — subito dopo il titolo H2:

```markdown
<!-- @tool: script.py -->
## `script.py` — Titolo

**Tool name (usa questo nome esatto):** `skill_xxx_script_py`
```

**Script daemon** — nessun tool name, solo avviso:

```markdown
<!-- @tool: daemon.py -->
## `daemon.py` — Monitoraggio background

> ⚠️ **Questo script NON viene mai invocato dal LLM** — non esiste un tool `skill_xxx_daemon_py`.
> È gestito dall'applicazione tramite l'interfaccia background (Settings → Background).
```

#### Errori comuni da modelli piccoli e relative soluzioni

| Errore osservato nel log (`tool:xxx`) | Causa | Soluzione nel SKILL.md |
|---|---|---|
| `tool:gmail` invece di `skill_gmail_send_email_py` | Il LLM usa il nome skill come tool | Tabella canonici + avviso "NON chiamare" in cima |
| `tool:generate_pdf` invece di `skill_pdf_generator_html_generate_pdf_js` | Il LLM usa il nome script senza prefisso | `**Tool name:**` in ogni sezione script |
| Chiama tool con argomenti errati | Schema non chiaro | Tabella Input con colonna Obbligatorio |
| Non passa `file_path` nell'inter-skill | Manca esempio end-to-end | Esempio con nomi canonici espliciti nei commenti |

---

## 8. Variabili di sistema

### 8a. Variabili d'ambiente (`process.env` / `os.environ`)

Iniettate direttamente nel subprocess dall'executor — accessibili via `process.env` (Node) o `os.environ` (Python). **Non** arrivano in `_config`.

**Tutti gli script (oneshot e daemon):**

| Variabile | Node | Python | Descrizione |
|---|:---:|:---:|---|
| `SKILLS_OUTPUT_DIR` | ✅ | ✅ | Directory per i file generati (download via `?rel=`). Con l'overlay broker punta alla work dir del job (copy-out automatico). |
| `SKILL_ID` | ✅ | ✅ | UUID della skill in esecuzione |
| `USER_ID` | ✅ | ✅ | Identità per cui gira il run (C2). Vuoto solo se il run è senza identità (fail-closed: nessun accesso ai file). |
| `SKILL_STATE_DIR` | ✅ | ✅ | _(solo overlay broker)_ Directory **persistente per-skill** (sopravvive tra i run): usala per stato/cache durevoli. In esecuzione in-process non è impostata. |
| `BACKEND_INTERNAL_URL` | ✅ | ✅ | URL base del backend (es. `http://localhost:3000`) |
| `INTERNAL_TOKEN` | ✅ | ✅ | Chiave per gli endpoint `/internal/*` — vedi [sezione 10](#10-salvare-config-vars-da-uno-script-sicuro) |
| `PATH` | ✅ | ✅ | PATH reale dell'host (trova node, python3, binari di sistema) |
| `HOME` | ✅ | ✅ | **Node:** HOME reale dell'host (necessario per Puppeteer e tool che usano `~/.cache`). **Python:** forzato a `/tmp` per limitare l'accesso alla home. |
| `TMPDIR` | ✅ | ✅ | Forzato a `/tmp` per entrambi i runner |
| `NODE_PATH` | ✅ | ❌ | Path alle dipendenze npm isolate della skill (`.deps/node/node_modules`) |
| `PYTHONPATH` | ❌ | ✅ | Path alle dipendenze Python isolate della skill (`.deps/python`) |
| `PYTHONUNBUFFERED` | ❌ | ✅ | `1` — disabilita il buffering di stdout (garantisce che il JSON arrivi senza ritardi) |
| `PYTHONDONTWRITEBYTECODE` | ❌ | ✅ | `1` — impedisce la scrittura di file `.pyc` fuori da `/tmp` |
| `NO_COLOR` / `FORCE_COLOR` | ✅ | ❌ | Disabilita output ANSI per non sporcare il JSON |

> **`DATASOURCE_ID` / `VECTOR_COLLECTION`:** NON sono variabili d'ambiente. Sono config
> vars (con dropdown dedicato in UI, vedi [sezione 2](#2-skillyaml--schema-completo)) e si
> leggono da `_config`: `cfg = data.get("_config", {}); cfg.get("DATASOURCE_ID")`.

> **⚠️ JS sandbox (`language: javascript`):** non ha variabili d'ambiente. Accede ai parametri tramite le globali `input` e `config` iniettate nell'isolate. Vedi [sezione 6](#6-script-javascript-sandbox).

**Solo script `mode: daemon`** (vedi [sezione 12](#12-script-daemon-background--watch)):

| Variabile | Descrizione |
|---|---|
| `PUSH_URL` | Endpoint completo per gli eventi push (`POST /internal/daemons/events`) |
| `DAEMON_ID` | UUID del daemon corrente (record nel DB) |
| `USER_ID` | ID dell'utente proprietario del daemon |

### 8b. Variabili di configurazione della skill

Contengono **solo** le variabili definite in `runtime.config` di `SKILL.md` e configurate dall'utente nella UI. Il backend può aggiungere alcune variabili di sistema come `APP_NAME`.

Il modo di accedervi **dipende dal runner:**

| Runner | Come leggere le config vars |
|--------|----------------------------|
| `python` / `node` | Campo `_config` nello stdin JSON: `data.get("_config", {})` / `data._config ?? {}` |
| `javascript` (isolate) | Globale `config` iniettata nel sandbox: `config.MY_VAR` |

```python
# Python e Node — leggi da _config nello stdin JSON
_config  = data.get('_config', {})
app_name = _config.get('APP_NAME', 'default')  # variabile di sistema del backend
my_key   = _config.get('MY_API_KEY', '')        # variabile configurata dall'utente
```

```javascript
// JS sandbox — usa la globale `config` (non `_config`)
const appName = config.APP_NAME ?? 'default';
const myKey   = config.MY_API_KEY ?? '';
```

---

## 9. Restituire file scaricabili

### Pattern corretto — path relativo a UPLOAD_DIR

```python
# Python
import os
from urllib.parse import quote as _quote

upload_dir   = os.path.abspath(_config.get('UPLOAD_DIR', './uploads'))
output_dir   = os.path.abspath(_config.get('OUTPUT_DIR', os.path.join(upload_dir, 'skills-output')))
os.makedirs(output_dir, exist_ok=True)

out_path     = os.path.join(output_dir, f"report_{timestamp}.pdf")
# ... salva il file ...

rel_path     = os.path.relpath(out_path, upload_dir)
download_url = f"/api/files/raw?rel={_quote(rel_path)}"

print(json.dumps({
    "success":      True,
    "filename":     os.path.basename(out_path),
    "download_url": download_url,
    "size_bytes":   os.path.getsize(out_path),
    "message":      f"File generato. Scarica: {download_url}"
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
    message:      `File generato. Scarica: ${downloadUrl}`
}));
```

**Perché `?rel=` e non il path assoluto?**  
Il path assoluto del filesystem (`/app/uploads/...`) non è un URL web valido e confonde il LLM che potrebbe tentare di costruire URL sbagliati. Il path relativo è sicuro, portabile e inequivocabile.

---

## 10. API interne dagli script

L'executor inietta tre variabili d'ambiente in ogni subprocess che permettono allo script
di comunicare con il backend tramite endpoint interni protetti:

| Variabile | Descrizione |
|---|---|
| `BACKEND_INTERNAL_URL` | URL base del backend (es. `http://localhost:3000`) |
| `INTERNAL_TOKEN` | Token di run firmato (per-esecuzione, non falsificabile) — header `x-internal-token`. Porta l'identità dell'utente del run: il backend lo verifica e applica lo scope. |
| `SKILL_ID` | UUID della skill corrente |

> ⚠️ Non includere mai `INTERNAL_TOKEN` nell'output JSON dello script — non deve finire nella conversation history.

---

## 10a. Salvare config vars (sicuro)

### Il problema

Alcuni script hanno bisogno di **persistere dati sensibili** al termine della loro esecuzione
(token OAuth, refresh token, chiavi API ottenute dinamicamente).  
Se questi valori vengono restituiti nell'output JSON dello script, compaiono nel messaggio
dell'AI e vengono **salvati nella conversation history** del database — visibili a chiunque
abbia accesso alla chat.

### La soluzione: API interna dell'executor

L'executor inietta tre variabili d'ambiente in ogni subprocess:
- `SKILL_ID` — UUID della skill corrente
- `BACKEND_INTERNAL_URL` — URL del backend (es. `http://localhost:3000`)
- `INTERNAL_TOKEN` — token di run firmato dal backend, iniettato per-esecuzione

Lo script può chiamare `POST {BACKEND_INTERNAL_URL}/internal/skills/{SKILL_ID}/save-config`
per scrivere config vars **direttamente nel DB**, poi restituire in output solo un messaggio
di conferma senza alcun dato sensibile.

### Template Python

```python
import os, json, urllib.request, urllib.error

SKILL_ID             = os.environ.get('SKILL_ID', '')
BACKEND_INTERNAL_URL = os.environ.get('BACKEND_INTERNAL_URL', 'http://localhost:3000').rstrip('/')
INTERNAL_TOKEN       = os.environ.get('INTERNAL_TOKEN', '')

def save_config(config: dict) -> None:
    """Salva config vars nel backend senza esporle nell'output della chat."""
    if not INTERNAL_TOKEN:
        raise ValueError(
            "INTERNAL_TOKEN assente: lo script non sta girando dentro un'esecuzione "
            "valida (il backend lo inietta per ogni run)."
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
            raise ValueError(f"Backend ha risposto ok=false: {result}")

# Uso nello script
save_config({
    'MY_TOKEN':  token_value,
    'MY_SECRET': secret_value,
})

# Output: NESSUNA credenziale — solo conferma
print(json.dumps({
    "success": True,
    "message": "✅ Configurazione salvata in modo sicuro."
}))
```

### Template Node.js

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

// Uso nello script
await saveConfig({ MY_TOKEN: tokenValue, MY_SECRET: secretValue });

// Output: NESSUNA credenziale
console.log(JSON.stringify({ success: true, message: '✅ Configurazione salvata in modo sicuro.' }));
```

### Configurazione richiesta

`INTERNAL_TOKEN` **non si configura**: è coniato e firmato dal backend a ogni esecuzione e
iniettato nell'ambiente dello script. Lato server serve solo il segreto di firma nel backend:

```bash
# backend .env
RUN_TOKEN_SECRET=<secret>   # genera con: openssl rand -hex 32 — vive SOLO nel backend
BACKEND_INTERNAL_URL=http://localhost:3000   # in Docker: http://backend:3000
```

> Lo script riceve un token opaco usa-e-getta che **non può forgiare**: è questo che impedisce
> a una skill di spacciarsi per un altro utente verso gli endpoint `/internal/*`.

### Quando usarlo vs output normale

| Tipo di dato | Approccio |
|---|---|
| File generati (PDF, immagini) | Output normale con `download_url` |
| Risultati computazionali | Output normale nel JSON |
| Token OAuth, refresh token | ✅ API interna — non nell'output |
| API key ottenute dinamicamente | ✅ API interna — non nell'output |
| Password, segreti | ✅ API interna — non nell'output |

---

## 10b. Query su datasource (SQL, MongoDB, Redis, file-share)

`POST /internal/datasources/:id/query`

Esegue un'operazione sulla datasource configurata dall'utente. L'endpoint sceglie il driver in
base all'**engine**/famiglia della datasource:
- **relazionali** (PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite) → campo `sql`;
- **documentali** (MongoDB) → campo `mongo` con lo spec dell'operazione;
- **key-value** (Redis) → campo `redis` con `{ command, args }`;
- **file-share** (SMB/CIFS, SFTP, WebDAV) → campo `file` con `{ op, path, ... }`.

`id` = UUID della datasource (config var `type: datasource`, con `family` opzionale per filtrare
il dropdown — vedi [sezione 2](#2-skillyaml--schema-completo)).

> 🔐 **Auth & scope:** la chiamata usa il token di run (`x-internal-token`); il backend
> verifica che l'identità del run abbia accesso allo **scope** della datasource (personal/team/org).

### Request — relazionali (`sql`)

```json
{
  "sql":    "SELECT * FROM orders WHERE user_id = ? AND status = ?",
  "params": ["user-123", "pending"],
  "limit":  100
}
```

| Campo | Tipo | Obbligatorio | Note |
|---|---|:---:|---|
| `sql` | string | ✅ (relazionali) | Query SQL con placeholder `?` / `$N` (tradotti e bindati dal driver del dialetto) |
| `params` | array | ❌ | Valori positional — **mai interpolati nella query** (prepared statements) |
| `limit` | number | ❌ | Max 10 000 — applica il limite nella sintassi del dialetto (LIMIT / TOP / FETCH FIRST) |

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

| Campo `mongo.*` | Note |
|---|---|
| `collection`, `op` | obbligatori. `op` ∈ find / aggregate / countDocuments / distinct / insertOne / insertMany / updateOne / updateMany / deleteOne / deleteMany |
| `filter`, `pipeline`, `projection`, `sort`, `update`, `document(s)`, `field`, `limit` | a seconda dell'operazione |

### Request — Redis (`redis`)

```json
{
  "redis": { "command": "HGETALL", "args": ["user:42"] }
}
```

| Campo `redis.*` | Note |
|---|---|
| `command` | obbligatorio. Comando Redis (GET, HGETALL, LRANGE, SCAN, SET, …) |
| `args` | array di argomenti del comando |

### Request — file-share (`file`)

```json
{
  "file": { "op": "read", "path": "documenti/report.txt" }
}
```

| Campo `file.*` | Note |
|---|---|
| `op` | obbligatorio: `list` / `read` / `write` / `delete` |
| `path` | percorso **relativo alla base** della share (guardia anti path-traversal lato backend) |
| `content` | base64 (solo `op: write`) |
| `recursive` | boolean (solo `op: delete` su cartella) |

Risposta in `rows`: `list` → elenco `{name,path,type,size,mtime}`; `read` → `[{path,content(base64),size,encoding}]`
(max 10 MB); `write`/`delete` → `[{path, ok:true}]`.

> L'endpoint applica l'**ownership/scope** sull'identità del token di run (vedi sopra).
> Le capability read-only / opt-in valgono invece per i **tool** `sql`/`mongo` usati dall'agente.

### Response

```json
{ "rows": [...], "count": 42, "engine": "mysql" }
```

### Template Python

```python
import os, json, urllib.request

DATASOURCE_ID = _config.get('DATASOURCE_ID', '')  # config var — da stdin _config, NON env

def query_datasource(sql: str, params=None, limit=None) -> list:
    body = json.dumps({'sql': sql, 'params': params or [], 'limit': limit}).encode()
    url  = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/datasources/{DATASOURCE_ID}/query"
    req  = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type':       'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())['rows']

# Uso nello script — DATASOURCE_ID viene da os.environ, non servono parametri di input
rows = query_datasource('SELECT * FROM products WHERE active = ?', [1], limit=50)
```

### Template Node.js

```javascript
const http = require('http');

const DATASOURCE_ID = _config.DATASOURCE_ID ?? '';  // config var — da stdin _config, NON env

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

// Uso — DATASOURCE_ID viene da process.env, non serve come parametro di input
const rows = await queryDatasource('SELECT * FROM products WHERE active = ?', [1], 50);
```

> L'endpoint è autenticato dal token di run firmato (`x-internal-token`), che porta l'identità
> verificata dell'utente del run; su quell'identità il backend applica lo scope della risorsa.

---

## 10c. Ricerca semantica nel vector store

`POST /internal/vector/search`

Semantic search su una collection Qdrant. Il backend si occupa di embedare `query_text`.

### Request

```json
{
  "collection":      "my-collection",
  "query_text":      "scarpe da corsa impermeabili",
  "limit":           15,
  "score_threshold": 0.7
}
```

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `collection` | string | — | Nome della collection Qdrant |
| `query_text` | string | — | Testo da embedare e cercare |
| `limit` | number | 15 | Max 200 risultati |
| `score_threshold` | number | 0.0 | Filtra risultati sotto soglia (0–1) |

### Response

```json
{
  "results": [
    { "id": "uuid", "score": 0.92, "payload": { "text": "...", "source": "..." } }
  ],
  "count": 3
}
```

### Template Python

```python
import os, json, urllib.request

VECTOR_COLLECTION = _config.get('VECTOR_COLLECTION', '')  # config var — da stdin _config, NON env

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

# Uso — VECTOR_COLLECTION viene da os.environ, non serve come parametro di input
results = vector_search(data.get('query'), limit=10, threshold=0.75)
for r in results:
    print(r['payload'].get('text', ''), r['score'])
```

---

## 10d. Indicizzare dati nel vector store

`POST /internal/vector/ingest`

Indicizza in batch una lista di item nella collection (embedding + upsert in Qdrant).
Con `recreate=true` ricrea la collection da zero (full refresh).

### Request

```json
{
  "collection": "my-collection",
  "recreate":   false,
  "items": [
    { "id": "item-1", "text": "testo da indicizzare", "payload": { "source": "doc.pdf" } }
  ]
}
```

| Campo | Tipo | Note |
|---|---|---|
| `collection` | string | Nome della collection |
| `recreate` | boolean | Default `false` — con `true` elimina e ricrea la collection |
| `items[].id` | string | ID univoco dell'item (usato come `_item_id` nel payload) |
| `items[].text` | string | Testo da embedare |
| `items[].payload` | object | Metadati opzionali conservati insieme al vettore |

Gli embedding vengono generati in batch da 50 item alla volta.

### Response

```json
{ "indexed": 42, "errors": 0, "collection": "my-collection" }
```

### Template Python

```python
import os, json, urllib.request

VECTOR_COLLECTION = _config.get('VECTOR_COLLECTION', '')  # config var — da stdin _config, NON env

def vector_ingest(items: list, recreate=False) -> dict:
    body = json.dumps({'collection': VECTOR_COLLECTION, 'recreate': recreate, 'items': items}).encode()
    url  = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/vector/ingest"
    req  = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type':       'application/json',
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Uso combinato con query_datasource — indicizzare un catalogo prodotti da SQL
rows = query_datasource('SELECT id, name, description FROM products', limit=1000)
items = [
    {'id': str(r['id']), 'text': f"{r['name']}: {r['description']}", 'payload': {'name': r['name']}}
    for r in rows
]
result = vector_ingest(items, recreate=True)
# result = { "indexed": 150, "errors": 0, "collection": "prodotti" }
```

---

## 10e. Indicizzare un file di una DataSource (pipeline completa)

`POST /internal/embed/datasource`

Diverso da [§10d](#10d-indicizzare-dati-nel-vector-store): qui la skill **non legge né estrae** nulla.
Fornisce solo `(source, path)` e tutta la pipeline è del backend: lettura del file dalla
DataSource, estrazione testo (PDF/DOCX/XLSX/OCR), chunking, embedding e upsert nel vector store.

È la stessa capacità di `POST /api/embed/datasource`, esposta alla skill via token di run.
L'indicizzazione è **accodata (asincrona)**: l'endpoint ritorna subito e l'utente viene
notificato a fine job. L'identità è quella del run (`USER_ID`); lo scope-check sull'accesso
alla sorgente è applicato dentro il backend (no escalation).

### Request

```json
{
  "source":     "uuid-della-datasource",
  "path":       "documenti/report-2026.pdf",
  "collection": "my-collection"
}
```

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `source` | string | — | ID della DataSource (file-share) o `local` per la fileshare locale |
| `path` | string | — | Path del file dentro la sorgente |
| `collection` | string | _(opz.)_ | Collection di destinazione; se omessa, il backend usa quella di default |

> `source` segue la stessa semantica del `DATASOURCE_ID` di [§10b](#10b-query-sql-su-datasource):
> mettilo in una **config var** (dropdown DataSource in UI) e leggilo da `_config`, oppure usa `local`.

### Response

L'indicizzazione è asincrona: di norma ritorna `queued`. Per file piccoli può tornare `inline`.

```json
{ "status": "queued", "jobId": "42", "filename": "report-2026.pdf" }
```

```json
{ "status": "inline", "chunks": 18, "collection": "my-collection", "filename": "report-2026.pdf" }
```

### Template Python

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

# Uso — source da una config var DataSource (o 'local'); path da input
DATASOURCE_ID = data.get('_config', {}).get('DATASOURCE_ID', 'local')
res = embed_datasource(DATASOURCE_ID, data['path'])
# res = { "status": "queued", "jobId": "42", "filename": "report-2026.pdf" }
print("Indicizzazione avviata, riceverai una notifica a fine job.")
```

---

## 10f. Cercare i file dell'utente (access-scoped)

`GET /internal/files/search`

Cerca tra i file dell'utente del run in modo **access-aware**: ritorna solo i file
visibili a quell'identità (rispetta lo scope personal/team/org/progetto). È il modo
**corretto** per una skill di trovare i file dell'utente — **non** scansionare il
filesystem, che esporrebbe file di altri tenant.

### Request (query string)

| Parametro | Tipo | Default | Note |
|---|---|---|---|
| `userId` | string | — | **Obbligatorio.** Usa la env `USER_ID` del run (identità per cui gira la skill) |
| `q` | string | `""` | Filtro sul nome file (match parziale); vuoto = tutti i file leggibili |
| `limit` | number | 50 | Numero massimo di risultati |

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

> `download_url` / `rel` è il path relativo per il download autenticato (`?rel=`): vedi
> [§7 — regola sul download_url](#7-skillmd--istruzioni-per-il-llm). Per ri-indicizzare uno
> di questi file combina con [§10e](#10e-indicizzare-un-file-di-una-datasource-pipeline-completa).

### Template Python

```python
import os, json, urllib.request, urllib.parse

def search_files(query: str = '', limit: int = 50) -> list:
    user_id = os.environ.get('USER_ID', '')
    if not user_id:
        return []  # run senza identità → nessun accesso (fail-closed)
    qs  = urllib.parse.urlencode({'userId': user_id, 'q': query, 'limit': limit})
    url = f"{os.environ['BACKEND_INTERNAL_URL']}/internal/files/search?{qs}"
    req = urllib.request.Request(url, method='GET', headers={
        'x-internal-token': os.environ['INTERNAL_TOKEN'],
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Uso
for f in search_files(data.get('query', ''), limit=20):
    print(f['filename'], f['download_url'])
```

---

## 10g. Invocare un'altra skill (inter-skill)

`POST /internal/skills/:id/invoke`

Permette a uno script di **invocare un'altra skill come servizio**, senza passare
dall'agente LangGraph. Utile per comporre skill (es. una skill "pipeline" che orchestra
una skill di estrazione + una di reportistica).

**Vincoli:** la skill target deve avere `status='ready'`; lo script invocato deve essere
`mode='task'` (non `daemon`); l'`input` deve rispettare l'`input_schema` dichiarato nel
frontmatter di `SKILL.md` (runtime.scripts) della skill target.

### Request

```json
{
  "script":     "recommend.py",
  "input":      { "seed_categories": ["running", "trail"] },
  "timeout_ms": 30000
}
```

| Campo | Tipo | Default | Note |
|---|---|---|---|
| `script` | string | — | Filename dello script da eseguire (con o senza prefisso `scripts/`) |
| `input` | object | `{}` | Parametri passati allo script via stdin (devono combaciare con l'`input_schema`) |
| `timeout_ms` | number | 30000 | Timeout esecuzione (min 1000); aumentalo per operazioni lunghe |

`:id` è l'UUID della skill target (passalo come **config var**, es. `TARGET_SKILL_ID`).

### Response

```json
{ "success": true, "output": { "...": "..." }, "raw": "...", "duration_ms": 123, "exit_code": 0 }
```

In caso di errore dello script (`exit_code != 0`) la risposta resta HTTP 200 con `success: false`:

```json
{ "success": false, "output": null, "raw": "", "exit_code": 1, "stderr": "Traceback ...", "duration_ms": 50 }
```

> Altri codici: **404** skill non trovata o non `ready` · **400** script inesistente / daemon / input malformato · **503** skill-executor non raggiungibile.

### Template Python

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

# Uso — TARGET_SKILL_ID da una config var
target = data.get('_config', {}).get('TARGET_SKILL_ID', '')
res = invoke_skill(target, 'recommend.py', {'seed_categories': ['running']})
if res['success']:
    print(json.dumps(res['output']))
else:
    print('Skill invocata fallita:', res.get('stderr', '')[:500])
```

---

## 11. Dipendenze di sistema (Nix)

L'executor integra [Nix](https://nixos.org/), un package manager che installa tool di sistema
**isolati per skill**, senza conflitti di versione e senza richiedere privilegi root.

### Come funziona

```
Upload ZIP
  ↓ backend chiama POST /install con nix_deps: ["cowsay", "ffmpeg"]
  ↓ executor: nix profile install nixpkgs#cowsay nixpkgs#ffmpeg \
                 --profile /app/skills/{id}/.nix
  ↓ .nix/bin/cowsay  →  symlink a /nix/store/hash.../bin/cowsay
  ↓ status: ready

Esecuzione script
  ↓ runner prepend PATH = .nix/bin : PATH originale
  ↓ subprocess.run(['cowsay', ...])  →  trova il binario Nix ✅
```

Ogni skill ha il proprio Nix **profile isolato** in `.nix/`:
```
/app/skills/
├── skill-abc/
│   ├── scripts/
│   ├── .deps/python/          ← pip packages
│   └── .nix/                  ← Nix profile isolato
│       └── bin/
│           ├── cowsay         → /nix/store/ybkwq4z...-cowsay-3.7/bin/cowsay
│           └── convert        → /nix/store/m3x9p2q...-imagemagick-7.1/bin/convert
└── skill-def/
    └── .nix/                  ← versioni diverse, nessun conflitto
```

### Dichiarare dipendenze Nix nel frontmatter (runtime.dependencies.system.nix)

```yaml
dependencies:
  python: [requests>=2.31]         # pip, come sempre
  system:
    nix:
      - cowsay                     # nome pacchetto in nixpkgs
      - imagemagick
      - ffmpeg
      - pandoc
```

> Cerca i nomi dei pacchetti su [search.nixos.org](https://search.nixos.org/packages).
> Il nome da usare è il valore nel campo **"Attribute name"** (es. `python3Packages.requests`).

### Usare i tool Nix negli script

```python
# Python — subprocess chiama il binario Nix (già nel PATH)
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
// Node.js — execFile chiama il binario Nix
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

### Nomi pacchetti — esempi comuni

| Tool | Nome nixpkgs | Note |
|---|---|---|
| ImageMagick | `imagemagick` | `convert`, `mogrify`, `identify` |
| FFmpeg | `ffmpeg` | `ffmpeg`, `ffprobe` |
| Pandoc | `pandoc` | conversione documenti |
| Ghostscript | `ghostscript` | manipolazione PDF |
| `cowsay` | `cowsay` | — |
| `boxes` | `boxes` | — |
| `toilet` | `toilet` | — |
| SQLite CLI | `sqlite` | `sqlite3` |
| `jq` | `jq` | — |
| `poppler` | `poppler_utils` | `pdftotext`, `pdfinfo` |
| `wkhtmltopdf` | `wkhtmltopdf` | HTML → PDF via WebKit |

### Vincoli e note operative

**Persistenza:** il Nix store (`/nix`) è montato come named volume Docker (`nix_store`).
I pacchetti sopravvivono ai rebuild del container — vengono ri-scaricati solo se il volume
viene eliminato manualmente.

**Prima installazione:** al primo avvio con volume vuoto, l'entrypoint installa Nix (~2 min).
Le installazioni successive sono istantanee grazie alla cache del volume.

**Cleanup:** quando una skill viene eliminata, la sua directory `.nix/` (i symlink) viene
rimossa automaticamente insieme al resto. I path in `/nix/store` rimangono finché non si
esegue `nix-collect-garbage` (manutenzione periodica del volume).

**Solo nixpkgs:** per sicurezza, sono consentiti solo nomi di pacchetti `nixpkgs` semplici
(es. `cowsay`, `python3Packages.requests`). URL arbitrari, flake GitHub e path locali
sono bloccati dalla validazione in `install.ts`.

---

## 12. Script Daemon (background / watch)

Un daemon è uno script con `mode: daemon` nel frontmatter di `SKILL.md`. Gira come processo
long-running in background e comunica con il backend tramite eventi push HTTP —
non restituisce nulla su stdout e non viene mai chiamato dal LLM.

### Protocollo

```
Avvio
  ↓ executor lancia il processo e passa _config via stdin (JSON)
  ↓ processo legge stdin, si inizializza
  ↓ loop di monitoraggio
      → rileva un evento → POST PUSH_URL (JSON)
      → attende l'intervallo configurato
  ↓ SIGTERM ricevuto → graceful shutdown → processo termina
```

### Variabili d'ambiente disponibili

| Variabile | Descrizione |
|---|---|
| `PUSH_URL` | URL completo a cui inviare gli eventi (`POST`) |
| `DAEMON_ID` | UUID del daemon (incluso in ogni evento) |
| `SKILL_ID` | UUID della skill (incluso in ogni evento) |
| `USER_ID` | ID utente proprietario (incluso in ogni evento) |
| `INTERNAL_TOKEN` | Header `x-internal-token` richiesto da `PUSH_URL` |

### Formato evento (POST a PUSH_URL)

```json
{
  "skill_id":   "uuid-skill",
  "user_id":    "uuid-utente",
  "daemon_id":  "uuid-daemon",
  "event_type": "nome_evento",
  "payload":    { "chiave": "valore" }
}
```

Il campo `event_type` è libero. Convenzioni raccomandate:

| `event_type` | Quando emetterlo | Payload tipico |
|---|---|---|
| `nome_personalizzato` | Evento specifico della skill | Qualsiasi oggetto JSON |
| `auth_error` | Token scaduto / errore autenticazione critico | `{ "error": "messaggio" }` |
| `daemon_exit` | Subito prima di terminare per errore | `{ "exit_code": 1 }` — solitamente emesso automaticamente dall'executor |

> **`daemon_exit`** viene emesso automaticamente dall'executor quando il processo termina.
> Non è necessario emetterlo manualmente a meno che non si voglia farlo prima di `sys.exit()`.

### Template Python

```python
#!/usr/bin/env python3
"""
watcher.py — daemon background.

Protocollo:
  1. Leggi _config da stdin JSON all'avvio
  2. Inizializza le risorse (client API, connessioni, ecc.)
  3. Loop: monitora → push_event() → attendi
  4. SIGTERM / SIGINT → _running = False → uscita pulita
"""
import sys, json, os, time, signal, logging, urllib.request

# ── Logging su stderr (non inquina stdout) ─────────────────────────────────────
logging.basicConfig(stream=sys.stderr, level=logging.INFO,
    format='[watcher] %(asctime)s %(levelname)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('watcher')

# ── Variabili iniettate dall'executor ─────────────────────────────────────────
PUSH_URL     = os.environ.get('PUSH_URL', '')
DAEMON_ID    = os.environ.get('DAEMON_ID', '')
SKILL_ID     = os.environ.get('SKILL_ID', '')
USER_ID      = os.environ.get('USER_ID', '')
INTERNAL_KEY = os.environ.get('INTERNAL_TOKEN', '')

# ── Graceful shutdown ──────────────────────────────────────────────────────────
_running = True

def _handle_signal(sig, frame):
    global _running
    log.info(f'Segnale {sig} ricevuto — shutdown in corso...')
    _running = False

signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT,  _handle_signal)

# ── Push evento ────────────────────────────────────────────────────────────────
def push_event(event_type: str, payload: dict) -> None:
    """Invia un evento al backend tramite PUSH_URL."""
    if not PUSH_URL:
        log.warning('PUSH_URL non configurato — evento ignorato')
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
            log.debug(f'Evento {event_type} inviato (HTTP {resp.status})')
    except Exception as e:
        log.warning(f'Errore invio evento {event_type}: {e}')

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    # 1. Leggi _config da stdin
    try:
        raw  = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        log.error(f'Errore lettura stdin: {e}')
        sys.exit(1)

    cfg = data.get('_config', {})

    # 2. Leggi configurazione (valori da config + fallback a default)
    api_key       = cfg.get('MY_API_KEY', '')
    poll_interval = int(cfg.get('MY_POLL_INTERVAL') or 30)

    if not api_key:
        log.error('MY_API_KEY non configurata')
        sys.exit(1)

    if not PUSH_URL:
        log.error('PUSH_URL non disponibile')
        sys.exit(1)

    log.info(f'Daemon avviato (poll ogni {poll_interval}s)')

    # 3. Loop principale
    while _running:
        time.sleep(poll_interval)
        if not _running:
            break

        try:
            # --- logica di monitoraggio ---
            nuovi_elementi = controlla_aggiornamenti(api_key)  # sostituisci con la tua logica

            if nuovi_elementi:
                push_event('nuovi_elementi', {
                    'count': len(nuovi_elementi),
                    'items': nuovi_elementi,
                })

        except Exception as e:
            log.error(f'Errore durante il polling: {e}')
            # Errori critici non recuperabili → emetti auth_error / termina
            if 'unauthorized' in str(e).lower() or 'invalid_grant' in str(e).lower():
                push_event('auth_error', {'error': str(e)})
                sys.exit(1)
            # Errori transitori (rete, rate limit) → continua il loop

    log.info('Daemon terminato')

if __name__ == '__main__':
    main()
```

### Leggere `GMAIL_POLL_INTERVAL` (o qualsiasi config) da `_config`

Le variabili configurabili dall'utente in `runtime.config` (frontmatter SKILL.md) vengono iniettate
in `_config` (letto da stdin), **non** nelle variabili d'ambiente.
Leggile sempre da `cfg = data.get('_config', {})`:

```python
# ✅ Corretto — legge dalla config della skill (configurabile dall'utente in UI)
poll_interval = int(cfg.get('MY_POLL_INTERVAL') or os.environ.get('MY_POLL_INTERVAL') or 30)

# ❌ Sbagliato — os.environ non contiene le config della skill
poll_interval = int(os.environ.get('MY_POLL_INTERVAL', 30))
```

### Errori comuni

| Errore | Causa | Soluzione |
|--------|-------|-----------|
| Daemon termina subito | `_config` incompleta | Valida i campi obbligatori all'avvio e fai `sys.exit(1)` con log chiaro |
| `PUSH_URL` vuoto | Script avviato fuori dall'executor | Verifica che `mode: daemon` sia nel frontmatter di `SKILL.md` |
| Push eventi silenziosamente fallisce | Header `x-internal-token` mancante | Usa sempre `INTERNAL_KEY` nell'header della richiesta |
| Token scaduto in loop | Errore non gestito come critico | Distingui errori transitori (continua) da critici (emetti `auth_error` + `sys.exit(1)`) |

---

## 13. Abilitare/disabilitare una skill

Ogni skill ha un flag `enabled` (boolean, default `true`). Puoi disabilitarla dalla UI
(switch nel drawer della skill, tab "Le mie skill") o via API:

```http
PATCH /api/skills/:id/enabled
Authorization: Bearer <jwt>
Content-Type: application/json

{ "enabled": false }
```

Permessa all'owner della skill o a un admin. Vale per qualsiasi scope (`personal` / `team` / `org`).

**Effetti immediati:**
- La skill **non viene caricata** come tool dall'agente nella richiesta successiva
- Il suo `SKILL.md` **non viene incluso** nel system prompt (filtro in `buildSkillSystemPromptSelective`)
- La skill rimane nel DB e mantiene configurazione, script e assegnazioni a progetti
- Può essere riabilitata in qualsiasi momento con `{ "enabled": true }`

> **Caso d'uso:** skill in manutenzione, skill con costi elevati da attivare solo quando serve,
> skill in testing prima dell'approvazione admin.

---

## 14. Caricare, testare e pubblicare la skill

### Flusso — Upload manuale

1. **Crea il pacchetto ZIP** dalla directory root della skill
2. **Upload:** Impostazioni → Skills → tab "Le mie skill" → Upload ZIP
3. **Attendi l'installazione** — il badge mostra `installing`, poi `ready` (o `error`)
   - Se `error`: clicca il badge → log completo dell'installazione
   - Usa "Reinstalla" per ritentare senza re-caricare il ZIP
4. **Configura le variabili** — nel drawer della skill → tab "Configura"
5. **Assegna ai progetti** — tab "Assegna" → seleziona i progetti
6. **Testa nella chat** di un progetto assegnato

### Flusso — Installazione dal marketplace

**Registry GitHub pubblico:**
1. Stessa tab "Skill pubbliche" — la sezione mostra le skill dal registry configurato
2. Ricerca per nome, descrizione, autore o tag
3. Clicca **"Installa"** — il backend scarica il ZIP da GitHub e lo installa
4. Il badge mostra `installando...` → poi `ready`

### Condividere una skill (uso interno)

1. La skill deve essere in stato `ready`
2. Drawer skill → **Visibilità** → scegli lo scope:
   - **Team** → la skill è pubblicata **subito** ai membri del team (nessuna review); puoi farlo se sei **owner del team** o admin
   - **Org** → scope diventa `org` (in attesa review)
3. (Solo `org`) l'admin approva dalla tab "Review" → la skill compare per tutti gli utenti
4. Per ritirare: riporta lo scope a **Personal**

### Testare lo script direttamente (senza UI)

```bash
# Chiama direttamente l'executor (porta configurata in .env.executor, default 4000)
curl -X POST http://localhost:4000/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "skill_id": "uuid-della-skill",
    "filename": "scripts/main.py",
    "language": "python",
    "input": { "titolo": "Test", "righe": [{"voce": "Prodotto", "importo": 100}] },
    "config": { "OUTPUT_DIR": "/tmp/test-output" },
    "timeout_ms": 30000
  }'
```

**Codici HTTP dell'executor:**

| Codice | Quando |
|--------|--------|
| `200` | Esecuzione completata con successo (`exit_code: 0`) |
| `201` | Daemon avviato con successo |
| `400` | Richiesta malformata o linguaggio non supportato |
| `404` | Daemon non trovato |
| `422` | Script terminato con errore (`exit_code ≠ 0`); il body contiene `stdout`/`stderr` |
| `429` | Troppi script in esecuzione contemporaneamente (`MAX_CONCURRENT` raggiunto) |
| `500` | Errore interno dell'executor (spawn fallito, ecc.) |

> Quando uno script va in **timeout**, l'executor invia `SIGKILL` al processo e restituisce `exit_code: 124` con `stderr` prefissato da `[KILLED: timeout Nms]`.

---

## 15. Registry GitHub (contribuire)

Il registry è un repository GitHub pubblico (configurabile via `SKILLS_REGISTRY_URL` nel `.env` del backend). Per pubblicare una skill:

### Struttura del repository registry

```
skills/
├── registry.json               ← indice di tutte le skill
└── skills/
    └── nome-skill/
        ├── nome-skill-v1.0.0.zip
        └── README.md
```

### Formato registry.json

```json
{
  "version": "1",
  "updatedAt": "2026-05-23T00:00:00Z",
  "skills": [
    {
      "name":        "nome-skill",
      "version":     "1.0.0",
      "description": "Descrizione per il marketplace",
      "author":      "Tuo Nome",
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

### Registry personalizzato (self-hosted o aziendale)

```bash
# .env (root)
SKILLS_REGISTRY_URL=https://raw.githubusercontent.com/mia-org/skills/main/registry.json
SKILLS_REGISTRY_CACHE_TTL_MS=600000          # TTL cache (default 5 min)
SKILLS_REGISTRY_ALLOWED_DOMAINS=cdn.mia-org.com  # domini extra per download ZIP
```

---

## 16. Pattern comuni

### PDF con tabella (Python, fpdf2)

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
          rows:  { type: array, description: "Lista di {voce, importo}" }
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
        "message": f"PDF '{title}' generato. Scarica: /api/files/raw?rel={_quote(rel)}"
    }))

if __name__ == "__main__":
    try: main()
    except Exception as e:
        import traceback
        print(json.dumps({"success": False, "error": str(e), "stack": traceback.format_exc()}))
        sys.exit(1)
```

---

### PDF da HTML (Node.js, Puppeteer)

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
          title:   { type: string, description: "Titolo (testo puro)" }
          content: { type: string, description: "Corpo HTML" }
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
        message: `PDF generato. Scarica: ${downloadUrl}`
    }));
}
main().catch(e => { console.log(JSON.stringify({success:false,error:e.message})); process.exit(1); });
```

---

### Chiamare API esterna (Python)

```yaml
config:
  - key: API_KEY
    description: "Chiave API"
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

## 17. Creare skill con l'aiuto dell'AI

Usa questo prompt in chat (o chiedilo direttamente all'agente):

**Skill oneshot (script singolo):**
```
Crea una skill per Arkimede che [descrizione funzionalità].

Specifiche:
- Linguaggio: [python | node | javascript]
- Input: [elenco campi con tipo e descrizione]
- Output: [cosa deve restituire / quali file generare]
- Dipendenze: [eventuali librerie PyPI o npm]
- Configurazioni: [eventuali variabili configurabili]

Genera:
1. SKILL.md: frontmatter YAML (name, description, runtime con deps/config/scripts+input_schema)
   + istruzioni chiare per il LLM nel corpo (quando usarla, ⚠️ regola download_url)
2. scripts/main.[py|js] funzionante e testabile

Segui queste convenzioni:
- Protocollo stdin/stdout JSON
- _config per variabili di sistema iniettate
- download_url sempre con ?rel= (mai path assoluto)
- safe_text() per testi in PDF Python (fpdf2)
- Template Node: readFileSync(0,'utf8') → JSON.parse → console.log(JSON.stringify(...))
```

**Skill multi-script (con marker @tool):**
```
Crea una skill per Arkimede con più script: [script_1.py, script_2.py, ...].

Per ogni script:
- Descrizione, input e output separati

Genera:
1. SKILL.md con frontmatter (runtime.scripts: tutti gli script + input_schema separati)
   e nel corpo i marker <!-- @tool: nome_script.py --> per ogni script.
   Struttura richiesta:
   - Sezione condivisa (prima del primo marker): titolo, routing table (quale script per quale azione)
   - Una sezione <!-- @tool: ... --> per ogni script: input, output, esempi
3. Tutti gli script funzionanti

⚠️ Il nome nel marker deve corrispondere esattamente al filename in runtime.scripts (senza "scripts/").
```

**Skill con daemon (watch/monitor):**
```
Crea una skill per Arkimede che [descrizione funzionalità] e include un daemon
di monitoraggio che notifica il backend quando [condizione da monitorare].

Specifiche daemon:
- Linguaggio: python
- Polling ogni: [N secondi, configurabile]
- Evento emesso: [nome_evento] con payload { [campi] }
- Errori critici: [quando terminare il daemon]
- Configurazioni: [variabili config necessarie, es. API_KEY, POLL_INTERVAL]

Genera:
1. SKILL.md con frontmatter runtime.scripts (mode: daemon per lo script background) + runtime.config
2. SKILL.md con sezione daemon (⚠️ NON invocato dal LLM, formato evento push)
3. scripts/daemon_[nome].py con: lettura _config da stdin, graceful shutdown SIGTERM,
   push_event() con header x-internal-token, gestione errori transitori vs critici
```

---

## Riepilogo checklist

Prima di caricare la skill, verifica:

**Script oneshot:**
- [ ] `SKILL.md` con frontmatter: `name`, `version`, `description`, `runtime.scripts`
- [ ] `SKILL.md` presente con istruzioni chiare e regola `download_url`
- [ ] **Sezione condivisa** del SKILL.md contiene il callout con i nomi tool canonici (`skill_{name}_{script}`) e l'avviso "NON chiamare mai"
- [ ] **Ogni sezione script** ha la riga `**Tool name (usa questo nome esatto):** \`skill_xxx_yyy\``
- [ ] Usare marker `<!-- @tool: nome_script.py -->` per **ogni** script (anche script singolo), nome senza `scripts/` prefix
- [ ] Ogni script restituisce JSON su stdout (ultima riga valida)
- [ ] Path dei file salvati calcolati con `os.path.abspath()` / `path.resolve()`
- [ ] `download_url` usa `?rel=` relativo a `UPLOAD_DIR`
- [ ] Nessuna dipendenza da path locali nell'output (no path assoluti del filesystem nel JSON finale)
- [ ] Script gestisce gli errori con `try/except` o `.catch()` e li riporta in JSON
- [ ] **Dati sensibili** (token OAuth, secret): salvati via API interna, mai nell'output dello script
- [ ] **Tool di sistema** dichiarati in `dependencies.system.nix` (non chiamare binari non dichiarati)

**Script daemon (in aggiunta):**
- [ ] `mode: daemon` impostato nel frontmatter di `SKILL.md` (runtime.scripts) per lo script background
- [ ] Il daemon legge `_config` da stdin all'avvio (non da `os.environ`)
- [ ] Variabili configurabili lette da `cfg = data.get('_config', {})`, non da `os.environ`
- [ ] Gestione SIGTERM/SIGINT con `signal.signal()` per graceful shutdown
- [ ] `push_event()` include sempre `skill_id`, `user_id`, `daemon_id`, `event_type`, `payload`
- [ ] Header `x-internal-token` presente in ogni richiesta a `PUSH_URL`
- [ ] Errori critici (auth, config mancante): `push_event('auth_error', ...)` + `sys.exit(1)`
- [ ] Errori transitori (rete, rate limit): log + continua il loop (no exit)
- [ ] Il SKILL.md specifica che il daemon NON va invocato dal LLM

---

## 18. Skill descrittive (agentskills.io), Sandbox e compilazione

Una skill può essere **tipizzata** o **descrittiva** (campo `kind`, derivato all'install):

| | `typed` | `descriptive` |
|---|---|---|
| Frontmatter | ha `runtime.scripts` con `input_schema` | **nessun** manifest script (solo `name`/`description` + `scripts/`) |
| Esposizione | ogni script è un **tool LangGraph** (RPC tipizzato) | nessun tool: istruzioni iniettate, esecuzione **via Sandbox** |
| Formato | estensione del progetto | **agentskills.io "puro"** (portabile 1:1) |

### Skill descrittive (formato agentskills.io puro)

Cartella con `SKILL.md` (frontmatter minimo `name`+`description` + istruzioni) e una `scripts/` (+ `references/`, `assets/`, qualunque file). All'uso, il backend **stagia** i file della skill in `/workspace/skills/<nome>/` del sandbox; l'agente legge le istruzioni ed esegue gli script da lì con `run_in_sandbox` (es. `python skills/<nome>/scripts/x.py`). Lo staging si **rinfresca** se la skill viene aggiornata.

### Sandbox (`run_in_sandbox`)

Tool built-in per eseguire **codice/shell arbitrari** (`python`/`node`/`shell`) in un container-job effimero blindato, con **workspace persistente per-chat** (file e deps installate restano tra i turni).

- **Abilitazione** (admin → Impostazioni → AI → Sandbox): master switch globale (default OFF) + allowlist team/progetti. Admin sempre permesso.
- **Isolamento**: container-job via broker (cap-drop ALL, read-only, uid non-root, limiti). **Fail-closed** senza broker (in-process solo con `SANDBOX_ALLOW_INPROCESS=1`, dev).
- **Rete**: `none` (default) | `egress` (allowlist proxy) | `open` (internet pieno). Con `open` l'agente installa deps a runtime: `pip install --user <pkg>` / `npm install <pkg>` (persistono nel workspace).
- **`apt`/pacchetti di sistema**: NON installabili (container non-root + rootfs read-only) — solo pacchetti di linguaggio.
- **Hygiene**: GC dei workspace per-TTL, quota disco per-sessione, download dei file generati dalla chat.

### Compila a tool (descriptive → typed)

Dal drawer della skill descrittiva, **"Compila a tool"** chiede all'**AI** di dedurre un `input_schema` per ogni script (da codice + `SKILL.md`); rivedi/modifichi la proposta e **confermi**. Il manifest viene scritto in `runtime.scripts` nel frontmatter di `SKILL.md` (fonte di verità, mono-direzionale) e un reinstall promuove la skill a `typed`, esponendo gli script come tool tipizzati. API: `POST /api/skills/:id/propose-compilation` → `POST /api/skills/:id/compile`.

---

*Versione: maggio 2026 — include Marketplace + Registry GitHub + API interne (config vars sicure, query SQL su datasource, ricerca semantica e indicizzazione vector store) + Daemon (background / watch) + JS sandbox con globali `input`/`config` + Dipendenze di sistema via Nix + Marker `@tool` per SKILL.md selettivo + **Enabled toggle** (abilitare/disabilitare skill senza eliminarle) + **SSE file events** (rilevamento automatico file prodotti dai tool via `onToolResult`) + **Compat agentskills.io** (SKILL.md con frontmatter, skill descrittive) + **Sandbox** (`run_in_sandbox`: codice/shell arbitrari, workspace per-chat, rete gated) + **Compila a tool** (descriptive→typed, AI propone + conferma)*
