# Arkimede — Project Context Document

> **Usage:** Load this file into the claude.ai Project as fixed context.  
> Claude will use it as a reference in every future session without needing it re-explained.

---

## 1. Overview

**Arkimede** is a multi-user AI platform that lets you connect custom HTTP tools, SQL queries, RAG tools over vector
collections and MCP servers to a configurable AI agent.

The user can:

- Define **custom tools** (HTTP, SQL, RAG, sub-agent prompt) without writing code
- Connect remote **MCP servers** (http/sse) or local ones (stdio via the Electron bridge or directly from the backend)
- Configure the **LLM provider** (Anthropic, OpenAI, Gemini, Ollama, LM Studio, OpenAI-compatible, DeepSeek) and the *
  *vector DB** (Qdrant, PGVector, Chroma, AstraDB) from the admin UI — no redeploy
- Customize the **system prompt** across **4 levels**: global (admin) → user → project → skills (selective SKILL.md)
- Optimize token consumption with **tool loading strategy**, **max history tokens** and **prompt caching**
- Use the tools directly in the chat with the agent

Beyond chat, the platform offers **four pillars** integrated end-to-end (see dedicated sections):

- **Flows** — **deterministic** block-based workflows (React Flow canvas): a DAG graph with **parallel** execution, 12 node
  types (tool/llm/condition/http/skill/transform/flow/agent/team/loop/join/chat), error-policy/retry, **per-node test
  run** (subgraph), and **manual/cron/scheduled/webhook/chat-as-tool** triggers on BullMQ+Redis. *(→ [Flows](#flows))*
- **Multi-Agent** — the user defines **agents** (prompt + model + tool filter) and composes them into **teams** with a
  **supervisor / sequential / parallel** topology; a chat can run with a team. *(→ [Multi-Agent](#multi-agent-level-2))*
- **Auto-Scheduling** — schedule automations **from the chat** ("every morning at 8, check the mail and summarize"): a
  built-in tool prepares the automation, the user confirms, and on fire a headless runner re-runs the agent and notifies
  the outcome. *(→ [Auto-Scheduling](#auto-scheduling-design))*
- **Integration** — flows are agent tools and can invoke agents/teams; agents can invoke flows; automations can run a
  team. Everything shares the LangGraph runtime and the BullMQ scheduler.

---

## Users, Teams & Scope Management

A **collaborative multi-tenant** platform: one organization (the installation) with users, roles and teams.

**Roles & accounts**

- `role`: **admin** (management) | **user**. The **first registered user becomes admin** (bootstrap); the others are user
  until an admin promotes them.
- `status`: **active** | **disabled**. Login is blocked if disabled; `jwt.strategy` reloads the user from the DB on every
  request → disabling and role changes take **immediate effect**.
- Admin CRUD at `/api/admin/users` (UI: Settings → Users). Safeguards: never remove/disable/delete the **last active
  admin**; no destructive actions on yourself.

**Teams**

- Groups of users (`teams` + `team_memberships`, role **owner**|**member**). UI: Settings → Teams.
  `GET /api/teams/mine` feeds the scope selectors.

**Resource scope (`personal | team | org`)** — on **custom tools, skills, data sources**:

| Scope      | Who sees/uses it       | Who manages it             |
|------------|------------------------|----------------------------|
| `personal` | only the creator       | the creator                |
| `team`     | the team members       | **admin or team owner**    |
| `org`      | the whole organization | **admin**                  |

- The scope **determines what the agent loads for each user** (personal + own team + org).
- **Skill**: `team` = direct publication by the owner to the members (no review); `org` = submission for review and
  **admin approval** (`isApproved`).
- Visibility is **membership-based even for admins**: an admin who is not a member of a team does not see those resources in
  the list/agent, but manages them by id / from the Teams UI. (Adjustable in `visibilityWhere`.)

> Collaborative meaning: **org** = standard, trusted tools/connectors for the whole company (curated by admins);
**team** = tools and data of a department, managed autonomously by its owners; **personal** = individual
> experimentation. It guarantees no duplication, standardization, per-department confidentiality and delegation without
> bottlenecks.

**Collaborative projects (multi-team)**

While *resources* (tool/skill/data source) remain single-team, **projects** — the unit of work (chat + files +
context) — can be shared with **multiple teams** (e.g. *architects* and later *sales* on the same project).

- Join table `project_teams (projectId, teamId, role)` with role **collaborator** | **viewer**. A project can be
  assigned to N teams; adding/removing a team is a row in/out (free-of-charge phasing over time).
- `projects.userId` = **owner** (nullable, `ON DELETE SET NULL`): if the user is deleted the team project
  survives (reassignable), it does not disappear.
- **Project visibility**: owner **or** member of an assigned team (`ProjectsService.accessLevel` →
  owner|collaborator|viewer|null). By cascade, the project's **chats and files** become visible to all members.
- **Management** (settings + team assignment): **owner or admin only** (`assertCanManage`). UI: project modal →
  "Sharing with teams" (+ project deletion).
- **Shared chats (threads)**: every member sees the project's chats; **collaborator/owner can write** in the
  same thread, **viewer read-only** (`messages.authorId` tracks who wrote each turn;
  `ChatsService.findOneForWrite`). Rename/delete chat = author.
- **Files**: uploadable by collaborators (not viewers), viewable/downloadable by all members
  (`FilesService.findByProject` / `findOneReadable`).

---

## 2. General Architecture

```
[Browser]
    │
    ├── React SPA (Vite + Tailwind) ─────────────────────────┐
    │   JWT auth · SSE streaming · file upload · settings    │
    │                                                         │
    └── REST + SSE /api/* ◄──────────────────────────────────┤
                   │                                         │
                   ▼                                         │
           NestJS Backend :3000                              │
                   │                                         │
       ┌───────────┼────────────────────────────┐            │
  AuthModule  ChatsModule  FilesModule          │            │
       └───────────┼────────────────────────────┘            │
              AgentModule                                    │
          LangGraph ReAct Agent                              │
              (LLM via LlmProviderService)                   │
                   │                                         │
    ┌──────────────┼──────────────────────────┐             │
    ▼              ▼              ▼            ▼             │
CustomToolsService  McpServersService  AppConfigService  LlmProviderService
    │              │              │            │
    │   DataSourcesService    VectorDbModule  EmbedModule
    │              │
    │         http/sse    McpBridgeGateway (WebSocket)
    │         remote      │
    │                     ▼
    │              Electron Bridge  ◄────────────────────────┘
    │              ├─ BridgeManager (Socket.io client)
    │              └─ McpProcess (child_process stdio)
    │
    └── EmbedModule → VectorStoreProviderService → Qdrant/PGVector/Chroma/AstraDB
```

### 2.1 Container topology (Docker)

Network connections and data exchange between the containers. In **production** only `frontend` (5173) and `backend` (3000) are exposed to the host; everything else communicates by service name on the internal network. `skill-executor`, `broker` and the `container-job`s are active/hardened with the `egress` (C1) and `broker` (D2) overlays.

```mermaid
flowchart TB
    user([Browser / User])
    bridge["Electron Bridge<br/>(user machine · not a container)"]
    NET(("Internet<br/>allowlisted domains"))

    subgraph host["Docker Host"]
      direction TB
      subgraph appnet["application network (internal services)"]
        FE["<b>frontend</b><br/>React SPA + nginx · :5173<br/><i>serves the UI</i>"]
        BE["<b>backend</b><br/>NestJS + LangGraph · :3000<br/><i>API, agent, orchestration</i>"]
        PG[("<b>postgres</b><br/><i>application DB</i>")]
        QD[("<b>qdrant</b><br/><i>vector DB / RAG</i>")]
        RD[("<b>redis</b><br/><i>BullMQ queue</i>")]
        EM["<b>embedding</b><br/>FastAPI<br/><i>generates the vectors</i>"]
      end
      subgraph sandbox["sandboxnet — internal, no gateway (egress/broker overlay)"]
        EX["<b>skill-executor</b><br/>Fastify sidecar<br/><i>install/run skill, daemon</i>"]
        BK["<b>broker</b><br/>job-launcher<br/><i>the only one with the Docker socket</i>"]
        JOB["<b>container-job</b><br/>ephemeral, 1 per execution<br/><i>runs the skill script, hardened</i>"]
      end
      PROXY["<b>egress-proxy</b><br/>squid<br/><i>domain allowlist (C1)</i>"]
    end

    user -- "HTTPS · SPA" --> FE
    user -- "REST + SSE /api/*" --> BE
    FE -. "proxy /api" .-> BE
    bridge -. "WebSocket /mcp-bridge<br/>(MCP transport remote)" .-> BE

    BE -- "SQL · TypeORM" --> PG
    BE -- "search / upsert vectors" --> QD
    BE -- "Flows jobs + scheduling" --> RD
    BE -- "POST /v1/embeddings" --> EM
    BE -- "POST /install · /execute · /daemon<br/>(internal network, no host port)" --> EX

    EX -- "/internal/* : save-config,<br/>files/search, datasource, vector<br/>(signed x-internal-token)" --> BE
    EX -- "POST /run-job (D2)" --> BK
    BK -- "docker run (host socket)" --> JOB
    JOB -- "/internal/* (NO_PROXY)" --> BE
    JOB -- "egress declared in SKILL.md runtime.network" --> PROXY
    PROXY -- "only allowed domains" --> NET
```

**What each container is for**

| Container | Role | Talks to | Exposed to host (prod) |
|---|---|---|---|
| **frontend** | React SPA (UI), nginx serves the static files | backend (`/api`) | ✅ `:5173` |
| **backend** | REST/SSE API, LangGraph agent, orchestration, auth | postgres, qdrant, redis, embedding, skill-executor | ✅ `:3000` |
| **postgres** | Application DB (users, chats, tools, skills, flows, audit…) | backend | ❌ (dev only) |
| **qdrant** | Vector DB for RAG | backend | ❌ (dev only) |
| **redis** | BullMQ queue: cron/scheduled triggers for Flows and Auto-Scheduling | backend | ❌ (dev only) |
| **embedding** | FastAPI microservice that computes embeddings (internal model by default, OpenAI-compatible) | backend | ❌ (dev only) |
| **whisper** | FastAPI voice transcription microservice (faster-whisper, OpenAI-compatible `/v1/audio/transcriptions`); internal default for voice input | backend | ❌ (dev only) |
| **skill-executor** | Sidecar that installs/runs skills (Python/Node/JS), manages daemons | backend (internal HTTP) ↔ broker | ❌ never |
| **broker** *(D2)* | Sole holder of the Docker socket: launches hardened container-jobs via the narrow `/run-job` API | skill-executor → Docker daemon | ❌ never |
| **container-job** *(D2)* | Ephemeral container (one per skill execution): cap-drop, read-only, non-root uid, per-job network | backend (`/internal/*`), egress-proxy | ❌ ephemeral |
| **egress-proxy** *(C1)* | squid proxy with allowlist: the only path to the internet for skills | container-job / skill-executor → internet | ❌ never |

> **Trust boundaries:** the `backend` is *trusted but exposed* and never touches the Docker socket; the "host-root" capability (socket) lives **only** in the `broker`. Skills (third-party code) run in the `container-job`s on `sandboxnet` (internal network with no gateway) and reach the internet **only** through the `egress-proxy` on the domains declared in `SKILL.md` (runtime.network).

> **Sandbox (tool `run_in_sandbox`):** capability to run **arbitrary** code/shell written by the agent, on the same broker engine (hardened container-job) but with a **per-chat persistent workspace** (`/workspace`, mounted writable). A 3-level network model (`none`/`egress`/`open`), admin **gating** (global flag + team/project allowlist) and **fail-closed** without a broker. It is also the runtime for **descriptive skills** (pure agentskills.io format). Unlike skills — reviewed code with an in-process fallback — the sandbox **never** runs in-process except with an explicit development opt-in. See the Skills guide.

---

## 3. Technology Stack

| Layer              | Technology                                     | Notes                                                                         |
|--------------------|------------------------------------------------|-------------------------------------------------------------------------------|
| Backend API        | NestJS 10 (TypeScript)                         | Modular architecture, JWT, SSE streaming                                      |
| AI orchestration   | LangChain.js + LangGraph                       | ReAct agent, tool routing, streaming                                          |
| LLM                | Configurable from the admin UI                 | Anthropic, OpenAI, Gemini, Ollama, LM Studio, OpenAI-compatible, DeepSeek     |
| Frontend           | React 18 + Vite + Tailwind CSS                 | Zustand state, @tanstack/react-query                                          |
| Application DB     | PostgreSQL + TypeORM                           | Users, chats, messages, files, tools, MCP, config, datasources, skills, daemons |
| Vector DB          | Qdrant (default) / PGVector / Chroma / AstraDB | Configurable via UI, provider-agnostic                                        |
| Desktop bridge     | Electron (electron-vite)                       | Spawns local stdio MCP processes (transport `remote`)                         |
| Skill executor     | Node.js + Fastify (Docker sidecar)             | Python/Node/JS-sandbox runners, Nix deps, internal API, daemon manager        |
| Skill isolation    | Broker container-per-job + egress-proxy (squid) | D2: cap-drop/read-only/non-root-uid, optional gVisor; C1: egress allowlist `network:` |
| Containerization   | Docker Compose                                 | secure base + `egress`/`broker` overlays; postgres·qdrant·redis·embedding·skill-executor·backend·frontend |

---

## 4. Project Structure

```
arkimede/
├── backend/
│   ├── src/
│   │   ├── main.ts
│   │   ├── app.module.ts
│   │   ├── agent/
│   │   │   ├── agent.module.ts
│   │   │   ├── agent.service.ts          # LangGraph ReAct agent + resolveAgent() + history compaction (compactHistory/summarize) + trimMessages
│   │   │   ├── tool-selection.service.ts # ToolSelectionService: top_k_rag / always_inject_all / auto × full|compressed|deferred
│   │   │   └── agent.controller.ts
│   │   ├── llm-configs/
│   │   │   ├── llm-config.entity.ts      # Multi-record LLM config (llm_configs): isDefault + isSummarizer
│   │   │   ├── llm-configs.service.ts    # CRUD + setDefault/setSummarizer + buildModelForConfig(entity, overrides)
│   │   │   └── llm-configs.controller.ts
│   │   ├── app-config/
│   │   │   ├── app-config.entity.ts      # Singleton app_config table (id=1)
│   │   │   ├── app-config.service.ts     # Config CRUD + in-memory cache
│   │   │   ├── app-config.controller.ts
│   │   │   ├── app-config.module.ts
│   │   │   └── llm-provider.service.ts   # Multi-provider LLM factory with cache + DeepSeek SSE interceptor
│   │   ├── custom-tools/
│   │   │   ├── custom-tool.entity.ts     # PostgreSQL entity (custom_tools)
│   │   │   ├── custom-tool.types.ts      # ToolParameter, ExecutorConfig (http/sql/prompt/rag)
│   │   │   ├── custom-tool.factory.ts    # buildDynamicTool() → DynamicStructuredTool
│   │   │   ├── custom-tools.service.ts   # CRUD + loadToolsForUser()
│   │   │   ├── custom-tools.controller.ts
│   │   │   ├── tool-secret.entity.ts     # Encrypted secrets (tool_secrets)
│   │   │   └── crypto.utils.ts           # AES-256-CBC encrypt/decrypt
│   │   ├── datasources/
│   │   │   ├── datasource.entity.ts      # External data sources (data_sources)
│   │   │   ├── datasources.service.ts    # CRUD + MySQL/PostgreSQL runtime connection
│   │   │   ├── datasources.controller.ts
│   │   │   └── datasources.module.ts
│   │   ├── mcp-servers/
│   │   │   ├── mcp-server.entity.ts      # PostgreSQL entity (mcp_servers)
│   │   │   ├── mcp-servers.service.ts    # CRUD + loadToolsForUser()
│   │   │   ├── mcp-servers.controller.ts
│   │   │   ├── mcp-bridge.gateway.ts     # WebSocket gateway (Socket.io /mcp-bridge)
│   │   │   ├── local-mcp-process.ts      # Direct stdio spawn (transport local)
│   │   │   ├── mcp-servers.module.ts
│   │   │   └── mcp-server-secret.entity.ts
│   │   ├── vector-db/
│   │   │   ├── vector-db-config.entity.ts  # Singleton vector DB config (id=1)
│   │   │   ├── vector-collection.entity.ts # Managed collections
│   │   │   ├── vector-db.service.ts        # Collection CRUD + orchestration
│   │   │   ├── vector-db.controller.ts
│   │   │   ├── vector-db.module.ts
│   │   │   ├── vector-store.types.ts       # VectorStoreAdapter interface
│   │   │   ├── vector-store-provider.service.ts  # Adapter factory (Qdrant/PGVector/Chroma/Astra)
│   │   │   └── adapters/                   # Provider implementations
│   │   ├── embed/
│   │   │   ├── embed.service.ts
│   │   │   ├── embed.controller.ts
│   │   │   ├── embed.module.ts
│   │   │   ├── ingest.service.ts           # Chunking → VectorStore
│   │   │   └── embedding.provider.service.ts  # internal(default)/lmstudio/voyage/openai/ollama/openai-compatible
│   │   ├── auth/                           # JWT auth (login, register, guard)
│   │   ├── users/
│   │   ├── projects/                       # Projects (group chats + files + systemPrompt)
│   │   ├── chats/
│   │   ├── messages/                       # SSE streaming: chunk / tool_call / file / usage / done
│   │   │   └── messages.controller.ts      # onToolResult → 'file' events for paths produced by the tools
│   │   ├── files/                          # Upload + PDF/Word/Excel parsing + download ?rel=
│   │   ├── skills/                         # Executable ZIP packages: upload, install, scope, review, registry
│   │   │   ├── skills.service.ts           # CRUD + buildSkillSystemPromptSelective() + enabled filter
│   │   │   ├── skill-tool.factory.ts       # DynamicStructuredTool for each skill script
│   │   │   ├── skill-executor.client.ts    # HTTP client to the executor sidecar
│   │   │   ├── registry.service.ts         # Fetch + cache GitHub registry (TTL, stale fallback)
│   │   │   └── internal-skills.controller.ts # POST /internal/skills/:id/save-config (InternalApiKeyGuard)
│   │   ├── daemons/                        # Long-running daemon processes for the skills
│   │   │   ├── daemons.service.ts          # start/stop/restart + onModuleInit auto-restore
│   │   │   ├── daemons.controller.ts       # REST /api/daemons
│   │   │   └── internal-daemons.controller.ts  # POST /internal/daemons/events
│   │   ├── notifications/                  # Socket.IO /notifications → emitToUser(userId)
│   │   ├── common/                         # Shared guards, decorators, interceptors
│   │   │   └── guards/internal-api-key.guard.ts  # Service-to-service authentication
│   │   ├── config/                         # app.config.ts (APP_NAME)
│   │   ├── database/
│   │   │   ├── data-source.ts              # TypeORM DataSource config
│   │   │   └── migrations/                 # ~52 sequential migration files
│   │   └── prompts/
│   │       └── system.prompt.ts            # Default system prompt (DB seed)
│   ├── .env
│   └── package.json
├── bridge/
│   ├── src/
│   │   ├── main/
│   │   │   ├── bridge.ts                   # BridgeManager: Socket.io ↔ McpProcess
│   │   │   ├── mcp-process.ts              # McpProcess: child_process stdio → JSON-RPC
│   │   │   ├── tray.ts                     # System tray icon
│   │   │   └── index.ts                    # Electron main
│   │   ├── preload/index.ts
│   │   └── renderer/                       # bridge UI (React)
│   ├── resources/                          # App icons
│   ├── electron-builder.yml
│   └── package.json
├── frontend/
│   └── src/
│       ├── api/           # axios client + api for each module
│       ├── store/         # Zustand (chat, auth, activeView)
│       ├── pages/
│       │   ├── DashboardPage.tsx
│       │   ├── LoginPage.tsx / RegisterPage.tsx
│       │   ├── SettingsPage.tsx      # Multi-section settings with side nav
│       │   ├── ToolsPage.tsx         # Custom tool CRUD (embeddable section)
│       │   ├── McpServersPage.tsx    # MCP server CRUD (embeddable section)
│       │   └── DataSourcesPage.tsx   # Data source CRUD (embeddable section)
│       └── components/    # Sidebar · ChatWindow · MessageBubble · FilePanel
├── executor/                       # Skill executor sidecar (Fastify, internal port 4000)
│   └── src/
│       ├── main.ts                 # Fastify API: POST /install, POST /execute, daemon endpoints
│       ├── install.ts              # pip + npm + nix install isolated per skill
│       ├── daemon-manager.ts       # Map<daemonId, ChildProcess>: start/stop/list/status
│       └── runners/
│           ├── python.runner.ts    # subprocess python3 + PYTHONPATH .deps/python
│           ├── node.runner.ts      # subprocess node + NODE_PATH .deps/node/node_modules
│           ├── js.runner.ts        # isolated-vm V8 sandbox (globals input, config)
│           └── broker.runner.ts    # D2: runs the skill as a container-job via broker
├── broker/                         # Job-launcher broker (D2) — the only one with the Docker socket
├── runner/                         # pa-runner image for the container-jobs (node+python3, uid 999)
├── egress-proxy/                   # squid.conf — egress allowlist (C1)
├── embedding-service/              # Embedding microservice (FastAPI) — internal model by default
├── whisper-service/                # Transcription microservice (FastAPI + faster-whisper) — internal Whisper by default
├── docker-compose.yml              # secure base (postgres·qdrant·redis·embedding·whisper·skill-executor·backend·frontend)
├── docker-compose.override.yml     # dev: re-exposes the host ports
├── docker-compose.egress.yml       # overlay C1: egress allowlist
├── docker-compose.broker.yml       # overlay D2: container-per-job
└── .env                            # SINGLE: Docker + non-Docker dev (backend reads it from ../.env)
```

---

## 5. Custom Tools

User-defined tools saved in PostgreSQL and built as LangChain `DynamicStructuredTool`s on every request.

### Executor types

| Type     | What it does                                                                                                                                | Status         |
|----------|---------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| `http`   | Calls an external REST endpoint. Supports `{{secret.KEY}}` and `{{env.VAR}}` in URL, headers, body                                           | ✅ Implemented  |
| `sql`    | Runs SELECT queries on an external DB (DataSource). Template mode `:param` or free Text-to-SQL                                               | ✅ Implemented  |
| `rag`    | Semantic search over a vector collection. Uses EmbeddingProviderService + VectorStoreAdapter                                                 | ✅ Implemented  |
| `prompt` | LLM sub-agent: interpolated custom system/user prompts, configurable model (LlmConfig) and maxTokens/temperature → separate LLM sub-call     | ✅ Implemented  |

### Template interpolation (HTTP executor)

- `{{paramName}}` → value passed by the LLM
- `{{secret.MY_KEY}}` → secret decrypted from the `tool_secrets` table
- `{{env.MY_VAR}}` → environment variable of the NestJS process

### SQL executor — two modes

**Mode A — Parameterized template:**

```sql
SELECT nome, email
FROM clienti
WHERE regione = :regione
```

The `:name` parameters are bound safely (no SQL injection).

**Mode B — Free query / Text-to-SQL:**

- The LLM fills the `queryParam` parameter with a free SELECT
- The tool validates that it is SELECT-only and adds LIMIT before executing
- If the parameter is missing, it returns the schema (table/column prefetch)

#### Schema injection — unified model

Two **orthogonal** axes govern what the LLM receives in Mode B:

- **Source (automatic):** if the DataSource has a curated **manifest** (`schemaManifest`, produced by *Introspect* + manual/AI curation), the schema comes from there, respecting hidden tables (`deny`) and fields (`hidden`); otherwise **live** from the DB.
- **Verbosity (per-tool, `schemaMode`):**
  - **compact** — 1st call: table list + relationships → the LLM chooses → 2nd call `describe_tables: [...]` (columns + comments + FKs of only the chosen tables) → query.
  - **full** — complete schema (all columns, inline FKs, "referenced by" relationships) up front.

`schemaHints` is no longer the schema: it is a channel for **free notes/instructions** injected as a `[Note]` block. The old live pre-fetch checkboxes converge into the compact/full selector. The **"Clear introspection"** button (`DELETE /api/data-sources/:id/manifest`) empties the manifest → back to live. Rendering: `renderManifestCompact` / `renderManifestFull` / `renderManifestColumns` in `datasources/schema-manifest.types.ts`.

### RAG executor

Two modes (`mode`): `search` (default) and `index`.

```typescript
interface RagExecutorConfig {
    mode?: 'search' | 'index';
    collection: string;       // Vector collection (must exist)
    // search:
    limit?: number;           // Chunks returned (default 5)
    searchScope?: 'auto' | 'universal' | 'all';  // visibility (default 'auto', optional)
    // index:
    indexScope?: 'universal' | 'project' | 'personal';  // scope of the indexed docs (optional; default from context)
    textParam?: string;       // tool param with the text to index (default 'text')
    fileIdParam?: string;     // tool param with fileId → native extraction (pdf/docx/xlsx/OCR), takes precedence
    metadataParams?: string[];// extra tool params saved in the vector payload
}
```

**Document scope & dynamic visibility.** The scope is a property of the **document** (chosen at embed time:
`universal | project | personal`), saved in the vector payload (`scope`, `userId`, `projectId`). The search filters
**dynamically based on the context** of the chat, without needing a per-project tool:

| `searchScope` | What it returns |
|---|---|
| `auto` (default) | the union of **universal ∪ the user's personal ∪ the current chat's project** |
| `universal` | only universal documents ("company knowledge base" tool) |
| `all` | the whole collection, no filter (cross-project / admin) |

The filter is **native on the vector DB**: since the adapters (Qdrant/PgVector/Chroma/AstraDB) only support AND-equality,
`auto` runs one query per scope (`{scope}`, `{scope,userId}`, `{scope,projectId}`) and unions them
(`mergeSearchHits`: dedup by id + re-rank by score + cut to `limit`) → no recall degradation. In `index`, the
scope of the new documents is `indexScope` or, if omitted, derived from the context (the chat's project if present,
otherwise personal). Manual embed (`POST /api/embed/:fileId`) requires the `scope` (UI: selector in FilePanel /
MessageInput / file manager).

### Prompt executor (sub-agent)

```typescript
interface PromptExecutorConfig {
    systemPrompt: string;        // interpolates {{param}}/{{secret.KEY}}/{{env.VAR}}
    userPromptTemplate?: string; // if omitted → args serialized as JSON
    llmConfigId?: string;        // LlmConfig to use (omitted = default)
    maxTokens?: number;          // default 1024 — override on the LlmConfig
    temperature?: number;        // default 0 (deterministic)
}
```

`buildPromptContext.callLlm` resolves the LlmConfig, builds the model with
`buildModelForConfig(entity, { maxTokens, temperature })` and invokes system+user; the response comes back as a tool result to the
main agent.

### Scope (`personal | team | org`)

- `personal` — visible/usable only by the creator
- `team` — visible/usable by the members of the `teamId` team; managed by **admin or team owner**; name unique per-team
- `org` — visible/usable by the whole organization; management reserved for **admins**; globally unique name

Management authorization (create/update/delete) centralized in the controller (`assertCanManage`): personal=owner,
org=admin, team=admin-or-owner. The service uses per-id lookup (ownership is no longer a service constraint). Same
model on **custom tools, skills, data sources**.

### Loading logic for the agent

```
loadToolsForUser(userId, projectId?):
  teamIds = teamIdsForUser(userId)
  candidates = visibilityWhere: { userId } ∪ { scope:'org' } ∪ { scope:'team', teamId ∈ teamIds }
  dedup by name with precedence personal > team > org
  → buildDynamicTool(..., projectId) for each (secrets decrypted, DataSource resolved)
    # projectId (= the chat's project) feeds the dynamic RAG 'auto' filter
```

> Visibility (and tools loaded by the agent) is **membership-based even for admins**: an admin who is not a member of a team does
> not see those resources in the list, but manages them by id / from the Teams UI.

### Hierarchical delegation — `exposeAsTool` + `loadOnFirst`

Two **orthogonal** axes that let you avoid injecting all the tools into the chat's first context and encapsulate them behind agents (the *agent-as-tool* pattern).

**`exposeAsTool`** (on agent / team — Flows already had it as *chat-as-tool*): if active, the resource is wrapped in a `DynamicStructuredTool` and exposed alongside the other tools. The main model sees it as `agent_<slug>` / `team_<slug>` and **delegates** a task to it; the agent's internal tools do NOT enter the caller's context. Implemented in `MultiAgentService.loadToolsForUser` → `buildAgentTool` / `buildTeamTool`, hooked into `AgentService.resolveAgent`.

**`loadOnFirst`** (on custom tool / flow / skill / mcp server, default `true`): decides whether that tool enters the chat's *flat* context. At `false` it disappears from the chat but remains usable by an agent that includes it in its `toolFilter`.

The two combine via the loaders' **`flatOnly`** parameter:

```
loadToolsForUser(userId, projectId, { flatOnly: true })   # main chat
  → WHERE ... AND loadOnFirst = true        # only the flat-context tools

loadToolsForUser(userId, projectId)                        # per-agent path
  → no filter on loadOnFirst                # the agent sees ALL its tools
```

> `loadOnFirst` = the tool's configuration ("do I want to be in the chat?"); `flatOnly` = the caller's intent ("do I only need the flat tools?"). The loader does the matching. This way a `loadOnFirst=false` tool is invisible in the chat but the agent that encapsulates it loads it anyway → fewer tokens in the first context, a clean perimeter, more reliable routing.

Regression: `backend/test/integration/load-on-first.integration.spec.ts` (testcontainers).

---

## 6. Data Sources

External data sources configured once and reused by multiple SQL tools.

```typescript
interface DataSourceEntity {
    id: string;
    name: string;
    description: string | null;
    encryptedConnectionString: string; // AES-256-CBC, never exposed in the API
    schemaHints: string | null;        // Free notes/instructions about the DB → injected as a [Note] block (NOT the schema)
    prefetchRelations: boolean;        // Auto-detects declared FKs (KEY_COLUMN_USAGE) during Introspect / live
    schemaManifest: SchemaManifest | null; // Curated schema (Introspect + AI + edit): tables/columns/comments/relationships
    scope: 'personal' | 'team' | 'org';
    teamId: string | null;             // set only if scope='team'
}
```

**Enriched schema (`schemaManifest`)** — the source of truth for the schema when present:
- `Introspect` (`POST :id/introspect`) → draft from the live DB (comments + declared FKs), non-destructive merge
- `Generate with AI` (`POST :id/enrich`) → the summarizer model fills the empty comments + infers implicit relationships
- The user curates: relationships, tables (`deny` = hidden + blocked in the SQL guard, `comment`), **fields** (`deny` per column = same behavior: hidden + blocked in the best-effort guard — explicit reference + rejection of `SELECT *`/`tab.*`; for real secrets → DB restriction — plus `comment`)
- `Clear introspection` (`DELETE :id/manifest`) → empties the manifest → the SQL tools revert to the **live** schema

**Multi-engine (engine → family):** every DataSource has an explicit `engine` field (no
longer inferred from the connection string), belonging to a **family** (`relational` |
`document` | `keyvalue` | `fileshare`) — see `datasources/engine.types.ts`. The DataSource layer (CRUD,
encryption, **Test connection**: `POST /data-sources/test` and `:id/test`, introspection,
editable manifest with `deny`) is unified; the querying layer diverges per family.

- **relational** (`SqlDriver`, `datasources/drivers/`): postgres, mysql, mariadb, mssql,
  oracle, sqlite. `sql` tool (text-to-SQL / template). Adding a DBMS = one driver file.
- **document** (`datasources/mongo/`): mongodb. `mongo` tool (find/aggregate, template or
  free-query JSON). Sampling-based introspection → collection/field manifest.
- **keyvalue** (`datasources/redis/`): redis. `redis` tool (whitelisted commands, template or
  free-command). Sampling-based keyspace introspection → key-pattern manifest.
- **fileshare** (`datasources/fileshare/`): smb/sftp/webdav. No schema; file operations
  `list/read/write/delete` via the `file` spec on the internal datasource endpoint (`file`
  field), used by the `file-share` skill. Path-traversal guard + 10MB read cap.

The NoSQL tools are read-only by default (write opt-in with confirm). The heavy drivers
(`mssql`, `oracledb`, `better-sqlite3`, `mongodb`, `ioredis`, and `@marsaud/smb2`,
`ssh2-sftp-client`, `webdav` for the file-shares) are lazy-loaded: if the module is not
installed, the engine gives a clear error without bringing down the app.

**Connection string formats per engine:** `postgresql://…` · `mysql://…` · `mariadb://…` ·
`mssql://…` (or `Server=…;Database=…`) · `oracle://host:1521/service` · `sqlite:///path.db` ·
`mongodb://host:27017/db` · `redis://:password@host:6379/0` · `smb://[DOM;]user:pass@host/share[/dir]` ·
`sftp://user:pass@host:22[/dir]` · `webdavs://user:pass@host[/dir]`.

---

## 7. MCP Servers

MCP servers configured by the user, converted into LangChain `DynamicStructuredTool`s.

### Transport types

| Transport | Who spawns the process                             | When to use it                                 |
|-----------|----------------------------------------------------|------------------------------------------------|
| `http`    | — (remote server already listening)                | Remote MCP server reachable over HTTP          |
| `sse`     | — (remote server already listening)                | Like http but with an SSE response             |
| `local`   | **NestJS backend** (directly, `child_process`)     | Backend and program on the **same machine**    |
| `remote`  | **Electron Bridge** (on the user's machine)        | Backend and program on **different machines**  |

### `local` transport flow (direct)

```
NestJS McpServersService
  └─ LocalMcpProcess (child_process.spawn)
       ├─ stdin/stdout JSON-RPC
       ├─ initialize → tools/list → cache tools
       ├─ auto-restart on crash (backoff 5s)
       └─ callTool(name, args) → string result
```

### `remote` transport flow (Electron bridge)

```
1. Electron Bridge opens Socket.io to /mcp-bridge (JWT auth)
2. Backend sends config: { servers: [{ id, name, command, args, env }] }
3. Bridge spawns the process (npx, python, etc.) → JSON-RPC stdio
4. Bridge runs initialize + tools/list → sends tools:register to the backend
5. McpBridgeGateway updates bridgeTools[userId][serverId]
6. When the agent calls a tool:
   backend → tool:call (WebSocket) → bridge → JSON-RPC stdio → bridge → tool:result → backend
```

### Tool naming

`mcp_{server_name_snake}_{tool_name}` — e.g. `mcp_filesystem_read_file`

---

## 8. ReAct Agent (`agent.service.ts`)

```typescript
// At boot: no built-in tools (recommend/completeness/pdf-gen removed)
onModuleInit()
{
    builtInTools = []
    // RAG → custom tool type 'rag' | SQL → custom tool type 'sql' | PDF/other → skill
}

// Per request: resolve agent in two phases
resolveAgent(userId, projectId, userInput, history, chatId)
:

// ── Phase 1 (parallel) ─────────────────────────────────────────────────────
[basePrompt, model, customTools, mcpTools, skillTools,
    user, project, globalToolConfig, provider] = await Promise.all([...])

effectiveConfig = {
    strategy: user?.toolLoadingStrategy ?? globalToolConfig.toolLoadingStrategy,
    maxTools: user?.toolLoadingMaxTools ?? globalToolConfig.toolLoadingMaxTools,
    schemaFormat: user?.toolSchemaFormat ?? globalToolConfig.toolSchemaFormat,
}
effectiveMaxHistoryTokens = user?.maxHistoryTokens ?? globalToolConfig.maxHistoryTokens

// ── History compaction (rolling summary persisted on the Chat) ─────────────
// No-op if the toggle is off or without chatId. Above the threshold: summarizes the old turns.
{
    summary, effectiveHistory
}
= await compactHistory(chatId, history, effectiveMaxHistoryTokens,
    historyCompactionEnabled, historyCompactionThreshold)

// ── Phase 2 (serial) ───────────────────────────────────────────────────────
// 2a. ToolSelectionService: semantic / keyword / inject-all selection
optimizedExtraTools = await toolSelection.applyStrategy(allExtraManifests, userInput, effectiveConfig)

// 2b. Selective SKILL.md: only for the skills with selected tools
selectedToolNames = new Set(optimizedExtraTools.map(t => t.name))
skillsPrompt = await skillsService.buildSkillSystemPromptSelective(userId, projectId, selectedToolNames)

// ── 4-level system prompt (+ cross-provider summary block) ─────────────────
systemPrompt = buildSystemPrompt(basePrompt, user.systemPrompt, project.systemPrompt, skillsPrompt)
// summary (if present) added as a separate block and NOT cached

// ── Prompt caching per provider ────────────────────────────────────────────
messageModifier = (provider === 'anthropic')
    ? new SystemMessage({
        content: [{type: 'text', text: systemPrompt, cache_control: {type: 'ephemeral'}},
            ...(summary ? [{type: 'text', text: summaryBlock}] : [])]
    })
    : (summary ? `${systemPrompt}\n\n${summaryBlock}` : systemPrompt)

return {
    agent: createReactAgent({llm: model, tools: optimizedExtraTools, messageModifier}),
    model, provider, effectiveHistory, effectiveMaxHistoryTokens
}
```

**4-level system prompt** (the most specific goes last):

1. `basePrompt` — global identity (from DB `app_config`, editable by admin without redeploy)
2. `user.systemPrompt` — user preferences (e.g. "answer me concisely").
   At the same level (cached) the **persistent user memory** block is added (confirmed `user_memory` facts),
   if `autoMemoryEnabled`
3. `project.systemPrompt` — project-specific context (e.g. "client Acme, budget €180k")
4. `skillsPrompt` — metadata and SKILL.md of the selected skills (selective loading)

**Tool Loading Strategy** (`ToolSelectionService`):

Two orthogonal axes — *which* tools to load (`toolLoadingStrategy`) and *how* to describe them (`toolSchemaFormat`):

- `strategy`:
  - `top_k_rag` — selects the `maxTools` most relevant tools by semantic similarity (query↔tool embedding)
  - `always_inject_all` — all tools always; SKILL.md always complete
  - `auto` — `always_inject_all` if n_tools ≤ `maxTools`, otherwise `top_k_rag`
- `schemaFormat`:
  - `full` — complete tool schema + SKILL.md pre-loaded into the system prompt
  - `compressed` — trimmed tool schema (~-25%)
  - `deferred` — minimal tool descriptions and **SKILL.md NOT pre-loaded**: served on-demand via `get_tool_instructions`
- Per-user override via `user.toolLoadingStrategy`, `user.toolLoadingMaxTools`, `user.toolSchemaFormat` (fallback on global `app_config`)
- `top_k_rag` uses an **in-memory cache of tool vectors** (`embedCache`, key = name+description+schema): it re-embeds only the new/modified tools or after `invalidateEmbeddingCache()`; at steady state it pays **only the query embedding** (1 batch call). Cache lost on process restart (not persisted)

**Token cost — mental model and empirical results** (internal benchmark, real multi-tool agentic request):

- The cost of a turn is dominated by the **fixed context re-sent on EVERY ReAct iteration** (system + tool definitions + pre-loaded SKILL.md), multiplied by the number of iterations. History grows but is secondary.
- **Prompt caching serves the stable prefix at ~0.1×**: the real "full" cost is much lower than the raw input. ⚠️ `cacheReadTokens` is a **subset** of `inputTokens`, not an addend — the full-price consumption is `inputTokens − cacheReadTokens`.
- **Dominant lever = the tool loading strategy.** Measured: switching from `always_inject_all/full` to `top_k_rag(+deferred)` reduces the fixed context/call from **~28K to ~3-6K tokens (-80%)** and **~halves** the effective turn cost, at equal results.
  - `top_k_rag` cuts the number of tools (and therefore loaded schemas + SKILL.md) → it's the bulk of the savings.
  - `deferred` almost zeroes the fixed skill cost (SKILL.md out of the prompt).
  - `compressed` is a **minor** lever (only tool schemas).
- **`top_k_rag` risk**: semantic selection can discard a needed tool if its description does not resemble the request → curate the tool descriptions, keep `maxTools` adequate, or use `auto`.
- **Anti-pattern**: do not optimize "by gut" by mutating/truncating old messages **in the middle** of the history within the loop — it breaks the cached prefix (counterproductive). Reductions should be done **before** the loop (tool selection) or on the stable prefix, not mid-way.

**Max History Tokens & trimming** (`buildMessages` → `trimMessages` from @langchain/core):

- Token budget for the history; default 30,000 tok global, per-user override via `user.maxHistoryTokens`
- **The budget is ALWAYS applied**, regardless of the compaction toggle: the trim is the final safety net
  and silently drops the oldest turns until the history fits. Compaction OFF ≠ "pass everything":
  it just means the overflow is lost instead of summarized
- Counting happens on the **expanded** history: the persisted tool-calls (`Message.toolCalls`) are replayed
  as `AIMessage(tool_calls) → ToolMessage×N → AIMessage(text)`, with each output truncated to
  `REPLAY_TOOL_OUTPUT_MAX_CHARS` (env, default 3,000 chars) — without a cap a single turn with SQL/schema output
  could on its own exceed the budget and cause the whole history to be flushed (`allowPartial:false` does not split the turns)
- `trimMessages`: strategy `last`, `startOn:'human'` (no orphan AIMessage), does not split human/AI pairs
- tokenCounter is **provider-aware**: the model (tiktoken) for openai/openai-compatible/deepseek/lmstudio; estimate ~4
  chars/token for anthropic/gemini/ollama (`AgentService.TIKTOKEN_PROVIDERS`)

**History Compaction** (`compactHistory`/`summarize`, rolling summary persisted on the Chat):

- Global toggle `historyCompactionEnabled` (default ON; OFF → only trimming, overflow discarded). Also a no-op
  without `chatId`
- State on the `Chat`: `summary`, `summaryUpToMessageId`, `summaryTokens`
- Above `historyCompactionThreshold`% of the budget (default 80%): keeps ~50% of the threshold verbatim, summarizes the
  rest with the **summarizer model** (`isSummarizer` ?? default). Summarization error → fallback to trimming only
- The weight estimate counts `content + JSON.stringify(toolCalls)` — the same measure as the downstream trim: the two
  stages MUST see the same weight, otherwise compaction does not trigger and the trim cuts in its place
- The summary goes into the **system prompt** (the only cross-provider location), a separate and non-cached block

**Agent step limit:** env `AGENT_RECURSION_LIMIT` (default 50 ≈ 25 LLM↔tool rounds, minimum 10) passed to
`agent.stream()` and `agent.invoke()`; the LangGraph default (25 ≈ 12 rounds) was insufficient for long DB
explorations and produced `GraphRecursionError`. Full flow with diagrams and threshold table: **`DATAFLOW_AGENT.md`**.

**Feedback loop / active memory** (`FeedbackService`, module `feedback/`):

- Global toggle `feedbackMemoryEnabled` (default OFF). On activation (admin PATCH) it creates the collection
  `feedback_memory`
- The user votes 👍/👎 on an assistant message and can add a **correction** (comment) → `message_feedback` (unique
  `messageId`+`userId`)
- Feedback **with a comment** is embedded on the **question** and saved in `feedback_memory` with payload
  `{ feedbackId, userId, scope, approved, rating, question, answer, comment }`
- **Scope** `personal` (only the author) | `shared` (everyone, but only after the admin's `isApproved`)
- In `resolveAgent` (if the toggle is ON): semantic search = **two queries** unioned (`{userId, scope:personal}` +
  `{scope:shared, approved:true}`, the adapter filters by equality), dedup by `feedbackId`, score threshold 0.35 →
  a "Corrections from past feedback" block injected into the system prompt as a **separate and non-cached block** (like the
  summary)
- Best-effort: embedding/search errors do not block the chat

**Persistent user memory / auto-memory** (`UserMemoryService`, module `user-memory/`):

- Opt-in **per-user**: toggle `User.autoMemoryEnabled` (default OFF) enabled from Settings→Profile
- Table `user_memory`: one row = one durable fact about the user, state `pending` (proposed) → `confirmed` (active),
  with `sourceChatId`
- **Threshold extraction** (not per-message): at the end of a turn, if ≥ threshold new messages have accumulated since the last
  extraction (marker `Chat.memoryUpToMessageId`, twin of `summaryUpToMessageId`), the **summarizer model** (
  `getSummarizerModel`, cross-provider, single `invoke`) extracts facts as a JSON array; dedup against the existing
  memory → saved as `pending`. Threshold = `User.memoryThreshold` (override) ?? `app_config.autoMemoryThreshold` (
  global default 6)
- **On-demand extraction**: "Update memory" button in the chat → `POST /api/user-memory/extract`
- **Inline confirmation**: proposals arrive in the chat via the SSE `memory_proposal` event; the user confirms/ignores each
  fact (card in `ChatWindow`). The rejected ones are deleted
- **Injection**: the `confirmed` facts enter the system prompt as a "what I know about the user" block at the **user
  level**, inside the **cached** prefix (stable → they only change on confirmation/edit) — unlike feedback/summary which
  are non-cached
- Pruning at `MAX_FACTS_PER_USER` (50). Management panel (edit/delete) in Settings→Profile. Best-effort:
  extraction errors do not block the chat

**Token usage dashboard** (`UsageService`, module `usage/`):

- Every assistant message records `provider`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheWriteTokens` (captured in `streamResponse`) → cost attribution to the correct model even if the default
  changes over time
- SQL aggregation (messages → chats → users/projects) group by user/project/provider/model; roll-up and costs computed
  in JS
- **Provider-aware cost** (`usage/pricing.ts`): the semantics of `input_tokens` differ (Anthropic reports it net
  of the cache; OpenAI/Gemini/DeepSeek include it → cache-reads are subtracted). Cache multipliers per
  provider (Anthropic read ×0.10/write ×1.25, OpenAI ×0.50, Gemini ×0.25, DeepSeek ×0.10). Base prices ($/1M in/out) on
  `llm_configs.inputPricePerM`/`outputPricePerM` (admin); missing price → cost "n/a"
- **Permissions**: admin sees tokens + costs for everyone, per user/project/model (`GET /api/usage`); the user sees only
  their own tokens, without costs (`GET /api/usage/me`). Time filter `from/to`
- UI: "Usage" section in Settings with interval presets, total cards and per-user/project/model tables

**LLM multi-config / multi-provider** (`LlmProviderService` + `LlmConfigsService`):

- Configs saved in `llm_configs` (multi-record): `isDefault` (agent) + `isSummarizer` (compaction) + `isVision` (multimodal tasks, e.g. image OCR — fallback to default)
- Provider: `anthropic | openai | gemini | ollama | lmstudio | openai-compatible | deepseek`
- `buildModelForConfig(entity, { maxTokens?, temperature? })`: per-call override (used by the Prompt executor)
- In-memory cache of the default model: invalidated after every config change
- DeepSeek: SSE interceptor injects `reasoning_content` and logs cache hits (`prompt_cache_hit_tokens`)

**Prompt Caching**:

- Anthropic: explicit with `cache_control: { type: 'ephemeral' }` on the SystemMessage → TTL 5 min, ~90% savings
- OpenAI / Gemini: automatic on the stable prefix → logged via `usage_metadata.input_token_details.cache_read`
- DeepSeek: automatic → logged in the SSE `fetch` interceptor

**Streaming:** LangGraph `streamMode: 'messages'` — handles both Anthropic (content blocks `tool_use`) and
OpenAI-compatible (`message.tool_calls`). Logs tokens per step + cache read/write totals.

**`onToolResult` callback** (optional, added to `streamResponse`):

```typescript
onToolResult ? : (toolName: string, result: any) => void
```

Invoked on every `ToolMessage` (a tool's result), before the `continue`. It lets the caller inspect the
result without modifying the agent's flow.

**SSE — events emitted by the `/api/chats/:id/messages/stream` channel:**

| `type`        | Payload                             | When                                          |
|---------------|-------------------------------------|-----------------------------------------------|
| `chunk`       | `{ chunk: string }`                 | LLM text token                                |
| `tool_call`   | `{ toolCall: {...} }`               | The LLM invoked a tool                        |
| `tool_result` | `{ name: string, ok: boolean }`     | A tool returned a result (✓/✗ live)           |
| `file`        | `{ name: string, rel: string }` | A tool produced a file on disk; `rel` = path for the access-aware `?rel=` download (`trackOutput` → `canAccess`) |
| `usage`       | `{ inputTokens, outputTokens }`     | End of generation                             |
| `done`        | —                                   | Stream completed                              |

`messages.controller.ts` passes an `onToolResult` that recursively scans each JSON result: every string with a `/` that
resolves to an existing file inside `UPLOAD_DIR` generates a `file` event. HTTP URLs and `/api/…` paths are ignored.

---

## 9. Vector DB (provider-agnostic)

```
VectorStoreProviderService
  └── VectorStoreAdapter (interface)
       ├── QdrantAdapter      (default, self-hosted)
       ├── PGVectorAdapter    (PostgreSQL with pgvector extension)
       ├── ChromaAdapter      (Chroma server)
       └── AstraDBAdapter     (DataStax AstraDB cloud)
```

Configured from the admin UI in "Settings → Vector DB" (singleton table `vector_db_config`, id=1).
The parameters vary per provider: URL, connection string, encrypted API key, extra JSON config.

### Auto-configured internal services (embedding & whisper)

Both **embedding** and **transcription** have a special **`internal`** provider (default on a new installation) that points to the microservices included in the app (`embedding-service`, `whisper-service`), without the admin configuring anything:

- **URL from the deployment, not from the DB**: resolved from env (`EMBEDDING_BASE_URL` / `TRANSCRIPTION_BASE_URL`, set in docker-compose; default `localhost:8000`/`:9000` in dev). Moving/renaming the service does not require reconfiguration.
- **Auto-detected model and dimensions**: the backend probes `GET {baseUrl}/v1/models` of the service (best-effort, 3s timeout, fallback to saved values). For embedding, the detected `dims` avoid mismatches with the Qdrant collections.
- **UI**: an "Internal (default)" option as the first entry of the provider selector; it hides URL/model/key and shows an info box. The "Test" button verifies the service and shows its detected model/dimensions.
- **Override**: a user who wants their own provider (OpenAI/Groq/Ollama/LM Studio/self-hosted) picks another entry and configures it as usual.
- **Dev**: both services start manually for testing — `./embedding-service/start.sh`, `./whisper-service/start.sh` (or `docker compose up embedding whisper`).

Migration `InternalServicesDefault1784500000062`: brings the defaults to `internal` and migrates the singleton row if still intact.

---

## 10. DB Schema

```
users
  ├── role (varchar, default 'user')       ← admin | user (1st registered = admin)
  ├── status (varchar, default 'active')   ← active | disabled (login blocked if disabled)
  ├── systemPrompt (text, nullable)        ← user's personalized instructions
  ├── toolLoadingStrategy (nullable)       ← per-user override (null = use global)
  ├── toolLoadingMaxTools (nullable)
  ├── toolSchemaFormat (nullable)
  ├── maxHistoryTokens (integer, nullable) ← per-user history budget (null = use global)
  ├── autoMemoryEnabled (boolean, default false)  ← persistent user memory (opt-in)
  ├── memoryThreshold (integer, nullable)  ← extraction threshold override (null = use global)
  ├── user_memory              (content, status pending|confirmed, sourceChatId)  ← durable facts about the user
  ├── projects   # userId = OWNER (nullable, ON DELETE SET NULL → the team project survives the owner's deletion)
  │     ├── systemPrompt (text, nullable)  ← project-specific context
  │     ├── project_teams (projectId, teamId FK→teams, role collaborator|viewer; unique (projectId,teamId))
  │     │     # multi-team sharing of the project; ON DELETE CASCADE on projects and teams
  │     ├── chats   # visible to all project members; threads writable by collaborator/owner
  │     │     ├── summary (text, nullable)            ← rolling summary (history compaction)
  │     │     ├── summaryUpToMessageId (uuid, null)   ← last msg incorporated in the summary
  │     │     ├── summaryTokens (int, nullable)       ← estimated token count of the summary
  │     │     ├── memoryUpToMessageId (uuid, null)    ← last msg analyzed for memory extraction
  │     │     └── messages
  │     │           ├── authorId (uuid, null, FK→users SET NULL)  ← author of the user turn (shared threads)
  │     │           ├── inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens  ← usage (dashboard)
  │     │           ├── provider/model (varchar, null)   ← who generated the msg, to attribute the cost
  │     │           └── message_feedback   (rating up|down, comment, question, answer, scope, isApproved, vectorId)
  │     └── files   # visible to all members; upload = collaborator/owner
  ├── custom_tools              (scope personal|team|org + teamId FK→teams)
  │     └── tool_secrets        (keyName + encryptedValue AES)
  ├── mcp_servers
  │     └── mcp_server_secrets
  └── data_sources              (encrypted connection string + schemaHints; scope personal|team|org + teamId)

teams
  └── team_memberships          (userId, teamId, role owner|member; unique (teamId,userId))
       # scope='team' of resources → teamId; membership-based visibility; ON DELETE SET NULL on teams

app_config (singleton, id=1)
  ├── systemPrompt              ← base prompt editable by admin (seed from SYSTEM_PROMPT)
  │   # ⚠️ fields llmProvider/llmModel/llmApiKey/llmBaseUrl/llmMaxTokens STILL present but LEGACY:
  │   #    the agent uses llm_configs (default). The app-config/llm endpoint is no longer the source of truth.
  ├── embeddingProvider / embeddingModel / embeddingApiKey (encrypted) / embeddingBaseUrl /
  │   embeddingVectorSize / embeddingQueryPrefix / embeddingChunkSize / embeddingChunkOverlap
  ├── toolLoadingStrategy (top_k_rag|always_inject_all|auto)  ← global default
  ├── toolLoadingMaxTools (integer)   ← max tools injected per request
  ├── toolSchemaFormat (full|compressed|deferred)
  ├── maxHistoryTokens (integer, default 6000)  ← global history budget
  ├── historyCompactionEnabled (boolean, default false)  ← summarize instead of discarding
  ├── historyCompactionThreshold (int, default 80)       ← % budget above which it triggers (50–95)
  ├── feedbackMemoryEnabled (boolean, default false)     ← active memory from feedback (feedback_memory collection)
  └── autoMemoryThreshold (int, default 6)               ← global default for the user memory extraction threshold (n. messages)

llm_configs (multi-record)
  ├── name / provider / model / apiKey (encrypted) / baseUrl / maxTokens
  ├── inputPricePerM / outputPricePerM (numeric, null)  ← price $/1M for cost estimation (usage dashboard)
  ├── isDefault (boolean)       ← config used by the agent (only one)
  └── isSummarizer (boolean)    ← config for compaction summaries (only one; fallback to default)

vector_db_config (singleton, id=1)
  ├── provider (qdrant|pgvector|chroma|astradb)
  ├── url / connectionString / apiKey (encrypted) / extraConfig (jsonb)
  └── vector_collections        (created/managed collections)
```

```
users → skills
  ├── skill_scripts (language, mode: oneshot|daemon)
  ├── skill_configs (config vars, secret flag, AES encrypted)
  └── skill_project_assignments (M:N skills ↔ projects)

skills
  ├── enabled (boolean, default true)  ← enable toggle from the UI
  ├── scope (personal|team|org) + teamId (FK→teams) + isApproved (boolean)
  │     # team = direct publication by the team owner (no review); org = admin review (isApproved)
  └── status (installing|ready|error)

skill_daemons
  ├── skillId, scriptFilename, userId
  ├── daemonId (executor UUID)
  ├── status (starting|running|stopped|error)
  └── lastEventAt

notifications
  ├── userId, skillId, daemonId
  ├── eventType, payload (jsonb)
  └── readAt
```

**TypeORM migrations** (~52 sequential files in `backend/src/database/migrations/`, `migrationsRun: true` → applied at
boot):
`InitialSchema → CustomTools → CustomToolScope → McpServers → McpRemoteTransport → DataSources → SystemPrompts → AppConfig → LlmConfig → VectorDb → EmbeddingConfig → VectorDbProvider → AddRagExecutorType → Skills → AddNodeLanguage → SkillConfigVars → AddScriptMode → CreateSkillDaemons → CreateNotifications → AddNixDeps → ToolLoadingConfig → TokenCount → HistoryTokenLimit → DeferredAsStrategy → SkillEnabled → SkillScriptLlmCallable → SkillScriptContextNote → SkillScriptLastInfoOutput → SkillSourceId → LlmConfigs → HistoryCompaction → HistoryCompactionThreshold → MessageFeedback → UserMemory → TokenUsage → UserStatus → Teams → CustomToolScopeTeam → CustomToolScopeIndexes → SkillScopeTeam → DataSourceScopeTeam → ProjectTeams → MessageAuthor → **CreateFlows → CreateAgents → ChatAgentTeam → CreateScheduledTasks → ScheduledTaskTokens → ScheduledTaskToolsCost → ScheduledTaskChatDelivery → FlowChatDelivery (+ Fix)**`

> **RAG & document scope**: the scope (`universal|project|personal`) is not a table but lives in the **vector
> payload** (`scope`, `userId`, `projectId`) alongside the chunk text — see §5 RAG Executor.

---

## 11. Exposed API

```
# Auth
POST   /api/auth/register        ← the FIRST registered user becomes admin (bootstrap); login blocked if status='disabled'
POST   /api/auth/login

# User profile
GET    /api/users/me
PATCH  /api/users/me             ← includes user systemPrompt, autoMemoryEnabled, memoryThreshold
POST   /api/users/me/change-password

# User management (admin)
GET    /api/admin/users          ← paginated list + filters (search, role, status)
POST   /api/admin/users          ← create user
PATCH  /api/admin/users/:id      ← name/email
PATCH  /api/admin/users/:id/role          ← admin|user (no demote of the last admin)
PATCH  /api/admin/users/:id/status        ← active|disabled
POST   /api/admin/users/:id/reset-password
DELETE /api/admin/users/:id

# Teams (admin write; /mine for each user)
GET    /api/teams/mine           ← teams of the current user (scope selectors)
GET    /api/teams                ← list with memberCount (admin)
POST   /api/teams                ← create team (admin)
PATCH  /api/teams/:id            ← update (admin)
DELETE /api/teams/:id            ← delete (admin)
GET    /api/teams/:id/members
POST   /api/teams/:id/members            ← add member { userId, role }
PATCH  /api/teams/:id/members/:userId    ← owner|member (no demote of the last owner)
DELETE /api/teams/:id/members/:userId

# Projects (team management: project owner or admin)
GET    /api/projects                ← own (owner) + shared with own teams
POST   /api/projects
PUT    /api/projects/:id            ← includes project systemPrompt
DELETE /api/projects/:id            ← chats/files NOT deleted (projectId→null); team assignment CASCADE
GET    /api/projects/:id/teams                  ← assigned teams (members read-only)
POST   /api/projects/:id/teams                  ← assign team { teamId, role: collaborator|viewer }
PATCH  /api/projects/:id/teams/:teamId          ← change the team's role
DELETE /api/projects/:id/teams/:teamId          ← remove the team

# Chat + streaming
GET    /api/chats?projectId=        ← with projectId: chats of ALL project members (authorId/authorName)
POST   /api/chats                   ← in a project: requires write (collaborator/owner); viewer no
GET    /api/chats/:id               ← includes canWrite for the current user
GET    /api/chats/:id/messages      ← readable by author or project member
POST   /api/chats/:id/messages/stream   ← SSE; write for author or project collaborator/owner

# Files + RAG
POST   /api/files/upload?projectId=     ← in a project requires write (collaborator/owner)
GET    /api/files?projectId=            ← project files (all members) | ?chatId= | own
GET    /api/files/:id/download          ← downloadable by owner or project member
GET    /api/files/raw?rel=<path>        ← authenticated download (UPLOAD_DIR whitelist)
POST   /api/embed/:fileId               ← body { scope: universal|project|personal, collection?, projectId? }
DELETE /api/embed/:fileId
GET    /api/embed/collections

# Custom Tools
GET    /api/custom-tools
POST   /api/custom-tools
GET    /api/custom-tools/:id
PATCH  /api/custom-tools/:id
DELETE /api/custom-tools/:id
POST   /api/custom-tools/:id/test
GET    /api/custom-tools/:id/secrets
POST   /api/custom-tools/:id/secrets
DELETE /api/custom-tools/:id/secrets/:key

# Data Sources
GET    /api/data-sources
POST   /api/data-sources
GET    /api/data-sources/:id
PATCH  /api/data-sources/:id
DELETE /api/data-sources/:id
POST   /api/data-sources/:id/test     ← connection test

# MCP Servers
GET    /api/mcp-servers
POST   /api/mcp-servers
GET    /api/mcp-servers/:id
PATCH  /api/mcp-servers/:id
DELETE /api/mcp-servers/:id
GET    /api/mcp-servers/:id/secrets
POST   /api/mcp-servers/:id/secrets
DELETE /api/mcp-servers/:id/secrets/:key

# App configuration (admin only)
GET    /api/app-config
PATCH  /api/app-config                    ← base system prompt
GET    /api/app-config/tool-loading
PATCH  /api/app-config/tool-loading       ← tool strategy + maxHistoryTokens + history compaction
GET    /api/app-config/embedding
PATCH  /api/app-config/embedding
POST   /api/app-config/embedding/test
GET    /api/app-config/llm                ← ⚠️ legacy (app_config.llm* fields, no longer the source of truth)
PATCH  /api/app-config/llm                ← ⚠️ legacy
POST   /api/app-config/llm/test           ← ⚠️ legacy

# LLM Configs — multi-record (admin only) — source of truth for the agent
GET    /api/llm-configs
POST   /api/llm-configs
PATCH  /api/llm-configs/:id
DELETE /api/llm-configs/:id
POST   /api/llm-configs/:id/set-default
POST   /api/llm-configs/:id/set-summarizer
POST   /api/llm-configs/clear-summarizer
POST   /api/llm-configs/:id/set-vision        ← designates the model for vision/OCR tasks
POST   /api/llm-configs/clear-vision
POST   /api/llm-configs/clear-summarizer
POST   /api/llm-configs/:id/test

# Vector DB (admin only)
GET    /api/vector-db/config
PATCH  /api/vector-db/config
GET    /api/vector-db/collections
POST   /api/vector-db/collections
DELETE /api/vector-db/collections/:name

# Skills
POST   /api/skills/upload                    ← upload ZIP
GET    /api/skills
GET    /api/skills/:id
PATCH  /api/skills/:id
DELETE /api/skills/:id
PATCH  /api/skills/:id/enabled               ← { enabled: bool } — owner or admin
POST   /api/skills/:id/reinstall
POST   /api/skills/:id/assign                ← assign to a project
POST   /api/skills/:id/install               ← install a copy from the internal marketplace
GET    /api/skills/registry                  ← GitHub registry index (cached)
POST   /api/skills/registry/install          ← { downloadUrl } — download ZIP from GitHub
POST   /api/skills/registry/refresh          ← [admin] invalidate the registry cache
POST   /api/skills/:id/propose-compilation   ← [owner] the AI proposes an input_schema (descriptive→typed)
POST   /api/skills/:id/compile               ← [owner] { scripts } applies → kind=typed

# Sandbox (arbitrary code/shell execution, tool run_in_sandbox)
GET    /api/admin/config/sandbox             ← [admin] gating (enabled, team/project allowlist, network)
PATCH  /api/admin/config/sandbox             ← [admin] update gating
GET    /api/sandbox/file?chatId=&path=       ← download a file from the chat's workspace (scoped)

# Daemons
GET    /api/daemons
POST   /api/daemons                          ← { skillId, scriptFilename } — start
GET    /api/daemons/:id
POST   /api/daemons/:id/restart
DELETE /api/daemons/:id                      ← stop (status=stopped)
DELETE /api/daemons/:id/record               ← delete DB record

# Feedback loop
GET    /api/feedback/config                  ← { enabled, vectorAvailable } (everyone)
PATCH  /api/feedback/config                  ← { enabled } [admin] — on enable creates the feedback_memory collection
POST   /api/feedback                         ← { messageId, rating, comment?, scope? } — upsert (unique messageId+userId)
GET    /api/feedback/chat/:chatId            ← my feedback for a chat (UI state)
GET    /api/feedback                         ← dashboard (admin: all, user: only their own)
PATCH  /api/feedback/:id/approve             ← { approved } [admin] — approve shared feedback
PATCH  /api/feedback/:id/scope               ← { scope } — owner or admin
DELETE /api/feedback/:id                     ← owner or admin (also removes the vector point)

# Persistent user memory
GET    /api/user-memory                      ← my facts (confirmed + pending)
POST   /api/user-memory/extract              ← { chatId } — on-demand extraction → { proposals }
POST   /api/user-memory/confirm              ← { ids } — confirm pending facts → confirmed
POST   /api/user-memory                      ← { content } — add a manual fact (confirmed)
PATCH  /api/user-memory/:id                  ← { content } — edit a fact
DELETE /api/user-memory/:id                  ← delete (reject pending or remove confirmed)

# Token usage (dashboard)
GET    /api/usage/me                         ← my usage (tokens only, no costs) — ?from&to
GET    /api/usage                            ← [admin] tokens + estimated costs of everyone (per user/project/model) — ?from&to

# Internal (auth: x-internal-token header — signed run/daemon token; see RUN_TOKEN_SECRET)
POST   /internal/skills/:id/save-config      ← upsert secure config vars (no JWT)
POST   /internal/daemons/events              ← push daemon event → Socket.IO
POST   /internal/datasources/:id/query       ← query/file-op (scope-checked against the token's identity)
POST   /internal/vector/search · /ingest     ← vector search/indexing

# WebSocket
WS     /mcp-bridge        ← Electron Bridge (Socket.io, JWT auth)
WS     /notifications     ← Real-time daemon → frontend notifications (Socket.IO)

# Docs
GET    /api/docs           ← Swagger UI
```

---

## 12. Key Environment Variables

### Backend (root `.env`)

```bash
# Server
PORT=3000
NODE_ENV=development

# CORS — allowed origins (comma-separated). If not set = allow all.
FRONTEND_URL=http://localhost:5173

# Auth
JWT_SECRET=...
JWT_EXPIRES_IN=7d

# LLM · Embedding · Vector DB → configured from the admin UI (Settings → AI System),
# persisted encrypted in the DB (tables llm_configs / app_config / vector_db_config).
# Not set via env. (The `embedding` container uses EMBEDDING_MODEL/DEVICE/BATCH_SIZE.)

# Agent (optional) — LangGraph step limit per message and tool output replay cap in history
AGENT_RECURSION_LIMIT=50            # default 50 ≈ 25 LLM↔tool rounds, min 10
REPLAY_TOOL_OUTPUT_MAX_CHARS=3000   # default 3000 chars/output, min 500

# Application database
DB_HOST=localhost
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
DB_NAME=arkimede

# Crypto — AES-256-GCM key for tool, data source, LLM config secrets (A1)
# REQUIRED: 64 hex chars. Without it, the backend will NOT start (fail-fast).
TOOL_SECRETS_KEY=...   # openssl rand -hex 32

# App branding
APP_NAME=Arkimede

# Skills — upload and path
UPLOAD_DIR=./uploads
SKILL_EXECUTOR_URL=http://skill-executor:4000   # Docker sidecar URL (internal port 4000)

# Skill isolation — broker overlay (D2, optional). If BROKER_URL is set,
# python/node skills run as ephemeral container-jobs launched by the broker.
# BROKER_URL=http://broker:4100
# JOB_RUNTIME=runc                 # runc | runsc (gVisor)
# JOB_EGRESS_NETWORK=sandboxnet    # egress network for the jobs (with the egress combo)
# SKILLS_HOST_BASE / WORK_HOST_BASE / SKILL_STATE_HOST_BASE / SKILLS_OUTPUT_HOST_BASE  # shared host paths

# Internal API /internal/* — signed run tokens (HMAC). Secret ONLY in the backend.
RUN_TOKEN_SECRET=<secret>   # openssl rand -hex 32 (required)
# Service mesh auth (header x-service-key): backend→executor and executor→broker. Required.
SERVICE_API_KEY=<secret>    # openssl rand -hex 32

# GitHub skills registry
SKILLS_REGISTRY_URL=https://...              # default: official community registry
SKILLS_REGISTRY_CACHE_TTL_MS=300000         # cache TTL in ms (default 5 min)
SKILLS_REGISTRY_ALLOWED_DOMAINS=cdn.com     # extra domains allowed for ZIP download
```

### Frontend (`frontend/.env`)

```bash
VITE_APP_NAME=Arkimede

# Base URL of the NestJS backend (without /api).
# If not set → Vite proxies /api → localhost:3000 (no CORS in dev).
# VITE_BACKEND_URL=http://localhost:3000

# WebSocket URL for the Electron bridge.
# VITE_WS_URL=ws://localhost:3000
```

---

## 13. Development Startup

```bash
# 1. Infrastructure (Postgres + Qdrant + skill-executor)
docker compose up postgres qdrant skill-executor -d

# 2. NestJS backend
cd backend
npm install
npm run migration:run   # applies the ~52 TypeORM migrations (or auto at boot: migrationsRun=true)
npm run start:dev       # → http://localhost:3000

# 3. Frontend
cd frontend
npm install
npm run dev             # → http://localhost:5173

# 4. Electron Bridge (optional — only for MCP transport 'remote')
cd bridge
npm install
npm run dev
```

**First startup:** `app_config` is initialized with the default system prompt from `system.prompt.ts` and the Anthropic
provider. Editable by admin in "Settings → AI System" without a redeploy.

---

## 14. Architectural Decisions

- **No built-in tools:** `builtInTools = []`. All the tools of the initial domain (`rag.tool.ts`, `database.tool.ts`,
  `recommend.tool.ts`, `completeness.tool.ts`, `pdf-gen.tool.ts`) and the recommendation system (
  `recommendation.service.ts`) have been removed. RAG/SQL → custom tool type; file/PDF generation → skill. More
  flexible, multi-tenant, no domain hard-coding.
- **Custom tool rebuild per request:** `createReactAgent` is in-memory (~1-2ms), does no I/O — it is safe to rebuild it on
  every request to include the user's updated tools.
- **AppConfig singleton:** table `app_config` with `id=1` for base system prompt, embedding, tool loading and history
  compaction. The old `llm*` fields remain in the schema but are legacy (see below).
- **Multi-record LLM config (llm_configs):** effectively replaces the app_config `llm*` fields. `LlmConfigsService`
  contains the per-provider build logic (`buildModelForConfig(entity, overrides?)`); `LlmProviderService` is a
  cached wrapper around the `isDefault` config (and `getSummarizerModel()` for the `isSummarizer` config). Cache
  invalidated when the default changes. Fallback on env vars if the API key is not in the DB.
- **Provider-agnostic VectorDb:** `VectorStoreAdapter` isolates the business logic from the connection details.
  Adding a new provider = adding an adapter.
- **DataSource separate from the SQL tool:** `DataSource` = the connection (what the DB is). `CustomTool[sql]` = how
  to query it (query, prefetch, limits). Reuse of the same DataSource by different tools.
- **4-level system prompt:** basePrompt (admin) + userPrompt (user) + projectPrompt (project) + skillsPrompt (
  selective SKILL.md). Order: the most specific goes last. `buildSystemPrompt()` concatenates the non-empty layers.
- **`local` vs `remote` MCP:** `local` → NestJS spawns stdio directly (same machine). `remote` → the Electron bridge
  spawns on the user's machine and proxies via WebSocket. Choose `local` for a self-hosted setup.
- **Multi-user bridge routing:** each bridge authenticates with the user's JWT. The gateway indexes everything by
  `userId`.
- **Encrypted secrets in the DB (AES-256-CBC):** tool API keys, DataSource connection strings, LLM API keys, vector DB API keys.
  Never exposed in API responses.
- **Backend CORS:** a single point in `enableCors()` (`main.ts`). Do NOT pass `cors: true` to `NestFactory.create` — it causes
  a duplicate header.
- **Backend compiler = tsc** (no longer SWC): `nest-cli.json` has `"builder": "tsc"`. `nest build` and `npm run typecheck`
  (`tsc --noEmit`) validate the types and run cleanly (recommended `NODE_OPTIONS=--max-old-space-size=4096`). `.swcrc` and the
  `@swc/*` deps remain in the repo but are inert. (History: in the past `tsc` went OOM on the LangGraph types → now solved.)
- **OpenAI SDK base64:** SDK v4.25+ sends `encoding_format=base64` by default → local servers break. The probe uses
  a direct `fetch()` with an explicit `encoding_format: 'float'`.
- **`LocalMcpProcess` porting:** faithful porting of the bridge's `McpProcess` for NestJS. Keep the two files aligned.
- **Tool loading strategy:** `ToolSelectionService` applies the strategy before building the agent. With `top_k_rag`
  (or `auto` above threshold) only the selected tools are injected into the context; with `deferred` even the SKILL.md
  stays out of the prompt → fixed context/call reduced by ~80%, turn cost ~halved (measured).
- **Selective SKILL.md:** `<!-- @tool: script.py -->` markers in the SKILL.md split the content into sections. Only the
  sections of the selected tools are included in the system prompt. The block before the first marker is always included (
  shared/intro).
- **Anthropic prompt caching:** `SystemMessage` with `cache_control: { type: 'ephemeral' }` on the system
  prompt content. The Anthropic provider caches up to the first 32k stable tokens. Cache write: ×1.25 cost; read: ×0.10 (90%
  savings).
- **DeepSeek reasoning_content:** the DeepSeek API requires `reasoning_content` on every assistant message in the history.
  Since it is not saved in the DB, it is injected as an empty string in the fetch interceptor before every request.
- **`always_inject_all` legacy:** for compatibility, this strategy bypasses selection and loads all tools and all
  the SKILL.md. Use for testing or when all the tools are always relevant.
- **Skills as DynamicStructuredTool:** every `mode: oneshot` script of every enabled skill assigned to the project
  is converted into a LangChain `DynamicStructuredTool` by `skill-tool.factory.ts`. Built on every `resolveAgent` (
  ≤2ms, no I/O).
- **`onToolResult` for SSE file events:** instead of having every skill explicitly return a downloadable URL
  for every file, the backend recursively scans the return JSON of each tool. Any string that resolves
  into a file on disk generates an SSE `file` event — transparent to the scripts.
- **Enabled toggle without deletion:** skills can be disabled (`enabled=false`) without losing
  configuration or assignments. Filter applied in `buildSkillSystemPromptSelective` and in `resolveAgent` before
  building the tools.
- **Internal API `/internal/*` (signed run tokens):** every skill/daemon execution receives an HMAC token
  minted by the backend (`RUN_TOKEN_SECRET`, backend-side only) and injected as the `INTERNAL_TOKEN` env; the script
  forwards it in `x-internal-token`. The token carries the identity (`sub`=userId) unforgeably → the scoped
  endpoints (e.g. datasource) enforce ownership on that identity. It replaces the old shared `INTERNAL_API_KEY`
  injected into the scripts. The mesh's **service-to-service** auth (backend→executor→broker) instead uses
  `SERVICE_API_KEY` (header `x-service-key`), separate from the token signing. Verified in `InternalTokenGuard`; minting in `skill-tool.factory`
  (run) and `daemons.service` (daemon).
- **Automatic daemon restore:** `DaemonsService.onModuleInit()` automatically restarts the daemons in `running`
  or `starting` state at backend boot.

---

## 15. Frontend Settings Sections

| Section             | Visibility | Content                                                                                                                      |
|---------------------|------------|------------------------------------------------------------------------------------------------------------------------------|
| Profile             | Everyone   | Name, email, user systemPrompt, password change                                                                              |
| LLM Provider        | Admin      | Multi-record LLM config (llm_configs): add/edit, ⭐ default, ✨ summarizer, connection test                                    |
| AI System           | Admin      | Embedding provider, base system prompt, tool loading + conversation memory (maxHistoryTokens, history compaction + threshold) |
| Custom Tools        | Everyone   | CRUD HTTP/SQL/RAG/prompt tools, inline test, secrets                                                                          |
| MCP Servers         | Everyone   | CRUD MCP servers (http/sse/local/remote), secrets                                                                            |
| Files               | Everyone   | Files uploaded in the projects, indexing management                                                                          |
| Database            | Everyone   | CRUD DataSource (external DB connections for SQL tools)                                                                       |
| Vector DB           | Admin      | Vector DB provider configuration, collection management                                                                      |
| Skills              | Everyone   | Upload ZIP, config vars, project assignment, enabled toggle                                                                  |
| Skills / Publish    | Everyone   | Team (owner, direct) · Org → internal marketplace (org+approved) + external GitHub Registry                                   |
| Skills / Review     | Admin      | Approval/rejection of pending skills                                                                                         |
| Skills / Background | Everyone   | Start/stop skill daemons, real-time status and logs                                                                          |
| Flows               | Everyone   | React Flow canvas: 11 node types, triggers, error-policy, execution + run history                                            |
| Agents              | Everyone   | Multi-Agent agent CRUD (prompt, model, tool filter, scope)                                                                   |
| Agent teams         | Everyone   | Team composition (ordered members) + supervisor/sequential/parallel topology                                                |
| Automations         | Everyone   | Scheduled automations (Auto-Scheduling): status, pending+Activate, token/cost per run, enable/delete                         |
| Activity            | Everyone   | Read-only dashboard: skill daemons, automations, scheduled flows and latest aggregated runs (auto-refetch every 10s)         |

---

## Multi-Agent (Level 2)

> **Status: IMPLEMENTED AND VERIFIED.** Module `agents/` in code: entities `agents` /
> `agent_teams` / `agent_team_members`, `AgentsService` + `AgentTeamsService` (CRUD with scope `personal|team|org`,
> `assertCanManage`), `MultiAgentService` runtime with **single / sequential / parallel / supervisor** topologies (routing
> loop cross-provider). Chat integration: `chats.agentTeamId` → the chat runs with the team, SSE `agent_step` events
> attributed to the sub-agent. UI: **Settings → Agents** (`AgentsPage`) and **Agent teams** (`TeamsPage`), a selector
> "run with a team" in `ChatWindow`. Migration `CreateAgents` + `ChatAgentTeam`. The section below remains as the reference
> spec; the differences from the code are annotated (e.g. supervisor = TS loop, not `StateGraph`).
> 🔭 **Still to do (Option 4):** a **literal `StateGraph` version** (`Command` handoff, checkpoint/resume,
> human-in-the-loop).
>
> **Agent-as-tool (hierarchical delegation).** Beyond running the **entire** chat with a team (`chats.agentTeamId`,
> either-or), an agent/team with `exposeAsTool=true` is exposed as a `DynamicStructuredTool` (`agent_<slug>` / `team_<slug>`)
> **among** the tools of a normal chat: the main model delegates a task to it without seeing its internal tools. It combines with
> `loadOnFirst` (per-tool) to keep the encapsulated tools out of the flat context — see
> [Hierarchical delegation](#hierarchical-delegation--exposeastool--loadonfirst).

### Starting point (current state)

Today the engine is **single-agent**: `resolveAgent()` builds **a single** `createReactAgent` (LangGraph prebuilt) with
the `isDefault` LLM and all the selected tools. The only form of "second agent" is the `prompt` executor (§5), which is in
fact a **single stateless `callLlm`** (`custom-tool.factory.ts`): system+user → one response, **without its own tools,
without a loop, without state**. It is an *LLM function*, not an autonomous agent. Missing: orchestrator, sub-agents with their own
tools, parallelism, handoff.

### Level 2 vision — teams of agents configurable from the UI (no-code)

Consistent with the product principle ("everything configurable from the UI, no code"): the user **defines their own
agents and composes them into teams**, reusing the already existing infrastructure. It is the differentiator vs the competitors
(Agent Zero / OpenHands have hierarchical teams but code-first; Open WebUI / Claude Desktop have no real teams of
agents).

An **agent** = (system prompt + one `LlmConfig` + a subset of tools/skills/MCP filtered by scope). A **team** =
N agents + a **topology** that governs their collaboration. All the building blocks already exist:

| Reused building block | From where |
|---|---|
| Per-agent model (even a cheap one for "writer" roles) | `llm_configs` multi-record + `buildModelForConfig` |
| Per-agent tools/skills/MCP, filtered | `loadToolsForUser` + scope `personal\|team\|org` |
| Dynamic per-project RAG | `rag` executor `searchScope:auto` |
| Layered system prompt | `buildSystemPrompt` (the agent's prompt is added) |
| Streaming + tool events | SSE `chunk\|tool_call\|tool_result\|file\|usage\|done` |
| Per-model costs | `usage/` already attributes per `provider/model` |

### Supported topologies (target)

| Topology | Behavior | Use case |
|---|---|---|
| `supervisor` | A supervisor agent receives the request and does a **handoff** (`Command(goto=...)`) to the specialized agent, collects the outcome, decides the next step or replies | Routing by domain (e.g. "SQL analyst" vs "document writer") |
| `sequential` | A fixed pipeline A→B→C, one's output is the input of the next | Deterministic flows (extract → transform → write) |
| `parallel` | N agents work in parallel on sub-tasks, a final node (`fan-in`) aggregates | "Analyze these 5 suppliers" → 5 sub-agents in `Promise.all` |
| `agent-as-tool` | An agent is exposed as a `DynamicStructuredTool` to the main agent (evolution of the `prompt` executor → type `agent`) | Incremental migration from the current single-agent (Level 0) |

**Advantages** (see also §why): context isolation (a sub-agent does 10 RAG queries and returns **only the
synthesis** → the supervisor's context clean), **latency** (parallelism), **specialization** (the right
model/prompt/tool for the role). **Trade-off**: token cost (each sub-agent reloads its own context) and more complex debugging →
multi-agent should be used where the task is **decomposable**, not everywhere.

### Implementation — from `createReactAgent` to `StateGraph`

> **Implementation note (current state).** The supervisor is implemented as a **routing loop** in TypeScript
> (`MultiAgentService.runSupervisor`): the supervisor chooses the next member or `FINISH` with **normal** LLM calls,
> not `withStructuredOutput` — because the latter is provider-dependent and violates the rule "LLM code must run on
> all providers". Identical behavior. 🔭 **Possible future implementation (Option 4):** a **literal
> `StateGraph` version** (`Command` handoff, checkpoint/resume, per-node streaming, human-in-the-loop). Worthwhile only if
> those capabilities are needed: the current loop is functionally equivalent and cross-provider.

`resolveAgent()` is refactored (not rewritten): if the chat/project uses a team, instead of the single
`createReactAgent` a LangGraph **`StateGraph`** is compiled in which each agent is a node (itself a
`createReactAgent` with **its own** tools and **its own** model), and the edges/`Command`s implement the topology. The
supervisor decides the handoffs via **structured output**, cross-provider (never single-provider logic).

```
resolveTeam(userId, projectId, teamId, userInput, history, chatId):
  agents = loadAgentsForTeam(teamId)          # each: systemPrompt + llmConfig + tool scope
  nodes  = agents.map(a => createReactAgent({
             llm:   buildModelForConfig(a.llmConfig),
             tools: applyStrategy(loadToolsForUser(userId, projectId, a.toolFilter)),
             messageModifier: buildSystemPrompt(base, user, project, a.systemPrompt),
           }))
  graph  = new StateGraph(...).addNode(...nodes)
             .addEdge(topology)               # supervisor | sequential | parallel
             .compile()
  return graph
```

### Data model (implemented)

```
agents                         # a reusable agent (like tool/skill: scope personal|team|org)
  ├── id, name, description
  ├── systemPrompt (text)
  ├── llmConfigId (FK→llm_configs)        ← the agent's model (per-role override)
  ├── toolFilter (jsonb)                  ← which tools/skills/MCP it loads (by name or by scope)
  ├── maxIterations (int, null)           ← cap on the sub-agent's ReAct loop
  └── scope (personal|team|org) + teamId  ← same model as custom_tools/skills (assertCanManage)

agent_teams
  ├── id, name, description
  ├── topology (supervisor|sequential|parallel)
  ├── supervisorAgentId (FK→agents, null) ← only for topology=supervisor
  └── scope (personal|team|org) + teamId

agent_team_members             # join agents ↔ team, with order for the pipelines
  ├── teamId (FK→agent_teams), agentId (FK→agents)
  ├── position (int)                      ← order for sequential
  └── role (varchar, null)                ← free label ("researcher", "writer"...)

# Execution link:
chats.agentTeamId  (FK→agent_teams, null) ← if set, the chat runs with the team instead of the default
# (or projects.agentTeamId to set the team at the project level)
```

### Execution & SSE streaming

The stream must stay readable on the UI side: every sub-agent event is **attributed** to the agent that
produced it, extending the existing SSE events with an `agent` field:

| `type` | Extension | Meaning |
|---|---|---|
| `agent_start` | `{ agent: string, role?: string }` | A sub-agent takes control (handoff) or starts (parallel) |
| `chunk` / `tool_call` / `tool_result` / `file` | `+ { agent: string }` | Same payload as today, attributed to the sub-agent |
| `agent_end` | `{ agent: string, summary?: string }` | The sub-agent has finished and returns the outcome to the supervisor |

Costs continue to be attributed correctly: `usage/` already records `provider/model` **per message**, so each
sub-agent's tokens go on the right model without changes to the usage schema.

### Scope, permissions, multi-tenant

Agents and teams follow **the same scope model** as tools/skills/datasources (`personal | team | org`, `teamId`,
`assertCanManage`: personal=owner, org=admin, team=admin-or-owner). An `org` team = standard company workflow curated
by admins; `team` = department workflow; `personal` = experimentation. Membership-based visibility applies as for
the other resources.

### Rollout roadmap — ✅ completed

1. ✅ **Level 0 — `agent-as-tool`.** An agent exposed as a `DynamicStructuredTool`.
2. ✅ **Level 1 — supervisor.** Supervisor topology (cross-provider TS routing loop) + sequential + parallel in
   `MultiAgentService`.
3. ✅ **Level 2 — teams configurable from the UI.** Tables `agents`/`agent_teams`/`agent_team_members`, sections
   "Settings → Agents / Agent teams", team selector on the chat (`chats.agentTeamId`). The no-code USP.

> 🔭 Only **Option 4** remains (supervisor on a literal `StateGraph` with checkpoint/resume/human-in-the-loop) —
> optional.

### Planned UI (Settings)

| Section | Visibility | Content |
|---|---|---|
| Agents | Everyone | Agent CRUD: prompt, `LlmConfig`, selected tools/skills/MCP, scope |
| Agent teams | Everyone | Team composition, topology (supervisor/sequential/parallel), member order, scope |

---

## Flows

> **Status: SLICES 1–4 COMPLETE + VERIFIED.** Backend `flows/` (entity+migration, `FlowEngine` DAG +
> `BindingResolver`, `flow_runs` history) and frontend (React Flow canvas in Settings → Flows, palette by family +
> binding picker). **12 node types:** tool, llm, condition, http, skill, transform, flow (recursive sub-flow with
> depth-guard), **agent, team** (Multi-Agent bridge), **loop** (map over an array via a sub-flow), **join** (fan-in) and **chat**
> (deliver/post a message to a chat). **Wave engine** (real parallelism: independent branches in `Promise.all`)
> + **per-node error-policy** (stop/continue/retry). **Per-node test run**: runs the subgraph of the predecessors to
> test a single node from the editor. **Triggers:** manual, **cron** (recurring), **scheduled** (one-shot), **webhook**
> (public endpoint) and **chat-as-tool** (flows exposed to the agent). Scheduler on **BullMQ + Redis** (`syncAll` at boot,
> degrades gracefully if Redis is down). ⚠️ isolated-vm (`transform` node) requires the executor in **Docker** (no prebuilt
> arm64 locally). Complementary to [Multi-Agent](#multi-agent-level-2), not alternative: visual block editor,
> **DAG graph with branches** (parallel + join), all node/trigger types, persisted execution history.

### Why — the third paradigm (determinism)

The three levels of control of an agentic platform, from the freest to the most rigid:

| Paradigm | Who decides the "how" | When to use it | Status |
|---|---|---|---|
| **Agent** (ReAct) | the LLM at runtime | conversation, open tasks | ✅ in code |
| **Multi-Agent** | the LLM, but in structured roles | tasks decomposable by domain | 🎯 design |
| **Flow** | **the author** (fixed steps and order) | **repeatable and predictable processes** | 🎯 design (this section) |

A Flow answers the question *"and when do I NOT want the LLM to improvise?"* — which in B2B always comes up. The author
defines the **steps and the order**; the LLM works only **inside** the nodes assigned to it. Advantages:
**repeatability** (same request → same path), **cost control** (number of LLM calls known in advance),
**reuse** (a packaged, invokable multi-step process). It's the pattern of AnythingLLM's "Agent Flows" and, on the
trigger side, the point in common with n8n.

### The nodes already exist

A Flow introduces no new building blocks: **it reuses the `custom_tools` (http/sql/rag/prompt), the `skills` and — once they exist
— the `agents`/`agent_teams` as nodes.** What is missing today is the layer that **chains them declaratively**,
with explicit output→input passing from one step to the next. The Multi-Agent's `sequential` topology is in
fact a particular case of a Flow (A→B→C of agents only); the Flow is the **more granular and deterministic** version, in
which a node can also be a single tool call, a condition or a transformation.

### Building-blocks taxonomy (3 families = 3 color groups)

`cron` **is not a middle node, it is a trigger building block** (the flow's entry). The blocks split into 3 families,
which on the canvas become the color groups:

| Family | Color | Building blocks | Role |
|---|---|---|---|
| **Trigger** (entry, 1 per flow) | 🟢 green | `manual`, `cron`, `chat-as-tool`, `webhook`, `flow-call` | where the flow starts from |
| **Action** | 🔵 blue | `tool`, `skill`, `llm`, `http`, `transform`, `flow` (invokes another flow) | do the work, produce output |
| **Control** | 🟠 orange | `condition` (if/else), `branch`/`join`, `loop` | decide the path (DAG with branches) |

> Bridge with Multi-Agent: the `agent`/`team` nodes (Action family) will arrive with the Multi-Agent implementation; the
> `flow` node makes flows **recursively composable**.

### Node I/O model (the heart of the design)

**Who converts the data from one node to another:** not the producer node nor the consumer, but the engine's
**`BindingResolver`**, which runs *before* executing each node. Three pieces:

**1. Standard envelope** — every node always returns the same shape. The `status` is always there (it resolves the
"fire-and-forget" nodes like sending an email: `{ status:'ok' }` without `output`); the `output` is optional.

```
NodeResult {
  status: 'ok' | 'error'     // ALWAYS present (email OK/KO case)
  output?: any               // JSON payload — absent for nodes with no return value
  error?:  string
  meta?:   { durationMs, ... }
}
```

**2. Run state** — the engine accumulates the outputs by node-id, so that *any* downstream node reads *any* upstream
node (necessary in the branches that rejoin):

```
flow_runs.state = {
  input: { ... },                              // variables from the trigger/start
  nodes: {
    estrai_pdf: { status:'ok', output:{ righe:[...] } },
    invia_mail: { status:'ok' },               // no output, only status
  }
}
```

**3. Binding on the consumer** — each node declares its own inputs as a **mapping** over the state; the `BindingResolver`
evaluates them and passes the node the already-prepared arguments. It extends the existing interpolation (`{{param}}`/`{{secret.KEY}}`) with
two namespaces: `{{input.*}}` and `{{nodes.<id>.output.*}}`.

```
node "invia_mail":  to = "{{ input.email_cliente }}",  body = "{{ nodes.riassumi.output }}"
node "interroga_db": regione = "{{ nodes.estrai_pdf.output.regione }}"
```

**Light vs heavy conversion:** the binding does light conversion (pick a field, interpolate, coerce). For
heavy restructurings you insert a **`transform`** node (deterministic) or an **`llm`** node (fuzzy). On the canvas: the wires =
order + availability of the data; the node's input panel = the conversion contract (with a picker for the upstream outputs,
n8n-style).

**Design decisions (confirmed):**
- **Expressions in the binding:** templating + path (`{{ nodes.A.output.field }}`, JSONPath) **everywhere**; **arbitrary
  JS** expressions allowed **only inside the `transform` node**, run in the **`isolated-vm`** sandbox (already used by the
  skills' JS runner). No `eval` of user code outside there.
- **Types:** **free JSON** (dynamic). Per-node output schema **optional**, used only by the editor (picker
  autocomplete + warnings), never blocking.
- **Topology:** **DAG with branches** — `condition` forks, two branches can go in **parallel** and rejoin in a
  `join` node. The engine runs in **topological order**, not as a linear chain.

### Data model

```
flows                          # reusable definition (scope like tool/skill: personal|team|org)
  ├── id, name, description
  ├── definition (jsonb)       ← { nodes:[...], edges:[...] } — DAG graph + per-node binding
  ├── trigger (jsonb)          ← { type: manual|cron|chat-as-tool|webhook|flow-call, ...config }
  ├── exposeAsTool (bool)      ← if true, the agent invokes it as a DynamicStructuredTool
  ├── inputSchema (jsonb)      ← start variables (tool signature / UI form)
  ├── enabled (bool)           ← toggle (like the skills)
  └── scope (personal|team|org) + teamId   ← assertCanManage (personal=owner, org=admin, team=admin/owner)

flow_runs                      # execution history (observability + debug)
  ├── id, flowId (FK→flows), userId, projectId (null), triggeredBy (manual|cron|agent|webhook|flow)
  ├── status (running|completed|error|cancelled)
  ├── state (jsonb)            ← input + nodes[].output (see above)
  ├── nodeRuns (jsonb)         ← per-node: status, durationMs, error (debug timeline)
  ├── error (text, null)
  └── startedAt / finishedAt
```

> Nodes/edges live **inside `flows.definition`** (jsonb), not in `flow_nodes`/`flow_edges` tables: the topology is
> read/written in bulk from the editor, the jsonb avoids joins and migrations on every new node type.

### Execution engine

The `FlowEngine` interprets `definition` as a **DAG**: it computes the topological order from the trigger nodes, and for each node
**(1)** the `BindingResolver` resolves the inputs from the `state`, **(2)** runs the node reusing the existing services
(`CustomToolsService.buildToolForTest`/`loadToolsForUser` for `tool`, `SkillsService` for `skill`, the `callLlm` pattern
for `llm`, `isolated-vm` for `transform`), **(3)** writes the `NodeResult` into the `state`. The `condition`s select the edge
to follow; the independent branches run in **parallel** (`Promise.all`) and rejoin in the `join`s. Control-flow
**deterministic** (decided by the author), **LLM confined** to the `llm` nodes. Per-node error-policy (stop | continue |
retry); `flow_runs` persists state and timeline for **debugging**. Runtime on LangGraph's `StateGraph` (same as the
Multi-Agent) or a dedicated interpreter — to be decided in Slice 1.

### Triggers — the "n8n-like" piece

| Trigger | How it starts | Notes |
|---|---|---|
| `manual` | "Run flow" UI with the variable form | Test and ad-hoc runs |
| `chat-as-tool` | The agent invokes it as a tool (`exposeAsTool`) | The flow becomes a deterministic action in the chat |
| `cron` | Scheduled (ties in with the §16 "CRON" row) | A flow that starts on its own, without a chat → true automation |
| `webhook` | External POST with a token | Integration with third-party systems |

`chat-as-tool` + `cron` are what fills the gap toward n8n: a **repeatable** process that can start **from the chat,
on its own, or from an external event**.

### SSE streaming & costs

Runs started from the chat reuse the existing SSE channel, extending the events with attribution to the node:

| `type` | Extension | Meaning |
|---|---|---|
| `flow_node_start` | `{ flowRunId, nodeId, nodeType }` | Start of a node's execution |
| `tool_call` / `tool_result` / `file` | `+ { nodeId }` | Same payloads as today, attributed to the node |
| `flow_node_end` | `{ nodeId, ok }` | End of the node |
| `flow_end` | `{ flowRunId, status }` | Flow completed/error |

Costs continue to be attributed via `usage/` (`provider/model` per message): the tokens of the `llm`/`agent` nodes end up
on the right model without changes to the usage schema.

### Relationship with Multi-Agent (no duplication)

The two systems **share the `StateGraph` runtime** and nest: a **Flow node can be an agent/team**, and
an **agent can invoke a Flow as a tool**. The boundary rule: **Flow = control-flow decided by the author**
(deterministic); **Multi-Agent = control-flow decided by the LLMs** (supervisor/handoff). The Multi-Agent's `sequential`
topology remains as a shortcut for agent-only pipelines; the Flow is the general, granular case.

### Planned UI (Settings)

| Section | Visibility | Content |
|---|---|---|
| Flows | Everyone | Flow list/CRUD, block editor (nodes + edges + variable mapping), triggers, `exposeAsTool`, scope |
| Flows / Runs | Everyone | `flow_runs` history, status, per-node debug, re-run |

### Roadmap — vertical slices (each working end-to-end, no throwaway)

The goal is the **complete** feature; to get there without a throwaway half-product it is built in vertical slices
(backend+engine+canvas together), each usable and based on the previous one:

1. **Slice 1 — backbone. ✅ DONE + VERIFIED.** Module `flows/` (entities `flows`+`flow_runs`, migration),
   `FlowEngine` DAG + `BindingResolver`, nodes `tool`/`llm`/`condition`, `manual` trigger, base **React Flow canvas**,
   `flow_runs` history. → a real flow runs and is visible.
2. **Slice 2 — node coverage. ✅ DONE + VERIFIED.** `skill`, `transform` (JS sandbox `isolated-vm`), `http`, `flow`
   (nested); complete visual binding picker (selecting upstream outputs).
3. **Slice 3 — external triggers. ✅ DONE + VERIFIED.** `cron` (recurring) and `scheduled` (one-shot "day X at Y")
   on a **BullMQ + Redis scheduler** (`FlowSchedulerService`: Job Scheduler for the cron, delayed job for the one-shot;
   `syncAll` at boot realigns Redis to the DB; degrades gracefully if Redis is down). `webhook` = public endpoint
   `POST /api/flows/webhook/:token` (separate controller, no JWT; token generated on creation). `chat-as-tool` =
   flows exposed as `DynamicStructuredTool`s via `FlowsService.loadToolsForUser`, hooked into `resolveAgent`.
   Redis added to `docker-compose` + `REDIS_URL` (default `redis://localhost:6379`).
4. **Slice 4 — ✅ DONE + VERIFIED.** `agent`/`team` nodes (Multi-Agent bridge via `MultiAgentService`/ModuleRef),
   per-node error-policy (`stop`/`continue`/`retry`), **wave** engine (real parallelism: independent branches in
   `Promise.all`), `join` nodes (fan-in) and `loop` (map over an array via a sub-flow). All verified end-to-end.
5. **Slice 5 — usability & chat integration. ✅ DONE.** **`chat`** node (post/deliver a message to
   a chat, also for the automations → see the unread badge in §Auto-Scheduling), **per-node test run** (runs the
   subgraph of the predecessors only to test a node from the editor with live binding). Migration `FlowChatDelivery`.

---

## Auto-Scheduling (Design)

> **Status: IMPLEMENTED AND VERIFIED.** Module `scheduling/`: built-in tool `schedule_task` (always
> injected into the agent), `SchedulingService` on BullMQ (cron + one-shot), a **headless** runner that re-runs the agent
> (`AgentService.invoke` via ModuleRef) and delivers via a notification; "Automations" UI section. Verified end-to-end:
> in the chat → the agent schedules (cron `* * * * *`) → fires after ~27s → the instruction runs → `lastResult` delivered.
> Realized as **model B** (agent re-invocation). Goal achieved: *"from tomorrow at 8, every day, check
> the mail and summarize"* actually gets scheduled. **+ Confirmation (Option 2)**: a two-tool flow safe by default
> (`schedule_task`→`pending`, `confirm_scheduled_task`→`active`) — verified (the pending does not fire until
> confirmed). **+ Guardrails (Option 3)**: `SCHED_MAX_TASKS_PER_USER`/`SCHED_MAX_ACTIVE_RECURRING` via env.
> (Model A flow-generation: future extension.)

### Today's gap

We have the **rails** (BullMQ scheduler, cron/scheduled triggers on Flows) but the **lever in the cockpit** is missing: the agent has
no tool to *create* a schedule from the conversation. Today, faced with that request, the agent schedules
nothing (or, worse, "pretends"). A bridge NL → scheduled automation is needed.

### Three decision axes

**1. Where the entry point sits.** → **Built-in tool, with an intrinsic engine.**
- **Skill: excluded** (rightly): it runs in the executor's sandbox, does not know the backend, cannot create flows nor
  register BullMQ jobs.
- **Custom tool**: configured by the user, not guaranteed present; scheduling is a **platform primitive** →
  it must always be available.
- **Built-in tool** (always injected into the agent) that calls an **intrinsic `SchedulingService`** (generalization of
  `FlowSchedulerService`). Plus an **"Automations" UI** to view/cancel the scheduled tasks. So: *a conversational
  façade as a tool + a real intrinsic capability in the backend.*

**2. What gets scheduled (the central choice).**

| Model | How | Pros | Cons |
|---|---|---|---|
| **A — Flow-generation** (deterministic) | The task is compiled into a **Flow** (nodes + trigger) and saved; the FlowEngine re-runs it identically | Deterministic, debuggable/editable in the Flows UI, cheap, observable (`flow_runs`) | The task must be expressible as a graph; composing nodes/binding from open NL is difficult |
| **B — Agent re-invocation** (agentic) | The instruction+context is saved; on fire a headless **AgentRunner** re-runs the agent (with its tools) that re-reasons and acts; output delivered via notifications/email | Handles **anything** expressible in NL ("schedule anything"); no graph composition | Non-deterministic, pays the LLM cost on every fire, needs a delivery channel |

> **NB:** in no case must the LLM emit raw flow JSON (fragile). In model A, the tool takes a **high-level structured
> spec** and the **backend** assembles the flow (or, post-Multi-Agent, a *flow-author agent* composes it).

### Recommendation: hybrid, default B, promotion to A

- Built-in tool **`schedule_task`** → registers a job on the **existing BullMQ scheduler**.
- Default execution = **model B** (headless agent re-invocation): it is what actually makes "schedule
  anything" work. Result delivery via the **notifications** channel (Socket.IO already present) and/or email if there is a mail
  tool; consider an "Automations" chat thread where to post the outcomes.
- When the task is well defined → **materialize a Flow** (model A) for determinism/cost, visible/editable in the UI.
- **Multi-Agent** bridge: the headless runner can run an entire **team**; an *automation agent* can decide A vs B
  and compose the flows.

### Extensions status

- ✅ **Confirmation UX (Option 2) — DONE.** A two-tool flow safe by default: `schedule_task` creates the task in state
  `pending` (NOT registered on BullMQ → it does not fire); the agent summarizes and asks for confirmation; `confirm_scheduled_task`
  activates (or deletes). In the UI the pending shows "pending" + an "Activate" button (`POST /scheduled-tasks/:id/activate`).
- ✅ **Guardrails (Option 3) — DONE.** `SCHED_MAX_TASKS_PER_USER` (default 25) and `SCHED_MAX_ACTIVE_RECURRING`
  (default 10), **configurable via env**.
- ✅ **Token tracking (Option 6) — DONE.** Util `common/llm-usage.util.ts`. **Team-in-chat** → tokens aggregated on the
  assistant message (→ Usage dashboard); **automations** → `scheduled_tasks.lastInputTokens/lastOutputTokens` (via
  `AgentService.invokeWithUsage`) shown in the Automations UI. Verified (team 44/113; automation 24173/68).
- ✅ **Cost guardrail (tokens) — DONE.** Per-run cap `SCHED_MAX_TOKENS_PER_RUN` (default 200000, env, 0=off):
  above the threshold the task is **disabled** + a `scheduled_task_disabled` notification. `scheduled_tasks.totalTokens`
  (bigint) accumulates the tokens over all the runs (shown in the UI).
- ✅ **Tool-subset for the headless runs — DONE.** `scheduled_tasks.toolFilter` (default **`none`** = cheap run).
  The agent chooses the tools needed at `schedule_task` time (arg `tools`), the user **confirms** them (Option 2),
  and the headless run loads **only** that subset: `AgentService.invokeWithUsage(..., toolFilter)` →
  `resolveAgent` pre-filters the manifests. Decision **once, confirmed** (not on every run): predictable, safe,
  cheap.
- ✅ **Outcome delivery to the chat (Option) — DONE.** Beyond the notification, an automation's outcome can be **posted
  in a dedicated chat thread** with an **unread badge** on the sidebar (migration `ScheduledTaskChatDelivery`); the
  `chat` node of Flows enables the same delivery from workflows (`FlowChatDelivery`).
- 🔭 **Other possible future implementations:**
  - **Model A (flow-generation)**: materialize a deterministic Flow for well-defined tasks (today only model B,
    agent re-invocation). Pro: determinism/cost; con: compiling open NL into a valid graph.
  - **Automations in the global dashboard** (today the tokens are per-task, not aggregated in the dashboard): table
    `usage_events` + a UnionView in the `UsageService`.
  - **Outcome delivery via email** (beyond notification and chat).

---

## Running Activity Dashboard

> **Status: DONE.** A **read-only** view that aggregates in one place *everything that is running or scheduled*
> for the user, giving cross-cutting visibility over features that are otherwise scattered (daemons, automations, flows).

- **Backend** `activity/` — `ActivityService.getActivity(userId)` runs in parallel (`Promise.all`) the already
  existing queries and makes them a single snapshot: **skill daemons** in `running`/`starting` (`DaemonsService.findAll`),
  **automations** (`SchedulingService.list`), **flows** with a `cron`/`scheduled` trigger and `enabled`
  (`FlowsService.findAll`), and the **latest 15 runs** of the flows (`FlowRun` repo, ordered by `startedAt`). It reuses the
  existing services — no duplicated business logic. `ActivityController` → `GET /api/activity`.
- **Frontend** — Settings → **Activity**: 4 counters (active daemons, active + pending automations, scheduled
  flows, recent runs) and 4 blocks with empty-state and status badges. **Automatic refetch every 10s**
  (`react-query refetchInterval`).
- **Extendable**: the payload is a single typed snapshot; adding a source (e.g. live team-runs, queued BullMQ jobs)
  means one more query in the `Promise.all` and one block in the UI.

---

## 16. Future Features

| Feature                          | Priority | Notes                                                                                                                                                                                                                                                                                                             |
|----------------------------------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ~~Bridge auto-reconnect config~~ | ✅ Done   | `handleConfig` compares command/args/env and restarts only the changed process (`configEquals`), without restarting the bridge                                                                                                                                                                                    |
| ~~Tool call history / debug~~    | ✅ Done   | Tool calls persisted on `Message.toolCalls` (name/input/output truncated ~8KB/ok/durationMs). Collapsible debug panel in `MessageBubble`. SSE `tool_result` event for the ✓/✗ live status                                                                                                                          |
| ~~Feedback loop 👍👎~~           | ✅ Done   | `message_feedback` + active memory: the feedback with a correction is vectorized in `feedback_memory` and re-injected into the system prompt on similar requests (scope personal/shared with admin approval). Toggle `feedbackMemoryEnabled`                                                                        |
| ~~Persistent user memory~~       | ✅ Done   | `user_memory` (pending/confirmed facts) + per-user toggle `autoMemoryEnabled`. Automatic threshold extraction (global `autoMemoryThreshold`, override `memoryThreshold`) or on-demand; inline confirmation in the chat (SSE `memory_proposal`); confirmed facts injected into the system prompt (user level, cached) |
| ~~Voice input (Whisper)~~        | ✅ Done   | Microphone button in the chat (`MessageInput`): `MediaRecorder` → `POST /api/transcription` (transient audio, never on disk) → text in the textarea, reviewable before sending. Engine = OpenAI-compatible `/v1/audio/transcriptions` endpoint. **Default = internal `whisper-service`** (faster-whisper small, included in Docker, `internal` provider auto-configured via `TRANSCRIPTION_BASE_URL` + `/v1/models` probe); the admin can choose OpenAI/Groq/self-hosted in the `transcription*` fields of `app_config`. Module `transcription/`; global toggle (ON by default) + a UI section next to Embedding; language hint from `i18n.language` |
| ~~Token usage dashboard~~        | ✅ Done   | Module `usage/`: token aggregation per user/project/model + **provider-aware estimated** costs (prices on `llm_configs`, cache computed per provider). Admin sees tokens+costs (`/api/usage`), the user only tokens (`/api/usage/me`). "Usage" section in Settings                                                  |
| ~~Users & Teams management~~     | ✅ Done   | Admin user CRUD + account status (bootstrap 1st admin) · `teams`/`team_memberships` (owner/member) · resource scope **personal\|team\|org** on tool/skill/datasource (`assertCanManage` + `visibilityWhere`). UI: Settings → Users / Teams. See the [dedicated section](#users-teams--scope-management)               |
| ~~Shared projects~~              | ✅ Done   | Projects shareable with **N teams** via the `project_teams` join (roles collaborator/viewer); the project's chats and files visible to all members. See [Collaborative projects](#users-teams--scope-management)                                                                                                     |
| ~~Attach documents to the project~~ | ✅ Done | Project files (`?projectId=`) visible from all the project's chats + RAG filtered by project (`searchScope:auto`)                                                                                                                                                                                                  |
| ~~Shared chats~~                 | ✅ Done   | Shared threads: every project member sees the chats; collaborator/owner write in the same thread (`messages.authorId`), viewer read-only                                                                                                                                                                          |
| ~~Auto-Scheduling (schedule from chat)~~ | ✅ Done | → [dedicated section](#auto-scheduling-design). Built-in tool `schedule_task` + `SchedulingService` (BullMQ), headless runner (model B) + delivery via notification **and chat** (unread badge) + "Automations" UI. Model A (flow-generation) = future extension |
| ~~Running activity ("running" dashboard)~~ | ✅ Done | **Settings → Activity** (`activity/`): active skill daemons, scheduled + pending automations, active cron/scheduled flows, latest 15 runs. Auto-refetch 10s → [Activity Dashboard](#running-activity-dashboard) |
| ~~Flows (deterministic workflows)~~  | ✅ Done (F1-5) | **COMPLETE** (**wave/parallel** DAG engine + canvas; **12 node types** incl. agent/team/loop/join/chat; error-policy/retry; **per-node test run**; manual/cron/scheduled/webhook/chat-as-tool triggers on BullMQ+Redis) → [dedicated section](#flows). Complementary to Multi-Agent (a node can be an agent, an agent can invoke a flow) |
| ~~CRON, one-off activations~~    | ✅ Done   | Merged into the `cron`/`scheduled` triggers of the [Flows](#flows) and into [Auto-Scheduling](#auto-scheduling-design) (BullMQ + Redis)                                                                                                                                                                            |
| ~~Multilingual~~                 | ✅ Done   | **IT + EN** across three axes: frontend UI (react-i18next, ~20 namespaces, 100% coverage), backend errors (nestjs-i18n + global filter `i18n-exception.filter`, 18 per-module namespaces), assistant's response language. Persistence on `User.language`; default = browser auto-detect, fallback `en`. Conventions in `I18N_CONVENTIONS.md`                                                                                       |
| ~~Multi Agent~~                  | ✅ Done   | **Implemented (Level 2)** → [dedicated section](#multi-agent-level-2). Module `agents/`: reusable agents + teams (supervisor/sequential/parallel), `chats.agentTeamId`, Agents/Agent teams UI. Only Option 4 remains (literal StateGraph)                                                                         |

---

## 17. Licenses & Third Parties

### Project license — AGPL-3.0

Copyright © 2026 Andrea Genovese. Single free/open-source license (see [`LICENSING.md`](LICENSING.md)):

- **GNU AGPL-3.0** ([`LICENSE`](../LICENSE)) — free; network copyleft (whoever offers the software over the
  network/SaaS must make the source of their modifications available). Provided "AS IS", without warranties.
- **Contributions** — accepted under the same license (*inbound = outbound*, AGPL-3.0); no CLA required.

### Third parties

The full audit of the dependencies' licenses is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
(Node + Python + ML model attributions, list of packages grouped by license).

### Audit outcome

- **~1375 Node packages** (workspaces `backend`, `frontend`, `bridge`, `executor`) deduplicated by `name@version`.
- Distribution: MIT (~1132), ISC (85), Apache-2.0 (62), BSD-3 (37), BSD-2 (28), plus Unlicense/0BSD/CC0/BlueOak.
- **No strong copyleft (GPL/AGPL/LGPL)** in the distribution.
- Dual-license packages used under the permissive option: `jszip` → MIT, `oracledb` → Apache-2.0.

### Cases requiring attention (compliance)

| Component | License | Note |
|---|---|---|
| `lightningcss` (+ native binary) | MPL-2.0 | Weak *file-level* copyleft; only build tooling (Tailwind/Vite), not modified → no obligation on the code |
| `caniuse-lite` | CC-BY-4.0 | It is a **database** (browserslist at build-time), not code; requires attribution if redistributed |
| Direct Apache-2.0 dependencies | Apache-2.0 | `openai`, `mongodb`, `@qdrant/js-client-rest`, `puppeteer`, `rxjs`, `reflect-metadata`, `xlsx`, `oracledb` → keep the NOTICE in case of redistribution |

### Python services

`embedding-service` and `whisper-service`: all permissive (FastAPI MIT, uvicorn BSD-3,
sentence-transformers Apache-2.0, torch BSD-3, faster-whisper MIT, CTranslate2 MIT).

### ML models (downloaded at runtime, not redistributed)

| Model | Use | License |
|---|---|---|
| `mixedbread-ai/mxbai-embed-large-v1` | Text embedding | Apache-2.0 |
| OpenAI Whisper (via faster-whisper) | Audio transcription | MIT |

Both permissive, commercial use allowed.

> Regenerate the list after dependency updates: `npx license-checker --production` in each workspace.
