# Arkimede — Guida di Utilizzo e Sviluppo

> Piattaforma AI multi-utente con agente configurabile, tool custom (HTTP/SQL/RAG),
> server MCP, Electron bridge e supporto multi-LLM / multi-vector-DB.

---

## Indice

1. [Prerequisiti](#1-prerequisiti)
2. [Primo avvio (setup completo)](#2-primo-avvio-setup-completo)
3. [Avvio sviluppo quotidiano](#3-avvio-sviluppo-quotidiano)
4. [Configurazione sistema AI (admin)](#4-configurazione-sistema-ai-admin)
5. [System prompt a 4 livelli](#5-system-prompt-a-4-livelli)
6. [Tool custom](#6-tool-custom)
7. [Sorgenti dati (DataSource)](#7-sorgenti-dati-datasource)
8. [Server MCP](#8-server-mcp)
9. [Gestione documenti (RAG)](#9-gestione-documenti-rag)
10. [Configurazione embedding](#10-configurazione-embedding)
11. [Configurazione Vector DB](#11-configurazione-vector-db)
12. [Skills](#12-skills)
13. [Flows — workflow deterministici](#13-flows--workflow-deterministici-a-blocchi)
14. [Multi-Agent — agenti e team](#14-multi-agent--agenti-e-team)
15. [Auto-Scheduling — automazioni dalla chat](#15-auto-scheduling--programmare-automazioni-dalla-chat)
16. [Attività in corso — cruscotto](#16-attività-in-corso--cruscotto-unificato)
17. [Sicurezza & isolamento](#17-sicurezza--isolamento)
18. [Ottimizzazione token e costi](#18-ottimizzazione-token-e-costi)
19. [Architettura per sviluppatori](#19-architettura-per-sviluppatori)
20. [Schema DB e migrazioni](#20-schema-db-e-migrazioni)
21. [API di riferimento](#21-api-di-riferimento)
22. [Troubleshooting](#22-troubleshooting)
23. [Client da terminale (CLI)](#23-client-da-terminale-cli)

---

## 1. Prerequisiti

- **Node.js** ≥ 20 (solo per la modalità dev ibrido; in full-Docker non serve)
- **Docker** / Docker Desktop con Compose v2 — esegue postgres, qdrant, redis, embedding, skill-executor e (in full-Docker) backend e frontend
- **Chiavi API LLM/embedding:** si inseriscono dalla **UI admin** dopo l'avvio (Impostazioni → Sistema AI), non via env. Tieni a portata la chiave del provider che userai (Anthropic, OpenAI, Gemini, ecc.).
- **Opzionali:**
  - Electron + npm — solo per MCP transport `remote`

---

## 2. Primo avvio (setup completo)

> ### ⭐ Via più rapida — l'installer guidato
>
> Da un clone pulito, un comando fa tutto:
>
> ```bash
> git clone <repo-url> && cd arkimede
> ./scripts/install.sh
> ```
>
> Fa il preflight Docker, **genera tutti i segreti**, ti fa scegliere un livello di sicurezza
> (Standard / Isolato / Massimo), builda le immagini necessarie e avvia l'intero stack — poi ti dà
> `./scripts/compose.sh` per gestirlo (`ps | logs -f | down`). È idempotente; anteprima con
> `./scripts/install.sh --dry-run`. **È la via consigliata** — i passi manuali sotto sono per lo
> sviluppo o il controllo fine.

> **Alternative manuali** (scegline una) — entrambe usano lo **stesso** `.env` di **root**:
> - **A — Tutto in Docker** (per provare/produzione): ogni servizio gira in container. → [§ 2.6](#26-avvio-completo-in-docker-tutti-i-servizi-in-container).
> - **B — Dev ibrido** (per sviluppare): infra in Docker, backend/frontend in locale con hot-reload. È il percorso descritto in 2.1 → 2.4.

### 2.1 Clona e configura le variabili d'ambiente

```bash
git clone <repo-url>
cd arkimede
```

C'è **un solo `.env`, alla root**, usato da entrambe le modalità: in dev il backend
lo legge da `../.env`; in Docker i valori container-specifici (host servizi, path
`/app/...`) sono sovrascritti dal `docker-compose.yml`.

```bash
cp .env.example .env
# Obbligatorie: RUN_TOKEN_SECRET e TOOL_SECRETS_KEY (openssl rand -hex 32),
#               JWT_SECRET, DB_PASSWORD, SERVICE_API_KEY (auth mesh backend↔executor↔broker)
# Le chiavi LLM/embedding NON vanno qui: si configurano da UI dopo l'avvio (§ 2.5).
```

Per la **modalità B (dev ibrido)** compila nel `.env` almeno (LLM/embedding/vector DB si configurano poi da UI, § 2.5):

```bash
JWT_SECRET=scegli-una-stringa-lunga-e-casuale
TOOL_SECRETS_KEY=$(openssl rand -hex 32)   # chiave AES per crittografia
RUN_TOKEN_SECRET=$(openssl rand -hex 32)   # firma token interni /internal/* (solo backend)
SERVICE_API_KEY=$(openssl rand -hex 32)    # auth mesh backend→executor→broker (obbligatoria)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=arkimede
```

### 2.2 Avvia l'infrastruttura Docker (modalità B — dev ibrido)

Servizi di supporto in container; backend e frontend girano poi in locale (2.3–2.4):

```bash
# Minimo per partire: DB + vector DB + coda (BullMQ)
docker compose up postgres qdrant redis -d

# Aggiungi embedding e skill-executor se usi RAG locale e/o le Skill:
docker compose up postgres qdrant redis embedding skill-executor -d

docker compose ps   # attendi che siano "healthy"
```

> Con `docker compose up` (senza `-f`) si applica in automatico `docker-compose.override.yml`, che riespone le porte host (5432/6333/6379/8000) per raggiungere i servizi dalla macchina locale.

### 2.3 Applica le migrazioni e avvia il backend

```bash
cd backend
npm install
npm run migration:run   # crea tutte le tabelle
npm run start:dev       # → http://localhost:3000
```

Al primo avvio, `app_config` viene inizializzata con il **system prompt di default** (da `src/prompts/system.prompt.ts`). Provider LLM, embedding e vector DB si configurano poi dalla UI admin (§ 2.5).

### 2.4 Avvia il frontend

```bash
cd frontend
npm install
npm run dev   # → http://localhost:5173
```

Registra il primo account — il primo utente registrato diventa automaticamente admin.

### 2.5 Configura il sistema AI (una tantum, da UI admin)

Accedi con l'account admin → **Impostazioni → Sistema AI**:

1. **Provider LLM** — seleziona il provider e inserisci l'API key (salvata cifrata nel DB)
2. **Provider embedding** + **Vector DB** — seleziona e configura
3. **System prompt base** — personalizza le istruzioni globali dell'agente

### 2.6 Avvio completo in Docker (tutti i servizi in container)

Alternativa alla modalità B: nessuna dipendenza locale, tutto in container (postgres, qdrant, redis, embedding, skill-executor, **backend**, **frontend**). Le migration vengono applicate automaticamente all'avvio del backend (`migrationsRun: true`).

> **🚀 Installer guidato (consigliato).** Invece dei passi manuali sotto, puoi usare
> `./scripts/install.sh`: fa il preflight Docker, genera i segreti deboli/mancanti, ti
> chiede il **livello di sicurezza** (vedi § 2.7), builda solo le immagini necessarie,
> prepara le dir e avvia lo stack. Genera anche `scripts/compose.sh`, un wrapper che
> ricorda la catena `-f` scelta (`./scripts/compose.sh ps | logs -f | down`).
> Anteprima senza modifiche: `./scripts/install.sh --dry-run`.

```bash
cp .env.example .env        # compila RUN_TOKEN_SECRET, TOOL_SECRETS_KEY, JWT_SECRET, DB_PASSWORD (LLM/embedding: da UI)

# Dev (porte host riesposte da docker-compose.override.yml, auto-merge):
docker compose up -d --build

# Produzione (solo file base: niente porte host sui servizi interni):
docker compose -f docker-compose.yml up -d --build

docker compose ps           # attendi che tutti siano "healthy"
```

- Frontend → **http://localhost:5173** · Backend/API → **http://localhost:3000** · Swagger → **/api/docs**
- In **produzione** sono esposti all'host **solo** backend (3000) e frontend (5173); gli altri servizi parlano per nome sulla rete interna Docker.
- Registra il primo account → diventa **admin**. Poi configura il sistema AI da UI (§ 2.5).

### 2.7 Strati di sicurezza (overlay opzionali)

> **Scorciatoia:** `./scripts/install.sh` mappa questi overlay su tre **livelli di
> sicurezza** scelti a runtime — **L1 Standard** (base), **L2 Isolato** (+ broker), **L3
> Massimo** (+ broker + egress, gVisor opzionale) — e si occupa di build, dir e avvio.
> Le sezioni sotto restano il riferimento per chi vuole comporre gli overlay a mano.

Gli overlay si **sommano** al file base con `-f`. Riepilogo dei 4 file Compose:

| File | Quando si carica | Cosa fa |
|---|---|---|
| `docker-compose.yml` | sempre (base) | Config sicura prod: servizi interni senza porte host |
| `docker-compose.override.yml` | auto con `docker compose up` | Dev: riespone le porte host |
| `docker-compose.egress.yml` | opt-in `-f` | **C1** — egress allowlist (executor su rete interna + proxy squid) |
| `docker-compose.broker.yml` | opt-in `-f` | **D2** — container-per-job blindato via broker |

```bash
# Base prod
docker compose -f docker-compose.yml up -d

# + egress allowlist (C1): i domini consentiti si dichiarano in egress-proxy/squid.conf
docker compose -f docker-compose.yml -f docker-compose.egress.yml up -d

# + container-per-job (D2): prima builda l'immagine runner, imposta HOST_DATA_DIR nel .env
docker build -t pa-runner ./runner
docker compose -f docker-compose.yml -f docker-compose.broker.yml up -d

# Full hardened (C1 + D2)
docker compose -f docker-compose.yml -f docker-compose.egress.yml -f docker-compose.broker.yml up -d
```

> **Broker (D2):** richiede `HOST_DATA_DIR` (path host assoluto) nel `.env` e le sottocartelle scrivibili dall'uid dell'executor. Preparale con **`./scripts/bootstrap-broker.sh`** (legge `HOST_DATA_DIR` dal `.env`, crea le dir e applica `chmod 0777` solo a quelle scrivibili dai job, poi verifica l'immagine `pa-runner`). Equivalente manuale: `mkdir -p "$HOST_DATA_DIR"/{skills,work,state,skills-output,sandbox} && chmod 0777 "$HOST_DATA_DIR"/{work,state,skills-output,sandbox}`.

### 2.8 Aggiornare un deployment esistente

Per portare un deployment attivo a una versione più recente:

```bash
./scripts/update.sh
```

Fa il backup dei dati, `git pull`, ricostruisce e riavvia — preservando i volumi e il `.env`. Flag: `--yes` (nessuna conferma), `--no-backup`.

Sotto il cofano, in ordine: **backup** (`scripts/backup.sh`) → **`git pull --ff-only`** → segnala eventuali **nuove variabili di `.env.example`** assenti nel tuo `.env` → **ricostruisce le immagini job del broker** (`pa-runner` / `pa-egress-proxy`) *solo se* il tuo profilo le usa e `runner/` o `egress-proxy/` sono cambiati → **`docker compose up -d --build`** → **health check**.

Quattro cose lo rendono sicuro, utili da capire se aggiorni a mano:

- **I tuoi dati persistono.** Postgres, `uploads`, `skills_data` e `qdrant_data` stanno in volumi con nome che un rebuild non tocca.
- **Le migration sono automatiche.** Il backend applica le migration pendenti all'avvio (`migrationsRun: true`) — nessuno step manuale sul DB.
- **Il `git pull` è obbligatorio e separato.** `install.sh` e `update.sh` buildano dalla working tree così com'è; né `install.sh` né un semplice `up --build` scaricano codice nuovo. Solo `git pull` lo fa. (`.env`, `scripts/compose.sh` e `scripts/.compose-profile` sono gitignored, quindi il pull non li sovrascrive.)
- **Le immagini del broker NON vengono ricostruite da `up --build`.** `pa-runner` (L2/L3) e `pa-egress-proxy` (L3) sono referenziate per nome-immagine, non con `build:`. Se `runner/` o `egress-proxy/` sono cambiati, ricostruiscile a mano: `docker build -t pa-runner ./runner` e, per L3, `docker build -t pa-egress-proxy ./egress-proxy`. `update.sh` lo fa per te quando il loro sorgente è cambiato.

**Equivalente manuale / non interattivo** (senza `update.sh`):

```bash
./scripts/backup.sh                                   # prima uno snapshot
git pull                                              # porta il codice nuovo
# nuove variabili obbligatorie? confronta e modifica .env a mano:
diff <(grep -oE '^[A-Z_]+=' .env.example | sort) <(grep -oE '^[A-Z_]+=' .env | sort)
docker build -t pa-runner ./runner                    # solo se usi L2/L3 e runner/ è cambiato
docker build -t pa-egress-proxy ./egress-proxy        # solo se usi L3 e egress-proxy/ è cambiato
./scripts/compose.sh up -d --build                    # rebuild + restart; le migration girano al boot
curl -s localhost:3000/api/health                     # verifica
```

> **Rilanciare `install.sh`** funziona anch'esso come aggiornamento (è idempotente e ricostruisce le immagini del broker), ma **solo dopo** un `git pull` — da solo ricostruisce la versione già su disco. Per un deployment attivo preferisci `update.sh`.

**Rollback.** Ogni esecuzione lascia uno snapshot in `backups/arkimede-backup-<timestamp>/`. Per ripristinare il database: `gunzip -c backups/<snapshot>/db.sql.gz | ./scripts/compose.sh exec -T postgres psql -U <DB_USER> -d <DB_NAME>`. I tarball dei volumi (`uploads`/`skills_data`/`qdrant_data`) si ripristinano nei rispettivi volumi col pattern `docker run --rm -v <project>_<volume>:/dst …` mostrato in cima a `scripts/backup.sh`.

---

## 3. Avvio sviluppo quotidiano

```bash
# Terminal 1 — Infrastruttura (se non già in esecuzione)
docker compose up postgres qdrant redis -d   # + embedding skill-executor se servono RAG/Skill

# Terminal 2 — Backend
cd backend && npm run start:dev

# Terminal 3 — Frontend
cd frontend && npm run dev

# Terminal 4 — Bridge Electron (solo se usi MCP transport 'remote')
cd bridge && npm run dev
```

---

## 4. Configurazione sistema AI (admin)

### Provider LLM supportati

| Provider | Identificatore | Note |
|---|---|---|
| Anthropic | `anthropic` | Default |
| OpenAI | `openai` | |
| Google Gemini | `gemini` | |
| Ollama | `ollama` | Locale, `http://localhost:11434` di default |
| LM Studio | `lmstudio` | Locale, `http://localhost:1234/v1` di default |
| OpenAI-compatible | `openai-compatible` | Qualsiasi server con API compatibile OpenAI |
| DeepSeek | `deepseek` | `api.deepseek.com/v1` — modello default `deepseek-chat`. Supporta R1 reasoning |

**Come configurare:** Impostazioni → Sistema AI → sezione "Modello LLM"  
Inserisci provider, nome modello, API key (cifrata nel DB) e base URL (per provider locali).
Le configurazioni sono **multi-record** (`llm_configs`): puoi salvare più provider e designare i ruoli — uno **predefinito** (agente chat), uno **summarizer** (riassunti/compaction) e uno **vision** (task multimodali come l'OCR delle immagini caricate nel RAG; serve un modello che supporti le immagini, altrimenti l'OCR viene saltato). Ogni ruolo non designato ricade sul predefinito.

> Le chiavi LLM/embedding **non** si impostano via env: vivono cifrate nel DB. (Il codice mantiene un fallback env legacy, ma il percorso supportato è la UI.)

### Cambio provider LLM

Il cambio è immediato: la cache del modello viene invalidata alla PATCH e la prossima richiesta usa il nuovo provider. Nessun redeploy necessario.

---

## Gestione utenti & team (admin)

La piattaforma è **multi-tenant collaborativa**: un'organizzazione con utenti, ruoli e team. Tutto si gestisce da **Impostazioni → Utenti / Team** (visibili solo agli admin).

### Utenti e ruoli
- Ruoli: **admin** (gestione) e **user**. Il **primo utente registrato diventa admin**; gli altri li promuove un admin.
- Stato account: **active** / **disabled**. Un account disabilitato non può loggarsi e l'effetto è immediato (il token viene rivalidato a ogni richiesta).
- **Impostazioni → Utenti**: cerca/filtra, crea utente, modifica nome/email, cambia ruolo, attiva/disattiva, reset password, elimina.
- Protezioni: non puoi rimuovere/disabilitare/eliminare l'**ultimo admin attivo**, né compiere azioni distruttive sul tuo stesso account.

### Team
- **Impostazioni → Team**: crea un team, poi gestisci i membri assegnando ruolo **owner** o **member**.
- Un **owner** del team può pubblicare risorse (tool/skill/data source) **al team in autonomia**, senza passare dall'admin; i **member** le usano ma non le gestiscono.

### Scope delle risorse: `personal | team | org`
Ogni tool, skill e data source ha uno scope che ne definisce visibilità e gestione — e che **determina cosa carica l'agente di ciascun utente**:

| Scope | Chi la vede/usa | Chi la gestisce |
|---|---|---|
| **personal** | solo il creatore | il creatore |
| **team** | i membri del team | admin **o** owner del team |
| **org** | tutta l'organizzazione | admin |

- **Skill**: scope `team` = pubblicazione **diretta** dell'owner ai membri (nessuna review); scope `org` = invio in review e **approvazione admin**.
- La visibilità è **per-appartenenza anche per gli admin**: un admin non membro di un team non vede quelle risorse nella propria lista/agente, ma le **gestisce** comunque (per id / dalla UI Team).

> In pratica: **org** = strumenti standard e fidati per tutta l'azienda (curati dagli admin); **team** = strumenti e dati di un reparto, gestiti dai suoi owner; **personal** = sperimentazione individuale.

---

## 5. System prompt a 4 livelli

Il prompt di sistema si compone in modo additivo:

```
1. Prompt base (admin)         → identità globale dell'agente
                                     ↓
2. Prompt utente (opzionale)   → preferenze di stile o expertise
                                     ↓
3. Prompt progetto (opzionale) → contesto specifico del progetto
                                     ↓
4. Skills prompt (automatico)  → SKILL.md delle skill assegnate al progetto (selettivo)
```

**Prompt base:** Impostazioni → Sistema AI → "System prompt base"  
Viene seedato da `backend/src/prompts/system.prompt.ts` al primo avvio.

**Prompt utente:** Impostazioni → Profilo → campo "Istruzioni personalizzate"  
Esempio: `"Rispondimi sempre in italiano e in modo conciso."`

**Prompt progetto:** clicca sull'icona matita accanto al progetto nella sidebar → campo "Istruzioni AI"  
Esempio: `"Questo progetto riguarda il cliente Acme a Milano, budget 180k€."`

**Skills prompt:** costruito automaticamente da `buildSkillSystemPromptSelective()` — include solo le sezioni SKILL.md rilevanti per i tool selezionati dalla strategia di loading corrente.

---

## 6. Tool custom

I tool custom sono creati da UI (Impostazioni → Tool Custom) e registrati come `DynamicStructuredTool` LangChain. Il LLM decide autonomamente quando e come usarli in base a nome e descrizione.

### 6.1 Executor `http`

Chiama un endpoint REST esterno.

**Campi principali:**
- **URL** — es. `https://api.example.com/search?q={{query}}`
- **Metodo** — GET / POST / PUT / PATCH / DELETE
- **Headers** — es. `Authorization: Bearer {{secret.MY_TOKEN}}`
- **Body template** — oggetto JSON o stringa raw con interpolazione
- **Response path** — estrae un campo dalla risposta JSON (dot-notation, es. `results.items`)
- **Max response chars** — tronca la risposta passata al LLM (default 3000)

**Interpolazione supportata:**
- `{{paramName}}` → parametro fornito dal LLM
- `{{secret.KEY}}` → segreto cifrato dalla tabella `tool_secrets`
- `{{env.VAR}}` → variabile d'ambiente del processo NestJS

**Esempio — ricerca web:**
```
Nome: search_brave
Descrizione: Cerca informazioni aggiornate sul web usando Brave Search API.
             Usalo per domande su eventi recenti, notizie, prezzi correnti.
Parametri: query (string, required) — parole chiave da cercare
URL: https://api.search.brave.com/res/v1/web/search?q={{query}}&count=5
Headers: Accept: application/json
         X-Subscription-Token: {{secret.BRAVE_API_KEY}}
Response path: web.results
```

### 6.2 Executor `sql`

Esegue query SELECT su un database esterno configurato come DataSource.

**Modalità template (Mode A):**
```sql
SELECT nome, email, telefono
FROM clienti
WHERE regione = :regione AND attivo = true
ORDER BY nome
LIMIT 20
```
I parametri `:nome` vengono bindati in sicurezza (prevenzione SQL injection).

**Modalità Text-to-SQL (Mode B):**
- Lascia `queryTemplate` vuoto e imposta `queryParam` al nome di un parametro opzionale del tool
- Il LLM compila il parametro con una SELECT libera
- Il tool valida che sia SELECT-only, aggiunge LIMIT e la esegue
- Se il parametro è assente → restituisce schema tabelle (utile per far esplorare il DB al LLM)

**Opzioni prefetch schema:**
- `prefetchTables: true` — lista tabelle prima dell'esecuzione
- `prefetchColumns: ["clienti", "ordini"]` — colonne di tabelle specifiche
- `prefetchAllColumns: true` — tutte le colonne con cache 5 min (per context window ampie)

**DataSource** — deve essere configurata in "Impostazioni → Database" prima di creare il tool.

### 6.3 Executor `rag`

Ricerca semantica su una collection vettoriale.

**Campi:**
- **Collection** — nome della collection (deve esistere nel Vector DB configurato)
- **Limit** — numero di chunk da restituire (default 5)
- **Filter by user** — filtra per userId (per collection multi-tenant)

**Esempio — ricerca documentale:**
```
Nome: cerca_documenti
Descrizione: Cerca informazioni nei documenti aziendali indicizzati.
             Usa questo tool per rispondere a domande su procedure, schede tecniche,
             specifiche di prodotto, normative interne.
Executor: rag
Collection: agent_docs
Limit: 5
```

### 6.4 Scope e segreti

- **Personal** — visibile/usabile solo dal creatore
- **Team** — visibile/usabile dai membri del team scelto; gestione da **admin o owner del team**
- **Org** — visibile/usabile da tutta l'organizzazione; gestione riservata agli **admin**

(Stesso modello di scope per tool, skill e data source — vedi §"Gestione utenti & team".)

I segreti (API key, token) si aggiungono nella tab "Segreti" del tool e vengono cifrati con AES-256-CBC. Nel tool vengono referenziati come `{{secret.NOME_CHIAVE}}`.

### 6.5 Test inline

Ogni tool HTTP ha un pannello "Test" nella modale di modifica: inserisci i valori dei parametri e esegui il tool in modalità dry-run senza passare per l'agente.

---

## 7. Sorgenti dati (DataSource)

Le DataSource sono connessioni a database esterni riutilizzabili da più SQL tool.

**Impostazioni → Database → Nuova sorgente dati**

```
Nome: Gestionale Aziendale
Tipo di database: MySQL     # dropdown engine esplicito
Descrizione: DB sola lettura del gestionale aziendale legacy
Connection string: mysql://user:pass@host:3306/nome_db
Schema hints: (opzionale) relazioni FK implicite per DB legacy
  fornitore.COD_FOR → ordini.COD_FOR_ORD
  FLAGSTORICO = 1 = record storicizzato
Prefetch relazioni: sì (se le FK sono dichiarate nel DB)
Scope: org        # personal | team | org (org = tutta l'azienda, solo admin)
```

**Engine supportati** (si seleziona dal dropdown "Tipo di database"; il formato della
connection string dipende dall'engine):
- **Relazionali** (tool SQL): PostgreSQL `postgresql://…`, MySQL `mysql://…`,
  MariaDB `mariadb://…`, SQL Server `mssql://…` (o `Server=…;Database=…`),
  Oracle `oracle://host:1521/service`, SQLite `sqlite:///path/to/file.db`
- **MongoDB** (tool Mongo, find/aggregate): `mongodb://user:pass@host:27017/db`
- **Redis** (tool Redis, comandi whitelisted): `redis://:password@host:6379/0`
- **File-share** (cartelle di rete, usate dalla skill `file-share`): SMB/CIFS
  `smb://[DOM;]user:pass@host/share[/cartella]`, SFTP `sftp://user:pass@host:22[/cartella]`,
  WebDAV `webdavs://user:pass@host[/cartella]` (`webdav://` per http)

Per MongoDB e Redis l'introspezione è a **campionamento** (collezioni+campi / pattern di
chiavi). I tool NoSQL sono in **sola lettura** di default; la scrittura è opt-in (con
conferma per le operazioni distruttive). Le DataSource **file-share** non hanno schema:
si usano tramite la skill `file-share` (cerca/leggi/scrivi/elimina file); l'I/O avviene
nel backend, gli script non si connettono mai direttamente alla rete.

La connection string è cifrata a riposo con AES-256-GCM e non compare mai nelle API response.

**Test connessione:** pulsante "Test connessione" sotto la connection string nel form della
DataSource (prova la connessione prima o dopo il salvataggio).

---

## 8. Server MCP

**Impostazioni → Server MCP → Nuovo server**

### Transport `http` / `sse`

Per server MCP remoti già in esecuzione:

```
Nome: filesystem
URL: http://localhost:3001
Transport: http
```

### Transport `local`

Il backend NestJS spawna il processo direttamente:

```
Nome: filesystem
Comando: npx -y @modelcontextprotocol/server-filesystem /path/to/dir
Transport: local
```

- Il processo viene avviato al primo `loadToolsForUser()` e resta vivo
- Auto-restart in caso di crash (backoff 5s)
- PATH risolto dalla login shell (include nvm, Homebrew, pyenv, Cargo)

### Transport `remote`

Il processo viene spawner dal Bridge Electron sulla macchina dell'utente:

```
Nome: filesystem
Comando: npx -y @modelcontextprotocol/server-filesystem /path/to/dir
Transport: remote
```

1. Avvia il bridge Electron (`cd bridge && npm run dev`)
2. Il bridge si connette al backend via WebSocket con JWT auth
3. Il backend invia la configurazione dei server `remote`
4. Il bridge spawna i processi e registra i tool
5. Le tool call transitano via WebSocket (backend → bridge → processo → bridge → backend)

### Nomi tool MCP

Il naming segue il pattern `mcp_{server_name}_{tool_name}`:
- Server "filesystem" + tool "read_file" → `mcp_filesystem_read_file`

---

## 9. Gestione documenti (RAG)

### Caricare un documento

I file vengono caricati tramite l'UI nella chat o nel pannello file del progetto.

**Formati supportati:**

| Formato | Estrazione |
|---|---|
| PDF | pdf-parse (testo digitale) |
| DOCX | mammoth |
| XLSX / XLS | xlsx (foglio → CSV) |
| TXT, MD, CSV | testo UTF-8 diretto |
| JPG, PNG, WEBP | Claude (vision nativa) |

### Modalità allegato

| Modalità | Quando usarla |
|---|---|
| **embed** (default) | File grandi — indicizzato in Qdrant, raggiungibile via tool RAG |
| **inline** | File piccoli (<5k token) — testo incluso direttamente nel messaggio |
| **attachment** | Immagini e PDF — inviati come content block multimodale a Claude |

### Creare un tool RAG sui documenti

```
Nome: cerca_documenti
Executor: rag
Collection: agent_docs      ← collection dove i file vengono indicizzati
Limit: 5
Filter by user: sì          ← se la collection è condivisa tra utenti
```

Aggiungi questo tool con scope "Org" per renderlo disponibile a tutti gli utenti (oppure "Team" per il solo gruppo).

### Eliminare i vettori

Quando un file viene eliminato dall'UI, i vettori corrispondenti vengono rimossi automaticamente dalla collection.

---

## 10. Configurazione embedding

### Provider supportati

| Provider | Identificatore | Note |
|---|---|---|
| LM Studio | `lmstudio` | Locale, API OpenAI-compatibile |
| Ollama | `ollama` | Locale, `http://localhost:11434` |
| OpenAI | `openai` | Cloud, richiede API key (da UI) |
| VoyageAI | `voyage` | Cloud, ottimo per italiano |
| OpenAI-compatible | `openai-compatible` | Qualsiasi server compatibile |

**Configurazione:** Impostazioni → Sistema AI → sezione "Embedding"

### Cambiare provider embedding

1. Aggiorna la configurazione in Impostazioni → Sistema AI
2. ⚠️ **Reindicizza** tutti i documenti e le collection RAG — le dimensioni vettoriali potrebbero cambiare
3. Aggiorna `embeddingVectorSize` con la dimensione del nuovo modello

### Prefisso query/documento

Alcuni modelli richiedono prefissi diversi per query vs documenti:
- Esempio nomic-embed-text: `search_query: ` per query, `search_document: ` per doc
- Per `mxbai-embed-large-v1`: prefissi non necessari

---

## 11. Configurazione Vector DB

**Impostazioni → Vector DB** (solo admin)

### Provider supportati

| Provider | Note |
|---|---|
| **Qdrant** (default) | Self-hosted o cloud. URL + API key opzionale |
| **PGVector** | PostgreSQL con estensione pgvector. Connection string |
| **Chroma** | Self-hosted o cloud. URL + API key |
| **AstraDB** | DataStax cloud. URL + Application Token + keyspace |

### Cambio provider

1. Configura il nuovo provider in Impostazioni → Vector DB
2. Reindicizza i documenti perché le collection esistano sul nuovo provider

> **⚠ Cambiare Vector DB non migra i tuoi vettori.** Non esiste alcuna
> migrazione automatica tra provider. Lo switch è **non distruttivo e
> reversibile**: i vettori risiedono fisicamente solo nel provider in cui sono
> stati indicizzati, quindi i dati del vecchio provider restano intatti e
> tornando indietro sono di nuovo disponibili. Ciò che è condiviso tra i provider
> è l'**anagrafica** delle collection (nomi/config in Postgres): dopo lo switch la
> UI continua a mostrare le tue collection e i tool `search_<collection>` restano,
> ma il nuovo provider parte **vuoto** e una ricerca non trova nulla finché non
> reindicizzi i documenti. Pianifica un cambio come un'operazione "riparto e
> reindicizzo", non come uno spostamento di dati. Nota inoltre che cambiare
> provider sovrascrive l'unico URL/token salvato: reinseriscili se in seguito
> torni a un provider con chiave.

### Gestione collection

La pagina Vector DB mostra le collection create dalla piattaforma. Puoi:
- Creare nuove collection con dimensione vettoriale personalizzata
- Eliminare collection non più necessarie

---

## 12. Skills

Le Skill sono pacchetti ZIP che estendono l'AI con script Python o Node.js eseguibili nel container **skill-executor**. Ogni skill ha dipendenze isolate, istruzioni per il LLM (SKILL.md) e uno o più script.

> **Guida completa alla creazione di skill:** `SKILLS.md` (in root) — schema del frontmatter `SKILL.md` esaustivo, runner, template Python/Node/JS, API interne (save-config, datasource, vector search/ingest), daemon, Nix, capability. Questa sezione è un riassunto operativo.
>
> Le skill sono **pacchetti di terze parti autocontenuti**: il core non contiene codice ad-hoc per nessuna skill.

### 12.1 Struttura del pacchetto

```
my-skill.zip
├── SKILL.md        ← REQUIRED: frontmatter YAML (metadati + runtime) + istruzioni AI
└── scripts/
    ├── main.py     ← script eseguibile
    └── helpers.py  ← moduli importabili dallo script principale
```

### 12.2 Formato SKILL.md (frontmatter)

Metadati e manifest stanno nel frontmatter YAML in testa a `SKILL.md` (formato agentskills.io):
`name`/`description` sono standard, il resto sotto `runtime`. Dopo la chiusura `---` il corpo
Markdown sono le istruzioni per il LLM.

```markdown
---
name: nome-skill             # kebab-case, univoco per utente
version: 1.0.0
description: >
  Descrizione per l'AI — quando deve usare questa skill.
author: email@example.com
license: MIT

runtime:
  dependencies:
    python:                  # pacchetti PyPI
      - pandas>=2.0
      - requests
    javascript:              # pacchetti npm (solo per language: node)
      - puppeteer@22
  config:                    # variabili configurabili dall'utente nella UI
    - key: OUTPUT_DIR
      description: "Directory dove salvare i file generati"
      default: "${UPLOAD_DIR}/skills-output"   # ${VAR} interpolato con system vars
      required: false
      secret: false
  scripts:
    - filename: scripts/main.py
      language: python         # python | javascript | node
      description: >
        Descrizione dettagliata per il LLM: cosa fa, quando usarlo.
      input_schema:
        type: object
        required: [input1]
        properties:
          input1:
            type: string
            description: "Descrizione del parametro"
---

# Nome Skill

Istruzioni per il LLM…
```

### 12.3 Runner disponibili

| `language` | Runner | Dipendenze | Accesso Node API |
|---|---|---|---|
| `python` | subprocess `python3` | `pip install --target .deps/python` | ✗ |
| `javascript` | isolated-vm (V8 sandbox) | nessuna (`require` non disponibile) | ✗ |
| `node` | subprocess `node` | `npm install` in `.deps/node/node_modules` | ✅ |

**Scegli `node`** quando lo script necessita di: librerie npm (es. Puppeteer, pdf-lib, sharp), API Node.js native (`fs`, `https`, `child_process`).  
**Scegli `python`** per data analysis, ML, operazioni su file con librerie PyPI.  
**Scegli `javascript`** solo per computazione pura senza dipendenze esterne.

### 12.4 Protocollo stdin/stdout

Tutti i runner comunicano tramite JSON su stdin/stdout:

**Script Python:**
```python
import sys, json
data    = json.load(sys.stdin)
_config = data.get('_config', {})   # variabili di configurazione iniettate dal backend
# ... logica ...
print(json.dumps({"success": True, "result": "..."}))
```

**Script Node.js:**
```javascript
const data    = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const _config = data._config ?? {};
// ... logica ...
console.log(JSON.stringify({ success: true, result: '...' }));
```

> L'ultima riga JSON valida su stdout viene usata come output della skill.

### 12.5 Variabili di sistema (`_config`)

Il backend inietta automaticamente nel campo `_config` queste variabili:

| Variabile | Valore | Uso tipico |
|---|---|---|
| `UPLOAD_DIR` | path assoluto uploads (`./uploads` risolto) | salvataggio file |
| `SKILLS_OUTPUT_DIR` | `{UPLOAD_DIR}/skills-output` | output generici |
| `SKILLS_DIR` | `/app/skills` | read-only, base skill |
| `APP_NAME` | nome applicazione | footer documenti |
| `APP_URL` | URL base app | link download |

Più le variabili configurabili dell'utente specificate in `runtime.config` di SKILL.md (con interpolazione `${VAR}` dei valori di default).

### 12.6 Download URL

Per restituire file scaricabili dall'utente, usa il path relativo a `UPLOAD_DIR`:

```python
# Python
import os
from urllib.parse import quote as _quote
rel_path    = os.path.relpath(out_path, upload_dir_abs)
download_url = f"/api/files/raw?rel={_quote(rel_path)}"
print(json.dumps({"success": True, "download_url": download_url, "filename": out_fname}))
```

```javascript
// Node.js
const relPath    = path.relative(uploadDir, outPath).replace(/\\/g, '/');
const downloadUrl = `/api/files/raw?rel=${encodeURIComponent(relPath)}`;
console.log(JSON.stringify({ success: true, download_url: downloadUrl }));
```

⚠️ **Importante per il SKILL.md:** istruci il LLM a usare `download_url` verbatim — mai costruire URL da altri campi.

### 12.7 Caricare e configurare una skill

1. **Carica il pacchetto ZIP:** Impostazioni → Skills → Upload ZIP
2. **Attendi l'installazione** — lo status passa `pending → installing → ready`
   (se `error`, clicca il badge per vedere il log di installazione)
3. **Configura le variabili** — clicca sulla skill → tab "Configura" → imposta i valori
4. **Assegna ai progetti** — tab "Assegna" → seleziona i progetti che devono usarla
5. **Reinstalla** — se aggiorni i deps o la directory si corrompe, usa il pulsante "Reinstalla" nel drawer

### 12.8 Scope e review condivisione (marketplace interno)

| Scope | Stato | Visibilità |
|---|---|---|
| `personal` | — | Solo il proprietario |
| `team` | — | I membri del team (pubblicazione **diretta** dell'owner, **senza** review) |
| `org` | `is_approved=false` | In attesa di review admin |
| `org` | `is_approved=true` | Tutti gli utenti (tab "Skill pubbliche") |

**Pubblicare:** drawer skill → **Visibilità** → scegli `team` (pubblica subito ai membri) oppure `org` (invia in review). Disponibile solo se `status=ready`.  
**Ritirare:** riporta lo scope a `personal`.  
**Approvare (admin):** Impostazioni → Skills → tab "Review" (solo per le skill `org`)

Una skill `org + approved` compare nel tab **"Skill pubbliche"** per tutti gli utenti.  
Ogni utente può **installarla** (una sola clic) — crea una copia indipendente nella propria collezione con il proprio ciclo di vita, configurazione e assegnazioni.

### 12.9 Skills Registry (marketplace GitHub)

Il tab **"Skill pubbliche"** mostra anche le skill dal **registry GitHub pubblico**: un repository con `registry.json` + ZIP scaricabili direttamente da `raw.githubusercontent.com`.

#### Flusso installazione dal registry

```
UI → GET /api/skills/registry          (indice cachato 5 min lato server)
   → mostra lista skill con badge "Installata" se già presenti
   → click "Installa"
   → POST /api/skills/registry/install   { downloadUrl: "https://raw.githubusercontent.com/..." }
   → backend scarica il ZIP → uploadAndCreate() → risposta status: installing
   → poll automatico → status: ready
```

#### Configurazione registry

```bash
# .env — tutte opzionali
SKILLS_REGISTRY_URL=https://raw.githubusercontent.com/arkimedehq/arkimede-skills/main/registry.json
SKILLS_REGISTRY_CACHE_TTL_MS=300000          # TTL cache in ms (default: 5 min)
SKILLS_REGISTRY_ALLOWED_DOMAINS=my-cdn.com  # domini extra per download ZIP (comma-separated)
```

Default: usa il registry ufficiale della community `arkimedehq/arkimede-skills` su GitHub.  
Per usare un registry privato/aziendale: cambia `SKILLS_REGISTRY_URL`.

#### Sicurezza download

Il backend valida che `downloadUrl` provenga da un dominio nella whitelist:

| Dominio | Sempre ammesso |
|---|---|
| `raw.githubusercontent.com` | ✅ |
| `github.com` | ✅ |
| `objects.githubusercontent.com` | ✅ |
| Dominio del `SKILLS_REGISTRY_URL` | ✅ |
| Domini in `SKILLS_REGISTRY_ALLOWED_DOMAINS` | ✅ configurabili |

Solo HTTPS. URL non HTTPS vengono rifiutati con 403.

#### Formato registry.json

```json
{
  "version": "1",
  "updatedAt": "2026-05-23T00:00:00Z",
  "skills": [
    {
      "name":        "pdf-generator",
      "version":     "1.2.0",
      "description": "Genera PDF strutturati da dati tabellari",
      "author":      "autore@example.com",
      "license":     "MIT",
      "languages":   ["python"],
      "tags":        ["pdf", "report", "documenti"],
      "scriptCount": 1,
      "dependencies": { "python": ["fpdf2>=2.7"], "javascript": [] },
      "downloadUrl": "https://raw.githubusercontent.com/arkimedehq/arkimede-skills/main/skills/pdf-generator/pdf-generator-v1.2.0.zip",
      "homepage":    "https://github.com/arkimedehq/arkimede-skills/tree/main/skills/pdf-generator",
      "publishedAt": "2026-05-23T00:00:00Z"
    }
  ]
}
```

#### Refresh manuale (admin)

```bash
POST /api/skills/registry/refresh   # forza invalidazione cache
```

Disponibile anche nella UI per gli admin tramite il pulsante ↻ nel tab "Skill pubbliche".

### 12.10 API skill (completa)

```bash
# ── Upload manuale ────────────────────────────────────────────────────────────
POST /api/skills/upload                    # multipart/form-data, campo: file (.zip, max 50 MB)

# ── Registry pubblico ─────────────────────────────────────────────────────────
GET  /api/skills/registry                  # indice (cachato 5 min)
POST /api/skills/registry/install          # { downloadUrl: "https://..." }
POST /api/skills/registry/refresh          # [ADMIN] forza refresh cache

# ── CRUD ─────────────────────────────────────────────────────────────────────
GET    /api/skills                         # lista: personali + team (dei propri team) + org approvate
GET    /api/skills/:id                     # dettaglio + scripts + log
PATCH  /api/skills/:id                     # { scope: "personal" | "team" | "org", teamId? }
DELETE /api/skills/:id                     # elimina skill + file dal volume

# ── Marketplace interno ───────────────────────────────────────────────────────
POST /api/skills/:id/install               # installa copia dalla skill org approved

# ── Dipendenze ────────────────────────────────────────────────────────────────
POST /api/skills/:id/reinstall

# ── Assegnazione progetto ─────────────────────────────────────────────────────
GET    /api/skills/project/:projectId
POST   /api/skills/:id/assign/:projectId
DELETE /api/skills/:id/assign/:projectId

# ── Configurazione variabili ──────────────────────────────────────────────────
GET    /api/skills/system-vars
GET    /api/skills/:id/config
PUT    /api/skills/:id/config/:key         # { value: "..." }
DELETE /api/skills/:id/config/:key         # reset al default

# ── Admin — review ────────────────────────────────────────────────────────────
GET  /api/skills/pending-review
POST /api/skills/:id/approve
POST /api/skills/:id/reject                # { reason: "Motivo" }
POST /api/skills/:id/propose-compilation   # AI propone input_schema (descriptive→typed)
POST /api/skills/:id/compile               # { scripts: [...] } applica la compilazione
```

### 12.11 Tipo skill (`typed` / `descriptive`) e Sandbox

Il campo `kind`, derivato all'install, distingue:

- **`typed`** — il frontmatter dichiara `runtime.scripts` con `input_schema` → ogni script è un **tool LangGraph** (invocazione strutturata via executor, veloce e deterministica).
- **`descriptive`** — formato **agentskills.io "puro"** (solo `SKILL.md` + `scripts/`, senza manifest script). Niente tool tipizzati: l'agente legge le istruzioni ed **esegue i file via Sandbox**. I file della skill vengono *staged* in `/workspace/skills/<nome>/` (refresh automatico se la skill cambia).

**Sandbox** — built-in tool `run_in_sandbox(language, code)` che esegue codice/shell arbitrari in un container-job effimero blindato con **workspace persistente per-chat**:

- **Gating** (admin → Impostazioni → AI → Sandbox): master switch globale (default OFF) + allowlist team/progetti; admin sempre permesso.
- **Isolamento**: via `broker` (container-job, cap-drop ALL, read-only, uid non-root). **Fail-closed**: senza broker rifiuta, salvo `SANDBOX_ALLOW_INPROCESS=1` (solo dev, non isolato).
- **Rete** (tier unificati): `none` (nessuna rete) | `internal` (solo backend `/internal/*`, no WAN) | `internet` (domini in allowlist via egress-proxy) | `open` (internet pieno → `pip install`/`npm install` a runtime; richiede la rete open in `BROKER_ALLOWED_NETWORKS`). Stesso vocabolario dei job skill; `internal` è il pavimento sempre attivo sotto i tier superiori.
- **Hygiene**: GC dei workspace per-TTL, quota disco per-sessione, download dei file generati dalla chat (`GET /api/sandbox/file`, scoped sull'accesso alla chat).

### 12.12 Compila a tool (descriptive → typed)

Dal drawer di una skill descrittiva, **"Compila a tool"** chiede all'**AI** di dedurre un `input_schema` per ogni script (leggendo codice + `SKILL.md`); l'admin/owner **rivede e conferma** la proposta, poi il manifest viene scritto in `runtime.scripts` nel frontmatter di `SKILL.md` (fonte di verità) e un reinstall promuove la skill a `typed`, esponendo gli script come tool. Endpoint: `propose-compilation` → `compile`.

---

## 13. Flows — workflow deterministici a blocchi

Quando l'agente "che improvvisa" non basta e serve un'azione **ripetibile e prevedibile**, si usa un **Flow**: un grafo a blocchi (canvas React Flow) eseguito come **DAG** con rami paralleli. Impostazioni → **Flows**.

- **Tipi di nodo (12):** `tool` · `llm` · `condition` · `http` · `skill` · `transform` (JS sandbox) · `flow` (sub-flow) · `agent` · `team` · `loop` (map su array) · `join` (fan-in) · `chat` (posta un messaggio in una chat).
- **Binding dati fra nodi:** `{{ input.x }}` (input del flow) e `{{ nodes.<id>.output }}` (output di un nodo precedente).
- **Trigger:** `manual` · `cron` (ricorrente) · `scheduled` (una volta) · `webhook` (endpoint pubblico senza JWT) · `chat-as-tool` (il flow diventa un tool dell'agente). Scheduler su **BullMQ + Redis**.
- **Robustezza:** error-policy per nodo (`stop`/`continue`/`retry`), **test run per-nodo** (esegue solo il subgraph dei predecessori), storico esecuzioni con timeline per-nodo.
- Il nodo `transform` esegue JS isolato (`isolated-vm`) via endpoint `/eval` dell'executor.

> Flows e Multi-Agent sono complementari: un nodo può essere un agente/team e un agente può invocare un flow (come tool).

API principali: `GET|POST|PUT|DELETE /api/flows/:id` · `POST /api/flows/:id/run` · `GET /api/flows/:id/runs` · `POST /api/flows/webhook/:token`.

---

## 14. Multi-Agent — agenti e team

Definisci **agenti** riusabili e componili in **team** con una topologia. Impostazioni → **Agenti** / **Team agenti**.

- **Agente** = system prompt + modello (`LlmConfig`) + filtro sui tool disponibili.
- **Topologie team:** `supervisor` (un agente delega agli altri e sintetizza) · `sequential` (A→B→C) · `parallel` (in contemporanea + aggregazione).
- Una **chat** può girare con un team (selettore nel footer): gli step per-agente sono mostrati live via evento SSE `agent_step`. Associazione: `PATCH /api/chats/:id/agent-team`.
- Routing **cross-provider** (nessuna logica single-provider).

API: `GET|POST|PUT|DELETE /api/agents/:id` · `POST /api/agents/:id/run` · `GET|POST|PUT|DELETE /api/agent-teams/:id` · `PUT /api/agent-teams/:id/members` · `POST /api/agent-teams/:id/run`.

---

## 15. Auto-Scheduling — programmare automazioni dalla chat

Chiedi in chat *«ogni mattina alle 8 controlla la mail e riassumi»* e l'automazione viene **preparata** e programmata davvero.

- Il built-in tool **`schedule_task`** interpreta la richiesta, sceglie i tool necessari (default: nessuno → economico) e prepara l'automazione; l'utente la **conferma** (sicuro di default: non scatta finché non confermata).
- Al fire, un **runner headless** ri-esegue l'agente con l'istruzione e **consegna l'esito** via notifica e/o in un **thread chat** dedicato (con unread badge). Può usare un team di agenti.
- Built-in di supporto: `get_current_datetime` (l'agente non sbaglia data/ora); guard sui `runAt` nel passato.
- **Guardrail** configurabili (env): `SCHED_MAX_TASKS_PER_USER`, `SCHED_MAX_ACTIVE_RECURRING`, `SCHED_MAX_TOKENS_PER_RUN` (oltre soglia → auto-disattivazione). Token/costo per run visibili in UI.

Gestione: Impostazioni → **Automazioni**. API: `GET /api/scheduled-tasks` · `POST /api/scheduled-tasks/:id/activate` · `PATCH /api/scheduled-tasks/:id/enabled` · `DELETE /api/scheduled-tasks/:id`.

---

## 16. Attività in corso — cruscotto unificato

Impostazioni → **Attività**: vista **sola-lettura** che aggrega tutto ciò che è in esecuzione o schedulato per te — **daemon skill** attivi, **automazioni**, **flow** con trigger cron/scheduled e gli **ultimi run**. Contatori in alto, refetch automatico ogni 10s. `GET /api/activity`.

---

## 17. Sicurezza & isolamento

Modello a **capability**: ogni potere (rete, filesystem, operazioni SQL, MCP `local`) è **dichiarato + approvato**, con default sicuro e soffitto legato all'identità.

| Area | Misura |
|---|---|
| Segreti | AES-256-GCM autenticata; `TOOL_SECRETS_KEY` obbligatoria (fail-fast all'avvio) |
| Docker prod | Servizi interni senza porte host, password obbligatorie; porte solo in dev (override) |
| MCP | `local` solo admin; guard anti-**SSRF** su `http`/`sse` (blocca metadata EC2, RFC1918, localhost) |
| Anti-SSRF DataSource | La stessa guardia su **tutti** i DataSource/DB (SQL/Mongo/Redis/file-share): metadata/link-local sempre bloccati; host privati gated da policy admin (`dataSourceAllowPrivateHosts`, default on, + allowlist host/IP/CIDR) — *Impostazioni → Sicurezza DataSource* |
| Skill (untrusted) | Egress allowlist `network:` (C1) · filesystem per-tenant access-aware (C2) · **isolamento fisico output per-utente** `skills-output/<userId>` · container-per-job blindato via broker (D2) · capability `filesystem`/`sql.operations` · checksum registry (E3) |
| File generati | Gli output di skill/sandbox sono tracciati come `File` e allegati al messaggio → visibili nel pannello file di chat/progetto; download `?rel=` confinato all'owner, condivisione via download by-id access-aware |
| Download file | Solo `?rel=` access-aware (`canAccess`); niente `?path=` assoluto |
| Tracciabilità | Audit log strutturato sui chokepoint (auth, admin, esecuzioni, file, SQL, MCP) con identità "runs-as" |

**Confine di fiducia:** il backend è trusted-ma-esposto e **non** detiene capability host-root; il socket Docker vive **solo** nel broker (componente minimale e interno). Attivazione degli strati di isolamento: § 2.7.

---

## 18. Ottimizzazione token e costi

### 13.1 Tool Loading Strategy

L'agente carica per default solo i tool rilevanti per la query corrente, riducendo l'input token del 40-60%.

**Impostazioni → Profilo** (per-utente) o **Impostazioni → Sistema AI** (globale):

| Strategia | Comportamento | Quando usarla |
|---|---|---|
| `semantic_rag` | Embedding della query → cosine similarity sui tool | Default — ottima con tool numerosi e descrizioni ricche |
| `keyword_bm25` | Score BM25 su nome+descrizione | Tool con keyword specifiche, no embedding provider |
| `always_inject_all` | Tutti i tool sempre | Debug, pochi tool (<5), casi in cui ogni tool può servire |

**Max tools per richiesta:** numero massimo di extra-tool iniettati (built-in sempre inclusi).  
**Schema format:**
- `full` — schema completo con tutti i parametri (default)
- `compact` — schema ridotto, senza description verbose
- `names_only` — solo nomi tool (risparmio massimo, meno guida al LLM)

### 13.2 Memoria della conversazione: budget, trim e compaction

A ogni messaggio l'agente NON riceve l'intera chat, ma una storia ricostruita entro un
**budget di token** (`maxHistoryTokens`). Due meccanismi distinti la governano — capire la
differenza evita sorprese tipo "il modello ha dimenticato cosa ci siamo detti":

**1. Trim (sempre attivo).** Qualunque sia la configurazione, prima di ogni chiamata LLM la
storia viene misurata e, se supera il budget, i **turni più vecchi vengono scartati** finché
rientra. Il taglio è a turni interi (mai a metà di una coppia domanda/risposta o di una
sequenza tool-call/risultato). Il trim non avvisa: l'eccedenza sparisce e basta.

**2. Compaction / rolling summary (toggle, default ON).** Con `historyCompactionEnabled`
attivo, quando la storia supera la soglia (`historyCompactionThreshold`, default 80% del
budget) i turni più vecchi **vengono riassunti** da un LLM dedicato (config `isSummarizer`)
invece che persi: il riassunto è persistito sulla chat (`chat.summary`, incrementale) e
iniettato nel system prompt, dove **non consuma budget history**. I turni recenti restano
verbatim. Spegnere la compaction NON significa "passa tutta la storia": significa che
l'eccedenza oltre il budget viene buttata via dal trim invece che riassunta.

> ⚠️ Il peso di un turno include anche i **risultati dei tool** (replayati nella storia per
> dare continuità al modello, troncati a 3 000 caratteri l'uno — env
> `REPLAY_TOOL_OUTPUT_MAX_CHARS`): un turno con molte query SQL pesa molto più del suo
> testo visibile.

**Parametri (Impostazioni → Sistema AI, admin; override per-utente in Profilo):**

| Parametro | Default | Note |
|---|---|---|
| `maxHistoryTokens` | 30 000 | Budget storia (~4 char/token). Più alto = più memoria contestuale ma più token input per messaggio (la storia non è coperta dal prompt caching). Override per-utente: `Impostazioni → Profilo` (vuoto = globale) |
| `historyCompactionEnabled` | ON | OFF = l'eccedenza viene scartata, non riassunta (sconsigliato per chat lunghe) |
| `historyCompactionThreshold` | 80 % | Soglia di scatto della compaction; dopo lo scatto restano verbatim gli ultimi ~40% del budget |

Il limite di passi dell'agente (chiamate LLM ↔ tool per un singolo messaggio) è
configurabile via env `AGENT_RECURSION_LIMIT` nel `.env` del backend (default 50 step ≈ 25
giri LLM, minimo applicato 10): superarlo produce l'errore `GraphRecursionError` — di norma
indica che l'agente sta cercando dati che non esistono o che gli manca contesto (vedi
`DATAFLOW_AGENT.md` per il flusso completo con diagrammi).

### 13.3 Prompt Caching

Il backend sfrutta automaticamente il prompt caching del provider:

| Provider | Tipo | Note |
|---|---|---|
| **Anthropic** | Esplicito — `cache_control: { type:'ephemeral' }` | TTL 5 min. Scrittura ×1.25 costo, lettura ×0.10 (90% risparmio). Il system prompt intero viene marcato. |
| **OpenAI** | Automatico sul prefisso stabile | Prefisso ≥1024 tok cachato automaticamente; 50% sconto. No marcatori necessari. |
| **Gemini** | Automatico | `cachedContentTokenCount` mappato in LangChain → loggato come `cache_read`. |
| **DeepSeek** | Automatico | `prompt_cache_hit_tokens` intercettato dall'SSE interceptor in `LlmProviderService`. Logga hit/miss nel debug. |

**Come leggere i log cache:**
```
[call 1/agent] in=4911 out=118 cache(r=4850 w=61) → tool:skill_gmail_list_emails_py
[call 2/agent] in=5082 out=287 cache(r=4850 w=0) → risposta finale
Token usati: input=9993 output=405 | cache: read=9700 write=61 (2 chiamate LLM)
```

### 13.4 SKILL.md selettivo

Le skill con più script possono segmentare il SKILL.md con marker per caricare solo le sezioni pertinenti:

```markdown
<!-- SEZIONE SHARED: sempre inclusa indipendentemente dai tool selezionati -->
# Nome Skill
Descrizione generale e routing table

<!-- @tool: script_a.py -->
## Sezione per script_a.py
Dettagli di input/output per questo script...

<!-- @tool: script_b.py -->
## Sezione per script_b.py
...
```

- Tutto il testo **prima del primo marker** = sezione condivisa (sempre inclusa)
- Ogni sezione `<!-- @tool: nome.py -->` è inclusa **solo** se quel tool è stato selezionato
- Se non ci sono marker, il SKILL.md intero viene incluso (backward compatible)

---

## 19. Architettura per sviluppatori

### Flusso di una richiesta chat

```
1. Frontend → POST /api/chats/:id/messages/stream
2. MessagesController → salva messaggio utente su PostgreSQL
3. AgentService.streamResponse() chiama resolveAgent(userId, projectId, userInput, history)
4. resolveAgent() — Fase 1 (parallelo):
   a. AppConfigService.getSystemPrompt()        (cache in-memory)
   b. LlmProviderService.getModel()             (cache in-memory, ricostruisce se invalidato)
   c. CustomToolsService.loadToolsForUser()     (query DB)
   d. McpServersService.loadToolsForUser()      (http fetch o bridge registry)
   e. SkillsService.loadToolsForUser()          (skill scripts → DynamicStructuredTool)
   f. userRepo.findOne(userId)                  (systemPrompt, toolLoadingStrategy, maxHistoryTokens)
   g. projectRepo.findOne(projectId)            (systemPrompt progetto)
   h. AppConfigService.getToolLoadingConfig()   (config globale tool loading)
   i. LlmProviderService.getProvider()          (per prompt caching branch)
   resolveAgent() — Fase 2 (seriale):
   j. ToolSelectionService.applyStrategy()      (semantic_rag / bm25 / always_inject_all)
   k. SkillsService.buildSkillSystemPromptSelective() (SKILL.md solo tool selezionati)
   → buildSystemPrompt(base, user, project, skills)   ← 4 livelli
   → messageModifier con cache_control (Anthropic) o stringa (altri provider)
   → createReactAgent({ llm, tools: [...builtin, ...optimized], messageModifier })
5. LangGraph agent.stream() avvia il loop ReAct
6. Per ogni chunk:
   - text block → SSE chunk al frontend
   - tool_use block → SSE tool_call al frontend (UI mostra "Sto usando...")
   - ToolMessage → ignorato (non mostrato all'utente)
7. Al termine → salva risposta completa su PostgreSQL
```

### Aggiungere un tool built-in

1. Crea il file del tool, es. `backend/src/agent/my-tool.ts`:

```typescript
export function createMioTool(deps: MieDipendenze): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'nome_tool',               // snake_case
    description: '...',              // cruciale: il LLM decide quando usarlo
    schema: z.object({ ... }),       // Zod schema degli input
    func: async ({ ... }) => {       // deve restituire sempre una stringa
      // ...
      return risultato.toString();
    }
  });
}
```

2. Registralo in `AgentService.onModuleInit()` (l'array `builtInTools` è vuoto di
   default — i tool verticali storici sono stati rimossi a favore dei *custom tool types*):

```typescript
this.builtInTools = [
  createMioTool(meDipendenze),   // ← registra qui i tuoi tool built-in
];
```

3. Aggiungi la descrizione del tool nel `SYSTEM_PROMPT` (o dal pannello admin).

> Nota: per la maggior parte dei casi conviene usare un **custom tool** (http/sql/rag/prompt)
> o un **executor type custom** (sotto), senza toccare il codice dell'agente.

### Aggiungere un executor type custom

1. Aggiungi il tipo in `custom-tool.types.ts`:
   ```typescript
   export type ExecutorType = 'http' | 'sql' | 'prompt' | 'rag' | 'mio_tipo';
   export interface MioExecutorConfig { /* ... */ }
   ```

2. Implementa l'executor in `custom-tool.factory.ts` dentro `buildDynamicTool()`.

3. Aggiungi una migration TypeORM per aggiornare l'enum `executor_type` nel DB.

4. Aggiorna il form nella UI (`ToolsPage.tsx`, sezione `IdentitySection`).

### Aggiungere un provider LLM

1. Installa il pacchetto LangChain del provider: `@langchain/nuovo-provider`
2. Aggiungi il tipo in `app-config.entity.ts`:
   ```typescript
   export type LlmProvider = 'anthropic' | ... | 'nuovo_provider';
   ```
3. Aggiungi il case in `LlmProviderService.buildModel()`.
4. Aggiungi il default in `PROVIDER_DEFAULTS`.
5. Aggiorna la UI nel `SettingsPage.tsx` (select provider).

---

## 20. Schema DB e migrazioni

### Tabelle principali

> Nomi reali dalle entity TypeORM. Migration sequenziali in `backend/src/database/migrations/`.

```text
# Identità & collaborazione
users                     -- ruolo (admin|user), status (active|disabled), systemPrompt, preferenze tool-loading
teams                     -- team dell'organizzazione
team_memberships          -- utente ↔ team (owner|member)
projects                  -- progetti (systemPrompt per progetto, userId owner)
project_teams             -- progetto condiviso con N team (collaborator|viewer)

# Chat & contenuti
chats                     -- conversazioni (userId, projectId, agentTeamId, summary/compaction)
messages                  -- messaggi (role, content, chatId, authorId, toolCalls)
message_feedback          -- 👍/👎 per messaggio (feedback loop)
files                     -- upload/output (scope personal|team|org, userId, projectId)
notifications             -- notifiche real-time (daemon, automazioni)
user_memory               -- memoria utente persistente

# Agente: tool, dati, MCP, RAG
custom_tools / tool_secrets          -- tool http|sql|rag|prompt + segreti cifrati
data_sources                         -- connessioni DB esterne (connection string cifrata)
mcp_servers / mcp_server_secrets     -- server MCP (http|sse|local|remote) + segreti
vector_db_config / vector_collections-- provider vector DB + collection gestite

# Configurazione AI
app_config                -- singleton (id=1): system prompt base, embedding, tool-loading,
                          --   history compaction; (campi llm* legacy: la verità è llm_configs)
llm_configs               -- multi-record: provider/modello/apiKey, isDefault + isSummarizer

# Skills
skills                    -- metadati, status, scope, isApproved, enabled, packagePath
skill_scripts             -- script (filename, language, description, inputSchema, mode)
skill_config_vars         -- config var per skill (value cifrato se secret)
skill_project_assignments -- skill ↔ progetto
skill_daemons             -- daemon skill registrati (background/watch)

# Feature portanti
flows / flow_runs                          -- workflow DAG + storico esecuzioni
agents / agent_teams / agent_team_members  -- Multi-Agent (agenti, team, membership)
scheduled_tasks                            -- automazioni (Auto-Scheduling)

# Sicurezza
audit_log                 -- eventi strutturati (auth, admin, esecuzioni, file, SQL, MCP)
```

### Gestione migrazioni

```bash
# Applicare tutte le migration
npm run migration:run

# Generare una nuova migration dopo aver modificato un'entity
npm run migration:generate -- src/database/migrations/NomeMigrazione

# Visualizzare stato migration
npm run migration:show

# Rollback dell'ultima migration
npm run migration:revert
```

**Convenzione nomi:** `1778900000000-NomeMigrazione.ts` — usa timestamp progressivo per mantenere l'ordine.

**Importante:** non modificare migration già applicate in produzione. Aggiungi sempre una nuova migration.

---

## 21. API di riferimento

### Autenticazione

```bash
# Registrazione
POST /api/auth/register
{"email": "...", "name": "...", "password": "..."}

# Login → restituisce access_token
POST /api/auth/login
{"email": "...", "password": "..."}
```

Tutte le API successive richiedono `Authorization: Bearer <token>`.

### Profilo utente

```bash
GET   /api/users/profile
PATCH /api/users/profile
{"name": "Mario", "systemPrompt": "Rispondimi sempre in modo conciso."}
```

### Chat e messaggi

```bash
# Lista progetti
GET /api/projects

# Crea progetto con system prompt
POST /api/projects
{"name": "Cliente Acme", "systemPrompt": "Progetto Acme a Milano, budget 180k€"}

# Invio messaggio con streaming SSE
POST /api/chats/:chatId/messages/stream
{"content": "Proponi una soluzione per l'area cassa", "attachmentIds": []}
# → stream SSE (type principali):
#   data: {"type":"chunk","content":"..."}                       # token di testo
#   data: {"type":"tool_call","toolCall":{...}}                  # tool invocato
#   data: {"type":"tool_result","name":"...","ok":true}          # esito tool
#   data: {"type":"file","name":"report.pdf","rel":"skills-output/report.pdf"}  # file prodotto (download ?rel=, access-aware)
#   data: {"type":"agent_step","agent":"...","role":"...","output":"..."}       # step team (chat con team)
#   data: {"type":"usage","inputTokens":123,"outputTokens":45}   # statistiche token
#   data: {"type":"done","messageId":"..."}
```

### Custom Tools

```bash
# Lista tool
GET /api/custom-tools

# Crea tool
POST /api/custom-tools
{
  "name": "search_web",
  "description": "Cerca sul web...",
  "parameters": [{"name": "query", "type": "string", "description": "...", "required": true}],
  "executorType": "http",
  "executorConfig": {"url": "https://api.example.com?q={{query}}", "method": "GET"}
}

# Test tool
POST /api/custom-tools/:id/test
{"args": {"query": "test"}}

# Aggiungi segreto
POST /api/custom-tools/:id/secrets
{"keyName": "MY_API_KEY", "value": "sk-..."}
```

### Data Sources

```bash
# Crea sorgente dati
POST /api/data-sources
{
  "name": "Gestionale",
  "connectionString": "mysql://user:pass@host:3306/db",
  "schemaHints": "ordini.COD_CLI → clienti.COD",
  "prefetchRelations": false,
  "scope": "org"
}

# Test connessione
POST /api/data-sources/:id/test
```

### Configurazione app (admin)

```bash
# Leggi configurazione corrente (system prompt, embedding, tool-loading)
GET /api/app-config

# Configurazioni LLM — multi-record (default + summarizer + vision), modulo llm-configs
GET    /api/llm-configs                      # lista
POST   /api/llm-configs                      # crea
{
  "name": "OpenAI GPT-4o",
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "baseUrl": null,
  "maxTokens": null
}
PATCH  /api/llm-configs/:id                  # aggiorna
DELETE /api/llm-configs/:id
POST   /api/llm-configs/:id/set-default      # imposta come default
POST   /api/llm-configs/:id/set-summarizer   # usa per i riassunti (history compaction)
POST   /api/llm-configs/:id/set-vision       # usa per i task vision (OCR immagini)
POST   /api/llm-configs/clear-vision         # azzera (i task vision usano il default)
POST   /api/llm-configs/:id/test             # test connessione

# Aggiorna embedding
PATCH /api/app-config/embedding
{
  "embeddingProvider": "voyage",
  "embeddingModel": "voyage-multilingual-2",
  "embeddingApiKey": "pa-...",
  "embeddingVectorSize": 1024
}

# Aggiorna system prompt
PATCH /api/app-config/system-prompt
{"systemPrompt": "Sei un assistente AI..."}
```

### Vector DB (admin)

```bash
# Configurazione corrente
GET /api/vector-db/config

# Aggiorna provider
PATCH /api/vector-db/config
{
  "provider": "pgvector",
  "connectionString": "postgresql://user:pass@host:5432/db"
}

# Lista collection
GET /api/vector-db/collections

# Crea collection
POST /api/vector-db/collections
{"name": "mia_collection", "vectorSize": 1024}
```

---

## 22. Troubleshooting

### Il backend non si avvia

**`Error: connect ECONNREFUSED 127.0.0.1:5432`**  
→ PostgreSQL non è in esecuzione: `docker compose up postgres -d`

**`relation "app_config" does not exist`**  
→ Le migration non sono state applicate: `npm run migration:run`

**`TOOL_SECRETS_KEY non valida`**  
→ La chiave AES deve essere esattamente 32 byte hex (64 caratteri): `openssl rand -hex 32`

---

### Build TypeScript fallisce con OOM

```
FATAL ERROR: Reached heap limit Allocation failed
```

**Causa (storica):** LangGraph usa tipi TypeScript molto complessi che potevano saturare l'heap.  
**Stato attuale:** risolto — il backend compila con **tsc** (`nest-cli.json` → `"builder": "tsc"`). Sia il build sia il type-check girano puliti; se necessario alza la memoria di Node.

```bash
# ✅ Build (tsc) + type-check
npm run build       # → nest build (builder tsc, valida i tipi)
npm run typecheck   # → tsc --noEmit

# Se va OOM su macchine con poca RAM:
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

---

### Dimensione vettori non corrisponde

```
Dimensione vettore non corrisponde: modello restituisce 384 dims, collection creata con 1024.
```

**Causa:** il provider/modello di embedding è stato cambiato dopo la creazione delle collection.  
**Soluzione:**
1. Aggiorna `embeddingVectorSize` in Impostazioni → Sistema AI → Embedding
2. Elimina le collection vettoriali esistenti (Impostazioni → Vector DB)
3. Reindicizza tutti i documenti

---

### OpenAI SDK restituisce vettori di dimensione sbagliata (encoding base64)

**Causa:** OpenAI SDK ≥ 4.25 invia `encoding_format=base64` di default. I server locali (LM Studio, Ollama) non supportano base64 e restituiscono float, ma l'SDK li interpreta come buffer binario.

**Soluzione già implementata:** il probe in `EmbeddingProviderService` usa `fetch()` diretto con `encoding_format: 'float'` esplicito. Se il problema persiste, verifica che il provider embedding sia impostato su **LM Studio** (non OpenAI) per i server locali (Impostazioni → Sistema AI).

---

### Tool MCP non disponibile nell'agente

1. Verifica che il server MCP sia abilitato (toggle nell'UI)
2. Per transport `local`: controlla i log del backend — il processo deve risultare "running"
3. Per transport `remote`: verifica che il bridge Electron sia connesso (status nella barra del bridge)
4. Controlla che il nome del tool non collidaA con un tool custom (`mcp_{server}_{tool}`)

---

### CORS: browser rifiuta le richieste

**Causa:** `cors: true` passato a `NestFactory.create` causa header duplicati.  
**Soluzione:** la configurazione CORS deve stare **solo** in `app.enableCors()` in `main.ts`. Verifica che `FRONTEND_URL` sia impostato correttamente.

---

### Skill rimane in stato `installing` o `error`

1. Clicca sul badge di stato nella card della skill → si apre il log di installazione
2. Problemi comuni:
   - **pip/npm non trovati** → verifica che il container `skill-executor` sia avviato (`docker compose ps`)
   - **Pacchetto inesistente** → controlla il nome esatto su PyPI/npm
   - **Timeout** — installare Puppeteer la prima volta scarica Chromium (~170 MB); aumenta `INSTALL_TIMEOUT_MS` in `.env.executor` (root)
3. Usa il pulsante "Reinstalla" per ritentare senza re-uploadare il ZIP

---

### Skill in stato `ready` ma il tool non appare all'agente

1. Verifica che la skill sia **assegnata al progetto** corrente (tab "Assegna" nel drawer)
2. Verifica che lo script abbia un `input_schema` valido nel frontmatter di `SKILL.md`
3. Controlla che il nome del tool (`skill_{name}_{script}`) non collidA con un tool custom

---

### Errore di esecuzione skill (exit_code ≠ 0)

Il tool restituisce all'LLM l'intero output (stdout + stderr). Per debuggare:
1. Testa lo script manualmente via API:
   ```bash
   curl -X POST http://localhost:4000/execute \
     -H 'Content-Type: application/json' \
     -d '{"skill_id":"...", "filename":"scripts/main.py", "language":"python", "input":{...}, "timeout_ms":30000}'
   ```
2. Controlla `stderr` nella risposta
3. Verifica che i path (`OUTPUT_DIR` ecc.) siano assoluti — in sviluppo imposta `UPLOAD_DIR` a un path assoluto

---

### Puppeteer / Chromium non trovato nella skill Node

```
Error: Could not find Chrome (ver. xxx). This can occur if either
1. you did not perform an installation step
```

La skill usa `puppeteer@22` — il download di Chromium avviene durante `npm install` nella fase di installazione della skill. Se il download è stato saltato:
1. Elimina la directory `.deps/node` della skill:
   ```bash
   rm -rf backend/uploads/skills/{skill_id}/.deps/node
   ```
2. Usa il pulsante "Reinstalla" nella UI
3. Se il problema persiste all'interno di Docker, verifica che il container abbia accesso a internet durante l'installazione.

---

### PDF non viene generato (tool built-in Python)

```
Could not find Chromium
```

```bash
cd backend
npx puppeteer browsers install chrome
```

---

### LLM cloud non risponde (401/403)

1. Verifica che l'API key sia configurata in Impostazioni → Sistema AI → LLM
2. Se la chiave è sull'env var ma non nel DB, controlla che il provider corrisponda
3. Testa la chiave direttamente con `curl` verso l'API del provider

---

### Tool non trovato con strategia `semantic_rag` o `keyword_bm25`

Il tool esiste ma l'agente non lo usa — probabilmente è stato filtrato dalla selezione.

1. Verifica i log backend: `Context: tools=Xtok(×N)` — se N è basso, il tool è stato escluso
2. Aumenta `toolLoadingMaxTools` in Impostazioni → Profilo
3. Oppure passa a `always_inject_all` temporaneamente per verificare
4. Migliora la `description` del tool (più parole chiave semanticamente rilevanti) per aumentare il punteggio di selezione

---

### Storia conversazione troppo corta / contesto perso

Il LLM non ricorda i messaggi precedenti — budget token storia esaurito.

1. Verifica i log: `History trimmed: X → Y msg (~Ztok, budget=6000tok)`
2. Aumenta `Max history tokens` in Impostazioni → Profilo (o globale in Impostazioni → Sistema AI)
3. Valori consigliati: 6 000 = ~20 scambi brevi; 16 000 = conversazioni lunghe; 0 = nessun limite (solo cap 20 messaggi)

---

### DeepSeek — errore 400 "reasoning_content must be passed back"

**Causa:** la storia contiene messaggi AI senza il campo `reasoning_content`, richiesto dall'API.  
**Soluzione:** già gestita automaticamente — l'interceptor fetch inietta `reasoning_content: ''` su ogni messaggio assistant. Se il problema persiste, verifica che il provider nel DB sia impostato su `deepseek` (non `openai-compatible`).

---

## 23. Client da terminale (CLI)

La CLI `arkimede` (workspace `cli/`) porta login e chat nella shell, verso
qualsiasi backend in esecuzione — stessa API REST + SSE, stesso JWT, nessuna
modifica lato server. Linux/macOS, Node ≥ 18.

```bash
npm install -g arkimede-cli                  # oppure: cd cli && npm install && npm run build
arkimede login --url http://localhost:3000   # chiede email + password
arkimede                                     # TUI full-screen sull'ultima chat
```

In sintesi:

- **TUI** (default): sidebar delle chat (`Tab` per il focus, `n` nuova
  chat), risposte in streaming con righe di stato compatte dei tool, `Esc`
  interrompe la generazione, `s` apre il **pannello impostazioni** — 7
  schede (Profile, LLM, Tools, Skills, Data, MCP, Usage) con CRUD completo
  per config LLM, tool e server MCP e toggle enable/disable, tutto sugli
  stessi endpoint e permessi della web UI.
- **REPL a righe** (`--plain`, automatico in pipe): scriptabile —
  `printf 'domanda\n/quit\n' | arkimede chat --last`.
- **Sessione**: JWT salvato in `~/.config/arkimede/config.json` (permessi
  0600); alla scadenza basta rifare login. Il modello si risolve sempre
  lato server (config LLM default).

Riferimento completo (tasti, schede impostazioni, note per form, dettagli
implementativi): **[CLI_it.md](CLI_it.md)**.

---

*Ultimo aggiornamento: luglio 2026 — Client da terminale (CLI); in precedenza: tool loading optimization, prompt caching, DeepSeek, sistema prompt 4 livelli, SKILL.md selettivo*
