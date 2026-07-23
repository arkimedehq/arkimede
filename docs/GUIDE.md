# Arkimede — Usage and Development Guide

> Multi-user AI platform with a configurable agent, custom tools (HTTP/SQL/RAG),
> MCP servers, Electron bridge, and multi-LLM / multi-vector-DB support.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First launch (full setup)](#2-first-launch-full-setup)
3. [Daily development startup](#3-daily-development-startup)
4. [AI system configuration (admin)](#4-ai-system-configuration-admin)
5. [4-level system prompt](#5-4-level-system-prompt)
6. [Custom tools](#6-custom-tools)
7. [Data sources (DataSource)](#7-data-sources-datasource)
8. [MCP servers](#8-mcp-servers)
9. [Document management (RAG)](#9-document-management-rag)
10. [Embedding configuration](#10-embedding-configuration)
11. [Vector DB configuration](#11-vector-db-configuration)
12. [Skills](#12-skills)
13. [Flows — deterministic workflows](#13-flows--deterministic-block-based-workflows)
14. [Multi-Agent — agents and teams](#14-multi-agent--agents-and-teams)
15. [Auto-Scheduling — automations from chat](#15-auto-scheduling--schedule-automations-from-chat)
16. [Running activity — unified dashboard](#16-running-activity--unified-dashboard)
17. [Security & isolation](#17-security--isolation)
18. [Token and cost optimization](#18-token-and-cost-optimization)
19. [Architecture for developers](#19-architecture-for-developers)
20. [DB schema and migrations](#20-db-schema-and-migrations)
21. [API reference](#21-api-reference)
22. [Troubleshooting](#22-troubleshooting)
23. [Terminal client (CLI)](#23-terminal-client-cli)

---

## 1. Prerequisites

- **Node.js** ≥ 20 (only for hybrid dev mode; not needed in full-Docker)
- **Docker** / Docker Desktop with Compose v2 — runs postgres, qdrant, redis, embedding, skill-executor and (in full-Docker) backend and frontend
- **LLM/embedding API keys:** entered from the **admin UI** after startup (Settings → AI System), not via env. Keep the API key of the provider you'll use handy (Anthropic, OpenAI, Gemini, etc.).
- **Optional:**
  - Electron + npm — only for MCP transport `remote`
- **Hardware:** the full stack idles at **~2 GB RAM**. The two ML services dominate — embedding (`mxbai-embed-large`, ~1 GB) and Whisper (`small`/`int8`, ~0.4 GB); everything else combined is under 550 MB. Budget **4 GB RAM as a comfortable minimum**, 8 GB for real use (concurrent users, active RAG). CPU-only by default (no GPU needed; `EMBEDDING_DEVICE=cuda` is opt-in). Plan ~10 GB disk for images, downloaded models and the persistent Nix store. You can drop the embedding service (−1 GB, no RAG) or Whisper (−0.4 GB, no voice input) to lower the footprint.

---

## 2. First launch (full setup)

> ### ⭐ Fastest path — the guided installer
>
> From a fresh clone, one command does everything:
>
> ```bash
> git clone <repo-url> && cd arkimede
> ./scripts/install.sh
> ```
>
> It runs the Docker preflight, **generates all the secrets**, lets you pick a security level
> (Standard / Isolated / Maximum), builds the required images and starts the full stack — then
> hands you `./scripts/compose.sh` to manage it (`ps | logs -f | down`). Idempotent; preview with
> `./scripts/install.sh --dry-run`. **This is the recommended way** — the manual steps below are for
> development or fine-grained control.

> **Manual alternatives** (choose one) — both use the **same** root `.env`:
> - **A — Everything in Docker** (trials/production): every service runs in a container. → [§ 2.6](#26-full-startup-in-docker-all-services-in-containers).
> - **B — Hybrid dev** (for development): infrastructure in Docker, backend/frontend locally with hot-reload. This is the path described in 2.1 → 2.4.

### 2.1 Clone and configure environment variables

```bash
git clone <repo-url>
cd arkimede
```

There is **a single `.env`, at the root**, used by both modes: in dev the backend
reads it from `../.env`; in Docker the container-specific values (service hosts,
`/app/...` paths) are overridden by `docker-compose.yml`.

```bash
cp .env.example .env
# Required: RUN_TOKEN_SECRET and TOOL_SECRETS_KEY (openssl rand -hex 32),
#           JWT_SECRET, DB_PASSWORD, SERVICE_API_KEY (mesh auth backend↔executor↔broker)
# LLM/embedding keys do NOT go here: they are configured from the UI after startup (§ 2.5).
```

For **mode B (hybrid dev)** fill in at least the following in `.env` (LLM/embedding/vector DB are configured later from the UI, § 2.5):

```bash
JWT_SECRET=choose-a-long-random-string
TOOL_SECRETS_KEY=$(openssl rand -hex 32)   # AES key for encryption
RUN_TOKEN_SECRET=$(openssl rand -hex 32)   # signs internal /internal/* tokens (backend only)
SERVICE_API_KEY=$(openssl rand -hex 32)    # mesh auth backend→executor→broker (required)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=arkimede
```

### 2.2 Start the Docker infrastructure (mode B — hybrid dev)

Support services in containers; backend and frontend then run locally (2.3–2.4):

```bash
# Minimum to get going: DB + vector DB + queue (BullMQ)
docker compose up postgres qdrant redis -d

# Add embedding and skill-executor if you use local RAG and/or Skills:
docker compose up postgres qdrant redis embedding skill-executor -d

docker compose ps   # wait until they are "healthy"
```

> With `docker compose up` (without `-f`), `docker-compose.override.yml` is applied automatically, re-exposing the host ports (5432/6333/6379/8000) to reach the services from the local machine.

### 2.3 Apply migrations and start the backend

```bash
cd backend
npm install
npm run migration:run   # creates all tables
npm run start:dev       # → http://localhost:3000
```

On first startup, `app_config` is initialized with the **default system prompt** (from `src/prompts/system.prompt.ts`). LLM, embedding and vector DB providers are then configured from the admin UI (§ 2.5).

### 2.4 Start the frontend

```bash
cd frontend
npm install
npm run dev   # → http://localhost:5173
```

Register the first account — the first registered user automatically becomes admin.

### 2.5 Configure the AI system (one-time, from admin UI)

Log in with the admin account → **Settings → AI System**:

1. **LLM provider** — select the provider and enter the API key (stored encrypted in the DB)
2. **Embedding provider** + **Vector DB** — select and configure
3. **Base system prompt** — customize the agent's global instructions

### 2.6 Full startup in Docker (all services in containers)

An alternative to mode B: no local dependencies, everything in containers (postgres, qdrant, redis, embedding, skill-executor, **backend**, **frontend**). Migrations are applied automatically when the backend starts (`migrationsRun: true`).

> **🚀 Guided installer (recommended).** Instead of the manual steps below, you can use
> `./scripts/install.sh`: it runs the Docker preflight, generates weak/missing secrets, asks you
> for the **security level** (see § 2.7), builds only the necessary images,
> prepares the directories and starts the stack. It also generates `scripts/compose.sh`, a wrapper that
> remembers the chosen `-f` chain (`./scripts/compose.sh ps | logs -f | down`).
> Preview without changes: `./scripts/install.sh --dry-run`.

```bash
cp .env.example .env        # fill in RUN_TOKEN_SECRET, TOOL_SECRETS_KEY, JWT_SECRET, DB_PASSWORD (LLM/embedding: from UI)

# Dev (host ports re-exposed by docker-compose.override.yml, auto-merge):
docker compose up -d --build

# Production (base file only: no host ports on internal services):
docker compose -f docker-compose.yml up -d --build

docker compose ps           # wait until all are "healthy"
```

- Frontend → **http://localhost:5173** · Backend/API → **http://localhost:3000** · Swagger → **/api/docs**
- In **production**, only the backend (3000) and frontend (5173) are exposed to the host; the other services communicate by name over the internal Docker network.
- Register the first account → it becomes **admin**. Then configure the AI system from the UI (§ 2.5).

### 2.7 Security layers (optional overlays)

> **Shortcut:** `./scripts/install.sh` maps these overlays to three **security
> levels** chosen at runtime — **L1 Standard** (base), **L2 Isolated** (+ broker), **L3
> Maximum** (+ broker + egress, gVisor optional) — and handles build, directories and startup.
> The sections below remain the reference for anyone who wants to compose the overlays by hand.

Overlays are **added** to the base file with `-f`. Summary of the 4 Compose files:

| File | When it loads | What it does |
|---|---|---|
| `docker-compose.yml` | always (base) | Secure prod config: internal services without host ports |
| `docker-compose.override.yml` | auto with `docker compose up` | Dev: re-exposes host ports |
| `docker-compose.egress.yml` | opt-in `-f` | **C1** — egress allowlist (executor on internal network + squid proxy) |
| `docker-compose.broker.yml` | opt-in `-f` | **D2** — hardened container-per-job via broker |

```bash
# Base prod
docker compose -f docker-compose.yml up -d

# + egress allowlist (C1): allowed domains are declared in egress-proxy/squid.conf
docker compose -f docker-compose.yml -f docker-compose.egress.yml up -d

# + container-per-job (D2): first build the runner image, set HOST_DATA_DIR in .env
docker build -t pa-runner ./runner
docker compose -f docker-compose.yml -f docker-compose.broker.yml up -d

# Full hardened (C1 + D2)
docker compose -f docker-compose.yml -f docker-compose.egress.yml -f docker-compose.broker.yml up -d
```

> **Broker (D2):** requires `HOST_DATA_DIR` (absolute host path) in `.env` and the subfolders writable by the executor's uid. Prepare them with **`./scripts/bootstrap-broker.sh`** (reads `HOST_DATA_DIR` from `.env`, creates the directories and applies `chmod 0777` only to those writable by jobs, then verifies the `pa-runner` image). Manual equivalent: `mkdir -p "$HOST_DATA_DIR"/{skills,work,state,skills-output,sandbox} && chmod 0777 "$HOST_DATA_DIR"/{work,state,skills-output,sandbox}`.

### 2.8 Upgrading an existing deployment

To move a running deployment to a newer version:

```bash
./scripts/update.sh
```

It backs up your data, `git pull`s, rebuilds, and restarts — preserving your volumes and `.env`. Flags: `--yes` (no prompt), `--no-backup`.

Under the hood it does, in order: **backup** (`scripts/backup.sh`) → **`git pull --ff-only`** → flags any **new `.env.example` variables** missing from your `.env` → **rebuilds the broker job images** (`pa-runner` / `pa-egress-proxy`) *only if* your profile uses them and `runner/` or `egress-proxy/` changed → **`docker compose up -d --build`** → **health check**.

Four things make this safe, and are worth understanding if you upgrade by hand instead:

- **Your data persists.** Postgres, `uploads`, `skills_data` and `qdrant_data` live in named volumes that a rebuild never touches.
- **Migrations are automatic.** The backend runs pending migrations on boot (`migrationsRun: true`) — there is no manual DB step.
- **`git pull` is mandatory and separate.** `install.sh` and `update.sh` build from the working tree as-is; neither `install.sh` nor a bare `up --build` fetches new code. Only `git pull` does. (`.env`, `scripts/compose.sh` and `scripts/.compose-profile` are gitignored, so the pull never clobbers them.)
- **The broker images are not rebuilt by `up --build`.** `pa-runner` (L2/L3) and `pa-egress-proxy` (L3) are referenced by image name, not `build:`. If `runner/` or `egress-proxy/` changed, rebuild them explicitly: `docker build -t pa-runner ./runner` and, for L3, `docker build -t pa-egress-proxy ./egress-proxy`. `update.sh` does this for you when their source changed.

**Manual / unattended equivalent** (no `update.sh`):

```bash
./scripts/backup.sh                                   # snapshot first
git pull                                              # bring in the new code
# new required variables? compare and edit .env by hand:
diff <(grep -oE '^[A-Z_]+=' .env.example | sort) <(grep -oE '^[A-Z_]+=' .env | sort)
docker build -t pa-runner ./runner                    # only if using L2/L3 and runner/ changed
docker build -t pa-egress-proxy ./egress-proxy        # only if using L3 and egress-proxy/ changed
./scripts/compose.sh up -d --build                    # rebuild + restart; migrations run on boot
curl -s localhost:3000/api/health                     # verify
```

> **Re-running `install.sh` instead** also works for an upgrade (it is idempotent and rebuilds the broker images), but **only after** a `git pull` — on its own it just rebuilds the version already on disk. Prefer `update.sh` for a running deployment.

**Rollback.** Every run leaves a snapshot under `backups/arkimede-backup-<timestamp>/`. To restore the database: `gunzip -c backups/<snapshot>/db.sql.gz | ./scripts/compose.sh exec -T postgres psql -U <DB_USER> -d <DB_NAME>`. Volume tarballs (`uploads`/`skills_data`/`qdrant_data`) restore into their volumes with the `docker run --rm -v <project>_<volume>:/dst …` pattern shown at the top of `scripts/backup.sh`.

---

## 3. Daily development startup

```bash
# Terminal 1 — Infrastructure (if not already running)
docker compose up postgres qdrant redis -d   # + embedding skill-executor if you need RAG/Skills

# Terminal 2 — Backend
cd backend && npm run start:dev

# Terminal 3 — Frontend
cd frontend && npm run dev

# Terminal 4 — Electron bridge (only if you use MCP transport 'remote')
cd bridge && npm run dev
```

---

## 4. AI system configuration (admin)

### Supported LLM providers

| Provider | Identifier | Notes |
|---|---|---|
| Anthropic | `anthropic` | Default |
| OpenAI | `openai` | |
| Google Gemini | `gemini` | |
| Ollama | `ollama` | Local, `http://localhost:11434` by default |
| LM Studio | `lmstudio` | Local, `http://localhost:1234/v1` by default |
| OpenAI-compatible | `openai-compatible` | Any server with an OpenAI-compatible API |
| DeepSeek | `deepseek` | `api.deepseek.com/v1` — default model `deepseek-chat`. Supports R1 reasoning |

**How to configure:** Settings → AI System → "LLM Model" section  
Enter provider, model name, API key (encrypted in the DB) and base URL (for local providers).
Configurations are **multi-record** (`llm_configs`): you can save multiple providers and assign roles — one **default** (chat agent), one **summarizer** (summaries/compaction) and one **vision** (multimodal tasks such as OCR of images uploaded into RAG; requires a model that supports images, otherwise OCR is skipped). Any unassigned role falls back to the default.

> LLM/embedding keys are **not** set via env: they live encrypted in the DB. (The code keeps a legacy env fallback, but the supported path is the UI.)

### Switching LLM provider

The switch is immediate: the model cache is invalidated on PATCH and the next request uses the new provider. No redeploy needed.

---

## User & team management (admin)

The platform is **collaborative multi-tenant**: an organization with users, roles and teams. Everything is managed from **Settings → Users / Teams** (visible only to admins).

### Users and roles
- Roles: **admin** (management) and **user**. The **first registered user becomes admin**; the rest are promoted by an admin.
- Account status: **active** / **disabled**. A disabled account cannot log in, and the effect is immediate (the token is re-validated on every request).
- **Settings → Users**: search/filter, create user, edit name/email, change role, activate/deactivate, reset password, delete.
- Safeguards: you cannot remove/disable/delete the **last active admin**, nor perform destructive actions on your own account.

### Teams
- **Settings → Teams**: create a team, then manage members by assigning the **owner** or **member** role.
- A team **owner** can publish resources (tools/skills/data sources) **to the team autonomously**, without going through an admin; **members** use them but do not manage them.

### Resource scope: `personal | team | org`
Every tool, skill and data source has a scope that defines its visibility and management — and that **determines what each user's agent loads**:

| Scope | Who sees/uses it | Who manages it |
|---|---|---|
| **personal** | only the creator | the creator |
| **team** | team members | admin **or** team owner |
| **org** | the whole organization | admin |

- **Skills**: scope `team` = **direct** publication by the owner to members (no review); scope `org` = submitted for review and **admin approval**.
- Visibility is **per-membership even for admins**: an admin who isn't a member of a team doesn't see those resources in their own list/agent, but still **manages** them (by id / from the Team UI).

> In practice: **org** = standard, trusted tools for the whole company (curated by admins); **team** = tools and data for a department, managed by its owners; **personal** = individual experimentation.

---

## 5. 4-level system prompt

The system prompt is composed additively:

```
1. Base prompt (admin)          → the agent's global identity
                                     ↓
2. User prompt (optional)       → style preferences or expertise
                                     ↓
3. Project prompt (optional)    → project-specific context
                                     ↓
4. Skills prompt (automatic)    → SKILL.md of the skills assigned to the project (selective)
```

**Base prompt:** Settings → AI System → "Base system prompt"  
It is seeded from `backend/src/prompts/system.prompt.ts` on first startup.

**User prompt:** Settings → Profile → "Custom instructions" field  
Example: `"Always answer me in English and concisely."`

**Project prompt:** click the pencil icon next to the project in the sidebar → "AI instructions" field  
Example: `"This project concerns a client engagement, with a defined budget and timeline."`

**Skills prompt:** built automatically by `buildSkillSystemPromptSelective()` — it includes only the SKILL.md sections relevant to the tools selected by the current loading strategy.

---

## 6. Custom tools

Custom tools are created from the UI (Settings → Custom Tools) and registered as LangChain `DynamicStructuredTool`s. The LLM autonomously decides when and how to use them based on name and description.

### 6.1 `http` executor

Calls an external REST endpoint.

**Main fields:**
- **URL** — e.g. `https://api.example.com/search?q={{query}}`
- **Method** — GET / POST / PUT / PATCH / DELETE
- **Headers** — e.g. `Authorization: Bearer {{secret.MY_TOKEN}}`
- **Body template** — JSON object or raw string with interpolation
- **Response path** — extracts a field from the JSON response (dot-notation, e.g. `results.items`)
- **Max response chars** — truncates the response passed to the LLM (default 3000)

**Supported interpolation:**
- `{{paramName}}` → parameter provided by the LLM
- `{{secret.KEY}}` → encrypted secret from the `tool_secrets` table
- `{{env.VAR}}` → environment variable of the NestJS process

**Example — web search:**
```
Name: search_brave
Description: Search for up-to-date information on the web using the Brave Search API.
             Use it for questions about recent events, news, current prices.
Parameters: query (string, required) — keywords to search for
URL: https://api.search.brave.com/res/v1/web/search?q={{query}}&count=5
Headers: Accept: application/json
         X-Subscription-Token: {{secret.BRAVE_API_KEY}}
Response path: web.results
```

### 6.2 `sql` executor

Runs SELECT queries against an external database configured as a DataSource.

**Template mode (Mode A):**
```sql
SELECT name, email, phone
FROM customers
WHERE region = :region AND active = true
ORDER BY name
LIMIT 20
```
The `:name` parameters are bound safely (SQL injection prevention).

**Text-to-SQL mode (Mode B):**
- Leave `queryTemplate` empty and set `queryParam` to the name of an optional tool parameter
- The LLM fills the parameter with a free-form SELECT
- The tool validates that it is SELECT-only, adds a LIMIT and executes it
- If the parameter is missing → it returns the table schema (useful for letting the LLM explore the DB)

**Schema prefetch options:**
- `prefetchTables: true` — lists tables before execution
- `prefetchColumns: ["customers", "orders"]` — columns of specific tables
- `prefetchAllColumns: true` — all columns with a 5-min cache (for large context windows)

**DataSource** — must be configured in "Settings → Database" before creating the tool.

### 6.3 `rag` executor

Semantic search over a vector collection.

**Fields:**
- **Collection** — the collection name (must exist in the configured Vector DB)
- **Limit** — number of chunks to return (default 5)
- **Filter by user** — filters by userId (for multi-tenant collections)

**Example — document search:**
```
Name: search_documents
Description: Search for information in indexed company documents.
             Use this tool to answer questions about procedures, datasheets,
             product specifications, internal policies.
Executor: rag
Collection: agent_docs
Limit: 5
```

### 6.4 Scope and secrets

- **Personal** — visible/usable only by the creator
- **Team** — visible/usable by members of the chosen team; management by **admin or team owner**
- **Org** — visible/usable by the whole organization; management reserved for **admins**

(Same scope model for tools, skills and data sources — see § "User & team management".)

Secrets (API keys, tokens) are added in the tool's "Secrets" tab and are encrypted with AES-256-CBC. In the tool they are referenced as `{{secret.KEY_NAME}}`.

### 6.5 Inline test

Every HTTP tool has a "Test" panel in the edit modal: enter the parameter values and run the tool in dry-run mode without going through the agent.

---

## 7. Data sources (DataSource)

DataSources are connections to external databases reusable by multiple SQL tools.

**Settings → Database → New data source**

```
Name: Business Management System
Database type: MySQL     # explicit engine dropdown
Description: Read-only DB of the legacy business management system
Connection string: mysql://user:pass@host:3306/db_name
Schema hints: (optional) implicit FK relations for legacy DBs
  orders.customer_id → customers.id
  is_archived = 1 = archived record
Prefetch relations: yes (if FKs are declared in the DB)
Scope: org        # personal | team | org (org = whole company, admin only)
```

**Supported engines** (selected from the "Database type" dropdown; the connection string
format depends on the engine):
- **Relational** (SQL tool): PostgreSQL `postgresql://…`, MySQL `mysql://…`,
  MariaDB `mariadb://…`, SQL Server `mssql://…` (or `Server=…;Database=…`),
  Oracle `oracle://host:1521/service`, SQLite `sqlite:///path/to/file.db`
- **MongoDB** (Mongo tool, find/aggregate): `mongodb://user:pass@host:27017/db`
- **Redis** (Redis tool, whitelisted commands): `redis://:password@host:6379/0`
- **File-share** (network folders, used by the `file-share` skill): SMB/CIFS
  `smb://[DOM;]user:pass@host/share[/folder]`, SFTP `sftp://user:pass@host:22[/folder]`,
  WebDAV `webdavs://user:pass@host[/folder]` (`webdav://` for http)

For MongoDB and Redis, introspection is **sampling-based** (collections+fields / key
patterns). NoSQL tools are **read-only** by default; writing is opt-in (with
confirmation for destructive operations). **File-share** DataSources have no schema:
they are used through the `file-share` skill (search/read/write/delete files); I/O happens
in the backend, scripts never connect to the network directly.

The connection string is encrypted at rest with AES-256-GCM and never appears in API responses.

**Connection test:** the "Test connection" button below the connection string in the
DataSource form (test the connection before or after saving).

---

## 8. MCP servers

**Settings → MCP Servers → New server**

### `http` / `sse` transport

For remote MCP servers already running:

```
Name: filesystem
URL: http://localhost:3001
Transport: http
```

### `local` transport

The NestJS backend spawns the process directly:

```
Name: filesystem
Command: npx -y @modelcontextprotocol/server-filesystem /path/to/dir
Transport: local
```

- The process is started on the first `loadToolsForUser()` and stays alive
- Auto-restart on crash (5s backoff)
- PATH resolved from the login shell (includes nvm, Homebrew, pyenv, Cargo)

### `remote` transport

The process is spawned by the Electron Bridge on the user's machine:

```
Name: filesystem
Command: npx -y @modelcontextprotocol/server-filesystem /path/to/dir
Transport: remote
```

1. Start the Electron bridge (`cd bridge && npm run dev`)
2. The bridge connects to the backend via WebSocket with JWT auth
3. The backend sends the `remote` server configuration
4. The bridge spawns the processes and registers the tools
5. Tool calls flow via WebSocket (backend → bridge → process → bridge → backend)

### MCP tool names

Naming follows the pattern `mcp_{server_name}_{tool_name}`:
- Server "filesystem" + tool "read_file" → `mcp_filesystem_read_file`

---

## 9. Document management (RAG)

### Uploading a document

Files are uploaded through the UI in the chat or in the project file panel.

**Supported formats:**

| Format | Extraction |
|---|---|
| PDF | pdf-parse (digital text) |
| DOCX | mammoth |
| XLSX / XLS | xlsx (sheet → CSV) |
| TXT, MD, CSV | direct UTF-8 text |
| JPG, PNG, WEBP | Claude (native vision) |

### Attachment mode

| Mode | When to use it |
|---|---|
| **embed** (default) | Large files — indexed in Qdrant, reachable via the RAG tool |
| **inline** | Small files (<5k tokens) — text included directly in the message |
| **attachment** | Images and PDFs — sent as a multimodal content block to Claude |

### Creating a RAG tool over documents

```
Name: search_documents
Executor: rag
Collection: agent_docs      ← collection where the files are indexed
Limit: 5
Filter by user: yes         ← if the collection is shared across users
```

Add this tool with scope "Org" to make it available to all users (or "Team" for just the group).

### Deleting vectors

When a file is deleted from the UI, the corresponding vectors are automatically removed from the collection.

---

## 10. Embedding configuration

### Supported providers

| Provider | Identifier | Notes |
|---|---|---|
| LM Studio | `lmstudio` | Local, OpenAI-compatible API |
| Ollama | `ollama` | Local, `http://localhost:11434` |
| OpenAI | `openai` | Cloud, requires API key (from UI) |
| VoyageAI | `voyage` | Cloud, great for many languages |
| OpenAI-compatible | `openai-compatible` | Any compatible server |

**Configuration:** Settings → AI System → "Embedding" section

### Changing the embedding provider

1. Update the configuration in Settings → AI System
2. ⚠️ **Reindex** all documents and RAG collections — vector dimensions may change
3. Update `embeddingVectorSize` with the new model's dimension

### Query/document prefix

Some models require different prefixes for queries vs documents:
- Example nomic-embed-text: `search_query: ` for queries, `search_document: ` for docs
- For `mxbai-embed-large-v1`: prefixes not needed

---

## 11. Vector DB configuration

**Settings → Vector DB** (admin only)

### Supported providers

| Provider | Notes |
|---|---|
| **Qdrant** (default) | Self-hosted or cloud. URL + optional API key |
| **PGVector** | PostgreSQL with the pgvector extension. Connection string |
| **Chroma** | Self-hosted or cloud. URL + API key |
| **AstraDB** | DataStax cloud. URL + Application Token + keyspace |

### Switching provider

1. Configure the new provider in Settings → Vector DB
2. Reindex your documents so the collections exist on the new provider

> **⚠ Switching the Vector DB does not migrate your vectors.** There is no
> automatic migration between providers. Switching is **non-destructive and
> reversible**: the vectors physically live only in the provider where they were
> indexed, so the old provider's data is left untouched and switching back makes
> it available again. What *is* shared across providers is the collection
> **registry** (names/config in Postgres), so after switching the UI still lists
> your collections and the `search_<collection>` tools still exist — but the new
> provider starts **empty**, and a search returns nothing until you reindex the
> documents into it. Plan a switch as a "start fresh and reindex" operation, not
> as a data move. Note also that changing provider overwrites the single stored
> URL/token, so re-enter them if you later switch back to a keyed provider.

### Collection management

The Vector DB page shows the collections created by the platform. You can:
- Create new collections with a custom vector dimension
- Delete collections that are no longer needed

---

## 12. Skills

Skills are ZIP packages that extend the AI with Python or Node.js scripts executed in the **skill-executor** container. Each skill has isolated dependencies, instructions for the LLM (SKILL.md) and one or more scripts.

> **Full guide to creating skills:** `SKILLS.md` (in root) — exhaustive `SKILL.md` frontmatter schema, runners, Python/Node/JS templates, internal APIs (save-config, datasource, vector search/ingest), daemon, Nix, capabilities. This section is an operational summary.
>
> Skills are **self-contained third-party packages**: the core contains no ad-hoc code for any skill.

### 12.1 Package structure

```
my-skill.zip
├── SKILL.md        ← REQUIRED: YAML frontmatter (metadata + runtime) + AI instructions
└── scripts/
    ├── main.py     ← executable script
    └── helpers.py  ← modules importable by the main script
```

### 12.2 SKILL.md format (frontmatter)

Metadata and manifest live in the YAML frontmatter at the top of `SKILL.md` (agentskills.io format):
`name`/`description` are standard, the rest goes under `runtime`. After the closing `---`, the Markdown
body is the instructions for the LLM.

```markdown
---
name: skill-name             # kebab-case, unique per user
version: 1.0.0
description: >
  Description for the AI — when it should use this skill.
author: email@example.com
license: MIT

runtime:
  dependencies:
    python:                  # PyPI packages
      - pandas>=2.0
      - requests
    javascript:              # npm packages (only for language: node)
      - puppeteer@22
  config:                    # variables configurable by the user in the UI
    - key: OUTPUT_DIR
      description: "Directory where generated files are saved"
      default: "${UPLOAD_DIR}/skills-output"   # ${VAR} interpolated with system vars
      required: false
      secret: false
  scripts:
    - filename: scripts/main.py
      language: python         # python | javascript | node
      description: >
        Detailed description for the LLM: what it does, when to use it.
      input_schema:
        type: object
        required: [input1]
        properties:
          input1:
            type: string
            description: "Parameter description"
---

# Skill Name

Instructions for the LLM…
```

### 12.3 Available runners

| `language` | Runner | Dependencies | Node API access |
|---|---|---|---|
| `python` | subprocess `python3` | `pip install --target .deps/python` | ✗ |
| `javascript` | isolated-vm (V8 sandbox) | none (`require` unavailable) | ✗ |
| `node` | subprocess `node` | `npm install` in `.deps/node/node_modules` | ✅ |

**Choose `node`** when the script needs: npm libraries (e.g. Puppeteer, pdf-lib, sharp), native Node.js APIs (`fs`, `https`, `child_process`).  
**Choose `python`** for data analysis, ML, file operations with PyPI libraries.  
**Choose `javascript`** only for pure computation without external dependencies.

### 12.4 stdin/stdout protocol

All runners communicate via JSON over stdin/stdout:

**Python script:**
```python
import sys, json
data    = json.load(sys.stdin)
_config = data.get('_config', {})   # configuration variables injected by the backend
# ... logic ...
print(json.dumps({"success": True, "result": "..."}))
```

**Node.js script:**
```javascript
const data    = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const _config = data._config ?? {};
// ... logic ...
console.log(JSON.stringify({ success: true, result: '...' }));
```

> The last valid JSON line on stdout is used as the skill's output.

### 12.5 System variables (`_config`)

The backend automatically injects these variables into the `_config` field:

| Variable | Value | Typical use |
|---|---|---|
| `UPLOAD_DIR` | absolute uploads path (`./uploads` resolved) | saving files |
| `SKILLS_OUTPUT_DIR` | `{UPLOAD_DIR}/skills-output` | generic output |
| `SKILLS_DIR` | `/app/skills` | read-only, skill base |
| `APP_NAME` | application name | document footer |
| `APP_URL` | app base URL | download links |

Plus the user's configurable variables specified in `runtime.config` of SKILL.md (with `${VAR}` interpolation of the default values).

### 12.6 Download URL

To return files downloadable by the user, use the path relative to `UPLOAD_DIR`:

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

⚠️ **Important for SKILL.md:** instruct the LLM to use `download_url` verbatim — never build URLs from other fields.

### 12.7 Uploading and configuring a skill

1. **Upload the ZIP package:** Settings → Skills → Upload ZIP
2. **Wait for installation** — the status goes `pending → installing → ready`
   (if `error`, click the badge to see the installation log)
3. **Configure the variables** — click the skill → "Configure" tab → set the values
4. **Assign to projects** — "Assign" tab → select the projects that should use it
5. **Reinstall** — if you update the deps or the directory gets corrupted, use the "Reinstall" button in the drawer

### 12.8 Scope and sharing review (internal marketplace)

| Scope | Status | Visibility |
|---|---|---|
| `personal` | — | Owner only |
| `team` | — | Team members (**direct** publication by the owner, **no** review) |
| `org` | `is_approved=false` | Awaiting admin review |
| `org` | `is_approved=true` | All users ("Public skills" tab) |

**Publish:** skill drawer → **Visibility** → choose `team` (publishes immediately to members) or `org` (submits for review). Available only if `status=ready`.  
**Withdraw:** set the scope back to `personal`.  
**Approve (admin):** Settings → Skills → "Review" tab (only for `org` skills)

An `org + approved` skill appears in the **"Public skills"** tab for all users.  
Each user can **install it** (single click) — this creates an independent copy in their own collection, with its own lifecycle, configuration and assignments.

### 12.9 Skills Registry (GitHub marketplace)

The **"Public skills"** tab also shows skills from the **public GitHub registry**: a repository with `registry.json` + ZIPs downloadable directly from `raw.githubusercontent.com`.

#### Registry installation flow

```
UI → GET /api/skills/registry          (index cached 5 min server-side)
   → shows the skill list with an "Installed" badge if already present
   → click "Install"
   → POST /api/skills/registry/install   { downloadUrl: "https://raw.githubusercontent.com/..." }
   → backend downloads the ZIP → uploadAndCreate() → response status: installing
   → automatic poll → status: ready
```

#### Registry configuration

```bash
# .env — all optional
SKILLS_REGISTRY_URL=https://raw.githubusercontent.com/arkimedehq/arkimede-skills/main/registry.json
SKILLS_REGISTRY_CACHE_TTL_MS=300000          # cache TTL in ms (default: 5 min)
SKILLS_REGISTRY_ALLOWED_DOMAINS=my-cdn.com  # extra domains for ZIP downloads (comma-separated)
```

Default: uses the official community registry `arkimedehq/arkimede-skills` on GitHub.  
To use a private/company registry: change `SKILLS_REGISTRY_URL`.

#### Download security

The backend validates that `downloadUrl` comes from a whitelisted domain:

| Domain | Always allowed |
|---|---|
| `raw.githubusercontent.com` | ✅ |
| `github.com` | ✅ |
| `objects.githubusercontent.com` | ✅ |
| Domain of `SKILLS_REGISTRY_URL` | ✅ |
| Domains in `SKILLS_REGISTRY_ALLOWED_DOMAINS` | ✅ configurable |

HTTPS only. Non-HTTPS URLs are rejected with a 403.

#### registry.json format

```json
{
  "version": "1",
  "updatedAt": "2026-05-23T00:00:00Z",
  "skills": [
    {
      "name":        "pdf-generator",
      "version":     "1.2.0",
      "description": "Generates structured PDFs from tabular data",
      "author":      "author@example.com",
      "license":     "MIT",
      "languages":   ["python"],
      "tags":        ["pdf", "report", "documents"],
      "scriptCount": 1,
      "dependencies": { "python": ["fpdf2>=2.7"], "javascript": [] },
      "downloadUrl": "https://raw.githubusercontent.com/arkimedehq/arkimede-skills/main/skills/pdf-generator/pdf-generator-v1.2.0.zip",
      "homepage":    "https://github.com/arkimedehq/arkimede-skills/tree/main/skills/pdf-generator",
      "publishedAt": "2026-05-23T00:00:00Z"
    }
  ]
}
```

#### Manual refresh (admin)

```bash
POST /api/skills/registry/refresh   # forces cache invalidation
```

Also available in the UI for admins via the ↻ button in the "Public skills" tab.

### 12.10 Skill API (complete)

```bash
# ── Manual upload ─────────────────────────────────────────────────────────────
POST /api/skills/upload                    # multipart/form-data, field: file (.zip, max 50 MB)

# ── Public registry ───────────────────────────────────────────────────────────
GET  /api/skills/registry                  # index (cached 5 min)
POST /api/skills/registry/install          # { downloadUrl: "https://..." }
POST /api/skills/registry/refresh          # [ADMIN] force cache refresh

# ── CRUD ─────────────────────────────────────────────────────────────────────
GET    /api/skills                         # list: personal + team (of own teams) + approved org
GET    /api/skills/:id                     # detail + scripts + log
PATCH  /api/skills/:id                     # { scope: "personal" | "team" | "org", teamId? }
DELETE /api/skills/:id                     # delete skill + files from the volume

# ── Internal marketplace ──────────────────────────────────────────────────────
POST /api/skills/:id/install               # install a copy of the approved org skill

# ── Dependencies ──────────────────────────────────────────────────────────────
POST /api/skills/:id/reinstall

# ── Project assignment ────────────────────────────────────────────────────────
GET    /api/skills/project/:projectId
POST   /api/skills/:id/assign/:projectId
DELETE /api/skills/:id/assign/:projectId

# ── Variable configuration ────────────────────────────────────────────────────
GET    /api/skills/system-vars
GET    /api/skills/:id/config
PUT    /api/skills/:id/config/:key         # { value: "..." }
DELETE /api/skills/:id/config/:key         # reset to default

# ── Admin — review ────────────────────────────────────────────────────────────
GET  /api/skills/pending-review
POST /api/skills/:id/approve
POST /api/skills/:id/reject                # { reason: "Reason" }
POST /api/skills/:id/propose-compilation   # AI proposes input_schema (descriptive→typed)
POST /api/skills/:id/compile               # { scripts: [...] } applies the compilation
```

### 12.11 Skill type (`typed` / `descriptive`) and Sandbox

The `kind` field, derived at install time, distinguishes:

- **`typed`** — the frontmatter declares `runtime.scripts` with `input_schema` → each script is a **LangGraph tool** (structured invocation via executor, fast and deterministic).
- **`descriptive`** — **"pure" agentskills.io** format (only `SKILL.md` + `scripts/`, no script manifest). No typed tools: the agent reads the instructions and **executes the files via Sandbox**. The skill's files are *staged* into `/workspace/skills/<name>/` (automatic refresh if the skill changes).

**Sandbox** — the built-in tool `run_in_sandbox(language, code)` runs arbitrary code/shell in an ephemeral hardened container-job with a **persistent per-chat workspace**:

- **Gating** (admin → Settings → AI → Sandbox): global master switch (default OFF) + team/project allowlist; admin always allowed.
- **Isolation**: via `broker` (container-job, cap-drop ALL, read-only, non-root uid). **Fail-closed**: without the broker it refuses, unless `SANDBOX_ALLOW_INPROCESS=1` (dev only, not isolated).
- **Network** (unified tiers): `none` (no network) | `internal` (backend `/internal/*` only, no WAN) | `internet` (allowlisted domains via the egress proxy) | `open` (full internet → `pip install`/`npm install` at runtime; requires the open network in `BROKER_ALLOWED_NETWORKS`). Same vocabulary as skill jobs; `internal` is the always-on floor for the tiers above it.
- **Hygiene**: per-TTL workspace GC, per-session disk quota, download of files generated from the chat (`GET /api/sandbox/file`, scoped to chat access).

### 12.12 Compile to tool (descriptive → typed)

From a descriptive skill's drawer, **"Compile to tool"** asks the **AI** to infer an `input_schema` for each script (by reading the code + `SKILL.md`); the admin/owner **reviews and confirms** the proposal, then the manifest is written into `runtime.scripts` in the `SKILL.md` frontmatter (source of truth) and a reinstall promotes the skill to `typed`, exposing the scripts as tools. Endpoints: `propose-compilation` → `compile`.

---

## 13. Flows — deterministic block-based workflows

When the "improvising" agent isn't enough and you need a **repeatable and predictable** action, you use a **Flow**: a block graph (React Flow canvas) executed as a **DAG** with parallel branches. Settings → **Flows**.

- **Node types (12):** `tool` · `llm` · `condition` · `http` · `skill` · `transform` (JS sandbox) · `flow` (sub-flow) · `agent` · `team` · `loop` (map over array) · `join` (fan-in) · `chat` (posts a message in a chat).
- **Data binding between nodes:** `{{ input.x }}` (flow input) and `{{ nodes.<id>.output }}` (output of a previous node).
- **Triggers:** `manual` · `cron` (recurring) · `scheduled` (once) · `webhook` (public endpoint without JWT) · `chat-as-tool` (the flow becomes an agent tool). Scheduler on **BullMQ + Redis**.
- **Robustness:** per-node error policy (`stop`/`continue`/`retry`), **per-node test run** (runs only the predecessor subgraph), execution history with per-node timeline.
- The `transform` node runs isolated JS (`isolated-vm`) via the executor's `/eval` endpoint.

> Flows and Multi-Agent are complementary: a node can be an agent/team, and an agent can invoke a flow (as a tool).

Main APIs: `GET|POST|PUT|DELETE /api/flows/:id` · `POST /api/flows/:id/run` · `GET /api/flows/:id/runs` · `POST /api/flows/webhook/:token`.

---

## 14. Multi-Agent — agents and teams

Define reusable **agents** and compose them into **teams** with a topology. Settings → **Agents** / **Agent teams**.

- **Agent** = system prompt + model (`LlmConfig`) + filter on the available tools.
- **Team topologies:** `supervisor` (one agent delegates to the others and synthesizes) · `sequential` (A→B→C) · `parallel` (concurrent + aggregation).
- A **chat** can run with a team (selector in the footer): per-agent steps are shown live via the SSE `agent_step` event. Association: `PATCH /api/chats/:id/agent-team`.
- **Cross-provider** routing (no single-provider logic).

API: `GET|POST|PUT|DELETE /api/agents/:id` · `POST /api/agents/:id/run` · `GET|POST|PUT|DELETE /api/agent-teams/:id` · `PUT /api/agent-teams/:id/members` · `POST /api/agent-teams/:id/run`.

---

## 15. Auto-Scheduling — schedule automations from chat

Ask in chat *"every morning at 8 check the mail and summarize it"* and the automation is actually **prepared** and scheduled.

- The built-in tool **`schedule_task`** interprets the request, picks the needed tools (default: none → cheap) and prepares the automation; the user **confirms** it (safe by default: it doesn't fire until confirmed).
- On fire, a **headless runner** re-runs the agent with the instruction and **delivers the outcome** via notification and/or in a dedicated **chat thread** (with an unread badge). It can use a team of agents.
- Supporting built-ins: `get_current_datetime` (the agent doesn't get the date/time wrong); guard on `runAt` in the past.
- Configurable **guardrails** (env): `SCHED_MAX_TASKS_PER_USER`, `SCHED_MAX_ACTIVE_RECURRING`, `SCHED_MAX_TOKENS_PER_RUN` (over threshold → auto-disable). Token/cost per run visible in the UI.

Management: Settings → **Automations**. API: `GET /api/scheduled-tasks` · `POST /api/scheduled-tasks/:id/activate` · `PATCH /api/scheduled-tasks/:id/enabled` · `DELETE /api/scheduled-tasks/:id`.

---

## 16. Running activity — unified dashboard

Settings → **Activity**: a **read-only** view that aggregates everything running or scheduled for you — active **skill daemons**, **automations**, **flows** with cron/scheduled triggers and the **latest runs**. Counters at the top, automatic refetch every 10s. `GET /api/activity`.

---

## 17. Security & isolation

**Capability** model: every power (network, filesystem, SQL operations, MCP `local`) is **declared + approved**, with a safe default and a ceiling tied to identity.

| Area | Measure |
|---|---|
| Secrets | Authenticated AES-256-GCM; `TOOL_SECRETS_KEY` required (fail-fast at startup) |
| Docker prod | Internal services without host ports, mandatory passwords; ports only in dev (override) |
| MCP | `local` admin only; anti-**SSRF** guard on `http`/`sse` (blocks EC2 metadata, RFC1918, localhost) |
| Anti-SSRF DataSource | The same guard on **all** DataSources/DB (SQL/Mongo/Redis/file-share): metadata/link-local always blocked; private hosts gated by an admin policy (`dataSourceAllowPrivateHosts`, default on, + host/IP/CIDR allowlist) — *Settings → DataSource security* |
| Skills (untrusted) | Egress allowlist `network:` (C1) · per-tenant access-aware filesystem (C2) · **per-user physical output isolation** `skills-output/<userId>` · hardened container-per-job via broker (D2) · `filesystem`/`sql.operations` capabilities · registry checksum (E3) |
| Generated files | Skill/sandbox outputs are tracked as `File` and attached to the message → visible in the chat/project file panel; `?rel=` download confined to the owner, sharing via access-aware by-id download |
| File download | Only access-aware `?rel=` (`canAccess`); no absolute `?path=` |
| Traceability | Structured audit log on the chokepoints (auth, admin, executions, files, SQL, MCP) with "runs-as" identity |

**Trust boundary:** the backend is trusted-but-exposed and does **not** hold host-root capabilities; the Docker socket lives **only** in the broker (a minimal, internal component). Activation of the isolation layers: § 2.7.

---

## 18. Token and cost optimization

### 18.1 Tool Loading Strategy

By default the agent loads only the tools relevant to the current query, reducing input tokens by 40-60%.

**Settings → Profile** (per-user) or **Settings → AI System** (global):

| Strategy | Behavior | When to use it |
|---|---|---|
| `semantic_rag` | Embed the query → cosine similarity over the tools | Default — great with many tools and rich descriptions |
| `keyword_bm25` | BM25 score on name+description | Tools with specific keywords, no embedding provider |
| `always_inject_all` | All tools always | Debug, few tools (<5), cases where any tool might be needed |

**Max tools per request:** the maximum number of extra tools injected (built-ins always included).  
**Schema format:**
- `full` — full schema with all parameters (default)
- `compact` — reduced schema, without verbose descriptions
- `names_only` — tool names only (maximum savings, less guidance for the LLM)

### 18.2 Conversation memory: budget, trim and compaction

At every message the agent does NOT receive the whole chat, but a history reconstructed within a
**token budget** (`maxHistoryTokens`). Two distinct mechanisms govern it — understanding the
difference avoids surprises like "the model forgot what we said":

**1. Trim (always active).** Regardless of configuration, before every LLM call the
history is measured and, if it exceeds the budget, the **oldest turns are discarded** until it
fits. The cut is at whole turns (never in the middle of a question/answer pair or of a
tool-call/result sequence). The trim gives no warning: the excess simply disappears.

**2. Compaction / rolling summary (toggle, default ON).** With `historyCompactionEnabled`
active, when the history exceeds the threshold (`historyCompactionThreshold`, default 80% of the
budget) the oldest turns are **summarized** by a dedicated LLM (config `isSummarizer`)
instead of being lost: the summary is persisted on the chat (`chat.summary`, incremental) and
injected into the system prompt, where it **does not consume the history budget**. Recent turns stay
verbatim. Turning off compaction does NOT mean "pass the whole history": it means that
the excess beyond the budget is thrown away by the trim instead of being summarized.

> ⚠️ A turn's weight also includes the **tool results** (replayed in the history to
> give the model continuity, truncated to 3,000 characters each — env
> `REPLAY_TOOL_OUTPUT_MAX_CHARS`): a turn with many SQL queries weighs much more than its
> visible text.

**Parameters (Settings → AI System, admin; per-user override in Profile):**

| Parameter | Default | Notes |
|---|---|---|
| `maxHistoryTokens` | 30,000 | History budget (~4 char/token). Higher = more contextual memory but more input tokens per message (history is not covered by prompt caching). Per-user override: `Settings → Profile` (empty = global) |
| `historyCompactionEnabled` | ON | OFF = the excess is discarded, not summarized (not recommended for long chats) |
| `historyCompactionThreshold` | 80% | Compaction trigger threshold; after firing, the last ~40% of the budget stays verbatim |

The agent's step limit (LLM ↔ tool calls for a single message) is
configurable via the `AGENT_RECURSION_LIMIT` env in the backend `.env` (default 50 steps ≈ 25
LLM turns, minimum applied 10): exceeding it produces the `GraphRecursionError` error — usually
it indicates the agent is looking for data that doesn't exist or that it lacks context (see
`DATAFLOW_AGENT.md` for the full flow with diagrams).

### 18.3 Prompt Caching

The backend automatically leverages the provider's prompt caching:

| Provider | Type | Notes |
|---|---|---|
| **Anthropic** | Explicit — `cache_control: { type:'ephemeral' }` | 5-min TTL. Write ×1.25 cost, read ×0.10 (90% savings). The entire system prompt is marked. |
| **OpenAI** | Automatic on the stable prefix | Prefix ≥1024 tok cached automatically; 50% discount. No markers needed. |
| **Gemini** | Automatic | `cachedContentTokenCount` mapped in LangChain → logged as `cache_read`. |
| **DeepSeek** | Automatic | `prompt_cache_hit_tokens` intercepted by the SSE interceptor in `LlmProviderService`. Logs hit/miss in debug. |

**How to read the cache logs:**
```
[call 1/agent] in=4911 out=118 cache(r=4850 w=61) → tool:skill_gmail_list_emails_py
[call 2/agent] in=5082 out=287 cache(r=4850 w=0) → final response
Tokens used: input=9993 output=405 | cache: read=9700 write=61 (2 LLM calls)
```

### 18.4 Selective SKILL.md

Skills with multiple scripts can segment the SKILL.md with markers to load only the relevant sections:

```markdown
<!-- SHARED SECTION: always included regardless of the selected tools -->
# Skill Name
General description and routing table

<!-- @tool: script_a.py -->
## Section for script_a.py
Input/output details for this script...

<!-- @tool: script_b.py -->
## Section for script_b.py
...
```

- All text **before the first marker** = shared section (always included)
- Each `<!-- @tool: name.py -->` section is included **only** if that tool was selected
- If there are no markers, the entire SKILL.md is included (backward compatible)

---

## 19. Architecture for developers

### Flow of a chat request

```
1. Frontend → POST /api/chats/:id/messages/stream
2. MessagesController → saves the user message to PostgreSQL
3. AgentService.streamResponse() calls resolveAgent(userId, projectId, userInput, history)
4. resolveAgent() — Phase 1 (parallel):
   a. AppConfigService.getSystemPrompt()        (in-memory cache)
   b. LlmProviderService.getModel()             (in-memory cache, rebuilds if invalidated)
   c. CustomToolsService.loadToolsForUser()     (DB query)
   d. McpServersService.loadToolsForUser()      (http fetch or bridge registry)
   e. SkillsService.loadToolsForUser()          (skill scripts → DynamicStructuredTool)
   f. userRepo.findOne(userId)                  (systemPrompt, toolLoadingStrategy, maxHistoryTokens)
   g. projectRepo.findOne(projectId)            (project systemPrompt)
   h. AppConfigService.getToolLoadingConfig()   (global tool-loading config)
   i. LlmProviderService.getProvider()          (for prompt caching branch)
   resolveAgent() — Phase 2 (serial):
   j. ToolSelectionService.applyStrategy()      (semantic_rag / bm25 / always_inject_all)
   k. SkillsService.buildSkillSystemPromptSelective() (SKILL.md for selected tools only)
   → buildSystemPrompt(base, user, project, skills)   ← 4 levels
   → messageModifier with cache_control (Anthropic) or string (other providers)
   → createReactAgent({ llm, tools: [...builtin, ...optimized], messageModifier })
5. LangGraph agent.stream() starts the ReAct loop
6. For each chunk:
   - text block → SSE chunk to the frontend
   - tool_use block → SSE tool_call to the frontend (UI shows "Using...")
   - ToolMessage → ignored (not shown to the user)
7. On completion → saves the full response to PostgreSQL
```

### Adding a built-in tool

1. Create the tool file, e.g. `backend/src/agent/my-tool.ts`:

```typescript
export function createMyTool(deps: MyDependencies): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'tool_name',              // snake_case
    description: '...',              // crucial: the LLM decides when to use it
    schema: z.object({ ... }),       // Zod schema of the inputs
    func: async ({ ... }) => {       // must always return a string
      // ...
      return result.toString();
    }
  });
}
```

2. Register it in `AgentService.onModuleInit()` (the `builtInTools` array is empty by
   default — the legacy vertical tools were removed in favor of the *custom tool types*):

```typescript
this.builtInTools = [
  createMyTool(myDependencies),   // ← register your built-in tools here
];
```

3. Add the tool's description to the `SYSTEM_PROMPT` (or from the admin panel).

> Note: for most cases it's better to use a **custom tool** (http/sql/rag/prompt)
> or a **custom executor type** (below), without touching the agent's code.

### Adding a custom executor type

1. Add the type in `custom-tool.types.ts`:
   ```typescript
   export type ExecutorType = 'http' | 'sql' | 'prompt' | 'rag' | 'my_type';
   export interface MyExecutorConfig { /* ... */ }
   ```

2. Implement the executor in `custom-tool.factory.ts` inside `buildDynamicTool()`.

3. Add a TypeORM migration to update the `executor_type` enum in the DB.

4. Update the form in the UI (`ToolsPage.tsx`, `IdentitySection` section).

### Adding an LLM provider

1. Install the provider's LangChain package: `@langchain/new-provider`
2. Add the type in `app-config.entity.ts`:
   ```typescript
   export type LlmProvider = 'anthropic' | ... | 'new_provider';
   ```
3. Add the case in `LlmProviderService.buildModel()`.
4. Add the default in `PROVIDER_DEFAULTS`.
5. Update the UI in `SettingsPage.tsx` (provider select).

---

## 20. DB schema and migrations

### Main tables

> Real names from the TypeORM entities. Sequential migrations in `backend/src/database/migrations/`.

```text
# Identity & collaboration
users                     -- role (admin|user), status (active|disabled), systemPrompt, tool-loading preferences
teams                     -- organization teams
team_memberships          -- user ↔ team (owner|member)
projects                  -- projects (per-project systemPrompt, owner userId)
project_teams             -- project shared with N teams (collaborator|viewer)

# Chat & content
chats                     -- conversations (userId, projectId, agentTeamId, summary/compaction)
messages                  -- messages (role, content, chatId, authorId, toolCalls)
message_feedback          -- 👍/👎 per message (feedback loop)
files                     -- upload/output (scope personal|team|org, userId, projectId)
notifications             -- real-time notifications (daemon, automations)
user_memory               -- persistent user memory

# Agent: tools, data, MCP, RAG
custom_tools / tool_secrets          -- http|sql|rag|prompt tools + encrypted secrets
data_sources                         -- external DB connections (encrypted connection string)
mcp_servers / mcp_server_secrets     -- MCP servers (http|sse|local|remote) + secrets
vector_db_config / vector_collections-- vector DB provider + managed collections

# AI configuration
app_config                -- singleton (id=1): base system prompt, embedding, tool-loading,
                          --   history compaction; (legacy llm* fields: the truth is llm_configs)
llm_configs               -- multi-record: provider/model/apiKey, isDefault + isSummarizer

# Skills
skills                    -- metadata, status, scope, isApproved, enabled, packagePath
skill_scripts             -- scripts (filename, language, description, inputSchema, mode)
skill_config_vars         -- config var per skill (value encrypted if secret)
skill_project_assignments -- skill ↔ project
skill_daemons             -- registered skill daemons (background/watch)

# Core features
flows / flow_runs                          -- DAG workflow + execution history
agents / agent_teams / agent_team_members  -- Multi-Agent (agents, teams, membership)
scheduled_tasks                            -- automations (Auto-Scheduling)

# Security
audit_log                 -- structured events (auth, admin, executions, files, SQL, MCP)
```

### Migration management

```bash
# Apply all migrations
npm run migration:run

# Generate a new migration after modifying an entity
npm run migration:generate -- src/database/migrations/MigrationName

# View migration status
npm run migration:show

# Roll back the last migration
npm run migration:revert
```

**Naming convention:** `1778900000000-MigrationName.ts` — use a progressive timestamp to keep the order.

**Important:** do not modify migrations already applied in production. Always add a new migration.

---

## 21. API reference

### Authentication

```bash
# Registration
POST /api/auth/register
{"email": "...", "name": "...", "password": "..."}

# Login → returns access_token
POST /api/auth/login
{"email": "...", "password": "..."}
```

All subsequent APIs require `Authorization: Bearer <token>`.

### User profile

```bash
GET   /api/users/profile
PATCH /api/users/profile
{"name": "Alice", "systemPrompt": "Always answer me concisely."}
```

### Chat and messages

```bash
# List projects
GET /api/projects

# Create a project with a system prompt
POST /api/projects
{"name": "Client Project", "systemPrompt": "Client engagement with a defined budget and timeline"}

# Send a message with SSE streaming
POST /api/chats/:chatId/messages/stream
{"content": "Propose a solution for this requirement", "attachmentIds": []}
# → SSE stream (main types):
#   data: {"type":"chunk","content":"..."}                       # text token
#   data: {"type":"tool_call","toolCall":{...}}                  # tool invoked
#   data: {"type":"tool_result","name":"...","ok":true}          # tool outcome
#   data: {"type":"file","name":"report.pdf","rel":"skills-output/report.pdf"}  # produced file (download ?rel=, access-aware)
#   data: {"type":"agent_step","agent":"...","role":"...","output":"..."}       # team step (chat with team)
#   data: {"type":"usage","inputTokens":123,"outputTokens":45}   # token statistics
#   data: {"type":"done","messageId":"..."}
```

### Custom Tools

```bash
# List tools
GET /api/custom-tools

# Create a tool
POST /api/custom-tools
{
  "name": "search_web",
  "description": "Search the web...",
  "parameters": [{"name": "query", "type": "string", "description": "...", "required": true}],
  "executorType": "http",
  "executorConfig": {"url": "https://api.example.com?q={{query}}", "method": "GET"}
}

# Test a tool
POST /api/custom-tools/:id/test
{"args": {"query": "test"}}

# Add a secret
POST /api/custom-tools/:id/secrets
{"keyName": "MY_API_KEY", "value": "sk-..."}
```

### Data Sources

```bash
# Create a data source
POST /api/data-sources
{
  "name": "Business Management System",
  "connectionString": "mysql://user:pass@host:3306/db",
  "schemaHints": "orders.customer_id → customers.id",
  "prefetchRelations": false,
  "scope": "org"
}

# Test connection
POST /api/data-sources/:id/test
```

### App configuration (admin)

```bash
# Read the current configuration (system prompt, embedding, tool-loading)
GET /api/app-config

# LLM configurations — multi-record (default + summarizer + vision), llm-configs module
GET    /api/llm-configs                      # list
POST   /api/llm-configs                      # create
{
  "name": "OpenAI GPT-4o",
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "baseUrl": null,
  "maxTokens": null
}
PATCH  /api/llm-configs/:id                  # update
DELETE /api/llm-configs/:id
POST   /api/llm-configs/:id/set-default      # set as default
POST   /api/llm-configs/:id/set-summarizer   # use for summaries (history compaction)
POST   /api/llm-configs/:id/set-vision       # use for vision tasks (image OCR)
POST   /api/llm-configs/clear-vision         # clear (vision tasks use the default)
POST   /api/llm-configs/:id/test             # test connection

# Update embedding
PATCH /api/app-config/embedding
{
  "embeddingProvider": "voyage",
  "embeddingModel": "voyage-multilingual-2",
  "embeddingApiKey": "pa-...",
  "embeddingVectorSize": 1024
}

# Update system prompt
PATCH /api/app-config/system-prompt
{"systemPrompt": "You are an AI assistant..."}
```

### Vector DB (admin)

```bash
# Current configuration
GET /api/vector-db/config

# Update provider
PATCH /api/vector-db/config
{
  "provider": "pgvector",
  "connectionString": "postgresql://user:pass@host:5432/db"
}

# List collections
GET /api/vector-db/collections

# Create a collection
POST /api/vector-db/collections
{"name": "my_collection", "vectorSize": 1024}
```

---

## 22. Troubleshooting

### The backend won't start

**`Error: connect ECONNREFUSED 127.0.0.1:5432`**  
→ PostgreSQL is not running: `docker compose up postgres -d`

**`relation "app_config" does not exist`**  
→ Migrations have not been applied: `npm run migration:run`

**`TOOL_SECRETS_KEY invalid`**  
→ The AES key must be exactly 32 hex bytes (64 characters): `openssl rand -hex 32`

---

### TypeScript build fails with OOM

```
FATAL ERROR: Reached heap limit Allocation failed
```

**Cause (historical):** LangGraph uses very complex TypeScript types that could saturate the heap.  
**Current status:** resolved — the backend compiles with **tsc** (`nest-cli.json` → `"builder": "tsc"`). Both the build and type-check run clean; if needed, raise Node's memory.

```bash
# ✅ Build (tsc) + type-check
npm run build       # → nest build (tsc builder, validates types)
npm run typecheck   # → tsc --noEmit

# If it OOMs on machines with little RAM:
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

---

### Vector dimension mismatch

```
Vector dimension mismatch: model returns 384 dims, collection created with 1024.
```

**Cause:** the embedding provider/model was changed after the collections were created.  
**Solution:**
1. Update `embeddingVectorSize` in Settings → AI System → Embedding
2. Delete the existing vector collections (Settings → Vector DB)
3. Reindex all documents

---

### OpenAI SDK returns vectors of the wrong dimension (base64 encoding)

**Cause:** OpenAI SDK ≥ 4.25 sends `encoding_format=base64` by default. Local servers (LM Studio, Ollama) don't support base64 and return floats, but the SDK interprets them as a binary buffer.

**Already-implemented solution:** the probe in `EmbeddingProviderService` uses a direct `fetch()` with an explicit `encoding_format: 'float'`. If the problem persists, verify that the embedding provider is set to **LM Studio** (not OpenAI) for local servers (Settings → AI System).

---

### MCP tool not available in the agent

1. Verify that the MCP server is enabled (toggle in the UI)
2. For `local` transport: check the backend logs — the process must show as "running"
3. For `remote` transport: verify that the Electron bridge is connected (status in the bridge bar)
4. Check that the tool name does not collide with a custom tool (`mcp_{server}_{tool}`)

---

### CORS: the browser rejects the requests

**Cause:** `cors: true` passed to `NestFactory.create` causes duplicate headers.  
**Solution:** the CORS configuration must live **only** in `app.enableCors()` in `main.ts`. Verify that `FRONTEND_URL` is set correctly.

---

### Skill stays in `installing` or `error` status

1. Click the status badge on the skill card → the installation log opens
2. Common problems:
   - **pip/npm not found** → verify that the `skill-executor` container is running (`docker compose ps`)
   - **Nonexistent package** → check the exact name on PyPI/npm
   - **Timeout** — installing Puppeteer for the first time downloads Chromium (~170 MB); increase `INSTALL_TIMEOUT_MS` in `.env.executor` (root)
3. Use the "Reinstall" button to retry without re-uploading the ZIP

---

### Skill in `ready` status but the tool doesn't appear to the agent

1. Verify that the skill is **assigned to the current project** ("Assign" tab in the drawer)
2. Verify that the script has a valid `input_schema` in the `SKILL.md` frontmatter
3. Check that the tool name (`skill_{name}_{script}`) does not collide with a custom tool

---

### Skill execution error (exit_code ≠ 0)

The tool returns the entire output (stdout + stderr) to the LLM. To debug:
1. Test the script manually via the API:
   ```bash
   curl -X POST http://localhost:4000/execute \
     -H 'Content-Type: application/json' \
     -d '{"skill_id":"...", "filename":"scripts/main.py", "language":"python", "input":{...}, "timeout_ms":30000}'
   ```
2. Check `stderr` in the response
3. Verify that the paths (`OUTPUT_DIR` etc.) are absolute — in development set `UPLOAD_DIR` to an absolute path

---

### Puppeteer / Chromium not found in the Node skill

```
Error: Could not find Chrome (ver. xxx). This can occur if either
1. you did not perform an installation step
```

The skill uses `puppeteer@22` — the Chromium download happens during `npm install` in the skill's installation phase. If the download was skipped:
1. Delete the skill's `.deps/node` directory:
   ```bash
   rm -rf backend/uploads/skills/{skill_id}/.deps/node
   ```
2. Use the "Reinstall" button in the UI
3. If the problem persists inside Docker, verify that the container had internet access during installation.

---

### PDF is not generated (built-in Python tool)

```
Could not find Chromium
```

```bash
cd backend
npx puppeteer browsers install chrome
```

---

### Cloud LLM does not respond (401/403)

1. Verify that the API key is configured in Settings → AI System → LLM
2. If the key is on the env var but not in the DB, check that the provider matches
3. Test the key directly with `curl` against the provider's API

---

### Tool not found with the `semantic_rag` or `keyword_bm25` strategy

The tool exists but the agent doesn't use it — it was probably filtered out by the selection.

1. Check the backend logs: `Context: tools=Xtok(×N)` — if N is low, the tool was excluded
2. Increase `toolLoadingMaxTools` in Settings → Profile
3. Or switch to `always_inject_all` temporarily to verify
4. Improve the tool's `description` (more semantically relevant keywords) to raise the selection score

---

### Conversation history too short / context lost

The LLM doesn't remember previous messages — the history token budget is exhausted.

1. Check the logs: `History trimmed: X → Y msg (~Ztok, budget=6000tok)`
2. Increase `Max history tokens` in Settings → Profile (or globally in Settings → AI System)
3. Recommended values: 6,000 = ~20 short exchanges; 16,000 = long conversations; 0 = no limit (only a 20-message cap)

---

### DeepSeek — 400 error "reasoning_content must be passed back"

**Cause:** the history contains AI messages without the `reasoning_content` field, required by the API.  
**Solution:** already handled automatically — the fetch interceptor injects `reasoning_content: ''` on every assistant message. If the problem persists, verify that the provider in the DB is set to `deepseek` (not `openai-compatible`).

---

## 23. Terminal client (CLI)

The `arkimede` CLI (workspace `cli/`) brings login and chat to the shell,
against any running backend — same REST + SSE API, same JWT, no server-side
changes. Linux/macOS, Node ≥ 18.

```bash
npm install -g arkimede-cli                  # or: cd cli && npm install && npm run build
arkimede login --url http://localhost:3000   # prompts email + password
arkimede                                     # full-screen TUI on the latest chat
```

Highlights:

- **TUI** (default): chat sidebar (`Tab` to focus, `n` new chat), streaming
  replies with compact tool status lines, `Esc` aborts generation, `s` opens
  the **settings panel** — 7 tabs (Profile, LLM, Tools, Skills, Data, MCP,
  Usage) with full CRUD for LLM configs, tools and MCP servers, and
  enable/disable toggles, all through the same endpoints and permissions as
  the web UI.
- **Plain REPL** (`--plain`, automatic when piped): scriptable —
  `printf 'question\n/quit\n' | arkimede chat --last`.
- **Session**: JWT stored in `~/.config/arkimede/config.json` (mode 0600);
  on expiry just log in again. The model is always resolved server-side
  (default LLM config).

Full reference (key bindings, settings tabs, per-form notes, implementation
details): **[CLI.md](CLI.md)**.

---

*Last updated: July 2026 — Terminal client (CLI); previously: tool loading optimization, prompt caching, DeepSeek, 4-level system prompt, selective SKILL.md*
