# Arkimede — Documento di Contesto Progetto

> **Uso:** Carica questo file nel Progetto claude.ai come contesto fisso.  
> Claude lo userà come riferimento in ogni sessione futura senza doverlo rispiegare.

---

## 1. Overview

**Arkimede** è una piattaforma AI multi-utente che permette di collegare tool HTTP custom, query SQL, tool RAG su
collection vettoriali e server MCP a un agente AI configurabile.

L'utente può:

- Definire **tool custom** (HTTP, SQL, RAG, sub-agent prompt) senza scrivere codice
- Connettere **server MCP** remoti (http/sse) o locali (stdio tramite Electron bridge o direttamente dal backend)
- Configurare il **provider LLM** (Anthropic, OpenAI, Gemini, Ollama, LM Studio, OpenAI-compatible, DeepSeek) e il *
  *vector DB** (Qdrant, PGVector, Chroma, AstraDB) da UI admin — nessun redeploy
- Personalizzare il **system prompt** a **4 livelli**: globale (admin) → utente → progetto → skills (SKILL.md selettivo)
- Ottimizzare il consumo di token con **tool loading strategy**, **max history tokens** e **prompt caching**
- Usare i tool direttamente nella chat con l'agente

Oltre alla chat, la piattaforma offre **quattro pilastri** integrati a 360° (vedi sezioni dedicate):

- **Flows** — workflow **deterministici** a blocchi (canvas React Flow): grafo DAG con esecuzione **parallela**, 12 tipi
  di nodo (tool/llm/condition/http/skill/transform/flow/agent/team/loop/join/chat), error-policy/retry, **test run
  per-nodo** (subgraph), e trigger **manual/cron/scheduled/webhook/chat-as-tool** su BullMQ+Redis. *(→ [Flows](#flows))*
- **Multi-Agent** — l'utente definisce **agenti** (prompt + modello + filtro tool) e li compone in **team** con
  topologia **supervisor / sequential / parallel**; una chat può girare con un team. *(→ [Multi-Agent](#multi-agent-design--livello-2))*
- **Auto-Scheduling** — programmare automazioni **dalla chat** ("ogni mattina alle 8 controlla la mail e riassumi"): un
  built-in tool prepara l'automazione, l'utente conferma, e al fire un runner headless ri-esegue l'agente e notifica
  l'esito. *(→ [Auto-Scheduling](#auto-scheduling-design))*
- **Integrazione** — i flow sono tool dell'agente e possono invocare agenti/team; gli agenti possono invocare flow; le
  automazioni possono eseguire un team. Tutto condivide il runtime LangGraph e lo scheduler BullMQ.

---

## Gestione Utenti, Team & Scope

Piattaforma **multi-tenant collaborativa**: un'organizzazione (l'installazione) con utenti, ruoli e team.

**Ruoli & account**

- `role`: **admin** (gestione) | **user**. Il **primo utente registrato diventa admin** (bootstrap); gli altri sono user
  finché un admin non li promuove.
- `status`: **active** | **disabled**. Login bloccato se disabled; `jwt.strategy` ricarica l'utente da DB ad ogni
  richiesta → disabilitazione e cambi ruolo hanno **effetto immediato**.
- CRUD admin in `/api/admin/users` (UI: Impostazioni → Utenti). Protezioni: mai rimuovere/disabilitare/eliminare l'*
  *ultimo admin attivo**; no azioni distruttive su sé stessi.

**Team**

- Gruppi di utenti (`teams` + `team_memberships`, ruolo **owner**|**member**). UI: Impostazioni → Team.
  `GET /api/teams/mine` alimenta i selettori di scope.

**Scope delle risorse (`personal | team | org`)** — su **custom tools, skills, data sources**:

| Scope      | Chi la vede/usa        | Chi la gestisce            |
|------------|------------------------|----------------------------|
| `personal` | solo il creatore       | il creatore                |
| `team`     | i membri del team      | **admin o owner del team** |
| `org`      | tutta l'organizzazione | **admin**                  |

- Lo scope **determina cosa l'agente carica per ciascun utente** (personali + del proprio team + org).
- **Skill**: `team` = pubblicazione diretta dell'owner ai membri (no review); `org` = invio in review e **approvazione
  admin** (`isApproved`).
- Visibilità **per-appartenenza anche per gli admin**: un admin non membro di un team non vede quelle risorse in
  lista/agente, ma le gestisce per id / dalla UI Team. (Modificabile in `visibilityWhere`.)

> Significato collaborativo: **org** = strumenti/connettori standard e fidati per tutta l'azienda (curati dagli admin);
**team** = strumenti e dati di un reparto, gestiti in autonomia dai suoi owner; **personal** = sperimentazione
> individuale. Garantisce niente duplicazione, standardizzazione, riservatezza per reparto e delega senza colli di
> bottiglia.

**Progetti collaborativi (multi-team)**

Mentre le *risorse* (tool/skill/data source) restano single-team, i **progetti** — l'unità di lavoro (chat + file +
contesto) — sono condivisibili con **più team** (es. *architetti* e poi *commerciale* sullo stesso progetto).

- Tabella di join `project_teams (projectId, teamId, role)` con ruolo **collaborator** | **viewer**. Un progetto può
  essere assegnato a N team; aggiungere/togliere un team è una riga in/out (fasatura nel tempo gratuita).
- `projects.userId` = **owner** (nullable, `ON DELETE SET NULL`): se l'utente viene eliminato il progetto del team
  sopravvive (riassegnabile), non sparisce.
- **Visibilità progetto**: owner **oppure** membro di un team assegnato (`ProjectsService.accessLevel` →
  owner|collaborator|viewer|null). A cascata, **chat e file** del progetto diventano visibili a tutti i membri.
- **Gestione** (impostazioni + assegnazione team): **solo owner o admin** (`assertCanManage`). UI: modale progetto →
  "Condivisione con i team" (+ eliminazione progetto).
- **Chat condivise (thread)**: ogni membro vede le chat del progetto; **collaborator/owner possono scrivere** nello
  stesso thread, **viewer in sola lettura** (`messages.authorId` traccia chi ha scritto ogni turno;
  `ChatsService.findOneForWrite`). Rinomina/elimina chat = autore.
- **File**: caricabili dai collaboratori (i viewer no), visibili/scaricabili da tutti i membri
  (`FilesService.findByProject` / `findOneReadable`).

---

## 2. Architettura Generale

```
[Browser]
    │
    ├── React SPA (Vite + Tailwind) ─────────────────────────┐
    │   JWT auth · SSE streaming · upload file · settings    │
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
    │         remoti      │
    │                     ▼
    │              Electron Bridge  ◄────────────────────────┘
    │              ├─ BridgeManager (Socket.io client)
    │              └─ McpProcess (child_process stdio)
    │
    └── EmbedModule → VectorStoreProviderService → Qdrant/PGVector/Chroma/AstraDB
```

### 2.1 Topologia dei container (Docker)

Connessioni di rete e scambio dati tra i container. In **produzione** solo `frontend` (5173) e `backend` (3000) sono esposti all'host; tutto il resto comunica per nome di servizio sulla rete interna. `skill-executor`, `broker` e i `container-job` sono attivi/blindati con gli overlay `egress` (C1) e `broker` (D2).

```mermaid
flowchart TB
    user([Browser / Utente])
    bridge["Electron Bridge<br/>(macchina utente · non è un container)"]
    NET(("Internet<br/>domini allowlisted"))

    subgraph host["Host Docker"]
      direction TB
      subgraph appnet["rete applicativa (servizi interni)"]
        FE["<b>frontend</b><br/>React SPA + nginx · :5173<br/><i>serve la UI</i>"]
        BE["<b>backend</b><br/>NestJS + LangGraph · :3000<br/><i>API, agente, orchestrazione</i>"]
        PG[("<b>postgres</b><br/><i>DB applicativo</i>")]
        QD[("<b>qdrant</b><br/><i>vector DB / RAG</i>")]
        RD[("<b>redis</b><br/><i>coda BullMQ</i>")]
        EM["<b>embedding</b><br/>FastAPI<br/><i>genera i vettori</i>"]
      end
      subgraph sandbox["sandboxnet — interna, senza gateway (overlay egress/broker)"]
        EX["<b>skill-executor</b><br/>Fastify sidecar<br/><i>install/run skill, daemon</i>"]
        BK["<b>broker</b><br/>job-launcher<br/><i>unico col socket Docker</i>"]
        JOB["<b>container-job</b><br/>effimero, 1 per esecuzione<br/><i>esegue lo script skill, blindato</i>"]
      end
      PROXY["<b>egress-proxy</b><br/>squid<br/><i>allowlist domini (C1)</i>"]
    end

    user -- "HTTPS · SPA" --> FE
    user -- "REST + SSE /api/*" --> BE
    FE -. "proxy /api" .-> BE
    bridge -. "WebSocket /mcp-bridge<br/>(MCP transport remote)" .-> BE

    BE -- "SQL · TypeORM" --> PG
    BE -- "search / upsert vettori" --> QD
    BE -- "job Flows + scheduling" --> RD
    BE -- "POST /v1/embeddings" --> EM
    BE -- "POST /install · /execute · /daemon<br/>(rete interna, nessuna porta host)" --> EX

    EX -- "/internal/* : save-config,<br/>files/search, datasource, vector<br/>(x-internal-token firmato)" --> BE
    EX -- "POST /run-job (D2)" --> BK
    BK -- "docker run (socket host)" --> JOB
    JOB -- "/internal/* (NO_PROXY)" --> BE
    JOB -- "egress dichiarato in SKILL.md runtime.network" --> PROXY
    PROXY -- "solo domini consentiti" --> NET
```

**A cosa serve ogni container**

| Container | Ruolo | Parla con | Esposto all'host (prod) |
|---|---|---|---|
| **frontend** | SPA React (UI), nginx serve i file statici | backend (`/api`) | ✅ `:5173` |
| **backend** | API REST/SSE, agente LangGraph, orchestrazione, auth | postgres, qdrant, redis, embedding, skill-executor | ✅ `:3000` |
| **postgres** | DB applicativo (utenti, chat, tool, skill, flow, audit…) | backend | ❌ (solo dev) |
| **qdrant** | Vector DB per il RAG | backend | ❌ (solo dev) |
| **redis** | Coda BullMQ: trigger cron/scheduled di Flows e Auto-Scheduling | backend | ❌ (solo dev) |
| **embedding** | Microservizio FastAPI che calcola gli embedding (modello interno di default, OpenAI-compatibile) | backend | ❌ (solo dev) |
| **whisper** | Microservizio FastAPI di trascrizione vocale (faster-whisper, OpenAI-compatibile `/v1/audio/transcriptions`); default interno per l'input vocale | backend | ❌ (solo dev) |
| **skill-executor** | Sidecar che installa/esegue le skill (Python/Node/JS), gestisce i daemon | backend (HTTP interno) ↔ broker | ❌ mai |
| **broker** *(D2)* | Unico detentore del socket Docker: lancia i container-job blindati via API stretta `/run-job` | skill-executor → daemon Docker | ❌ mai |
| **container-job** *(D2)* | Container effimero (uno per esecuzione skill): cap-drop, read-only, uid non-root, rete per-job | backend (`/internal/*`), egress-proxy | ❌ effimero |
| **egress-proxy** *(C1)* | Proxy squid con allowlist: unica via verso internet per le skill | container-job / skill-executor → internet | ❌ mai |

> **Confini di fiducia:** il `backend` è *trusted ma esposto* e non tocca mai il socket Docker; la capability "host-root" (socket) vive **solo** nel `broker`. Le skill (codice di terze parti) girano nei `container-job` su `sandboxnet` (rete interna senza gateway) e raggiungono internet **solo** attraverso l'`egress-proxy` sui domini dichiarati in `SKILL.md` (runtime.network).

> **Sandbox (tool `run_in_sandbox`):** capability di esecuzione codice/shell **arbitrari** scritti dall'agente, sullo stesso motore broker (container-job blindato) ma con **workspace persistente per-chat** (`/workspace`, montato scrivibile). Modello a 3 livelli di rete (`none`/`egress`/`open`), **gating** admin (flag globale + allowlist team/progetti) e **fail-closed** senza broker. È anche il runtime delle **skill descrittive** (formato agentskills.io puro). A differenza delle skill — codice revisionato con fallback in-process — il sandbox **non** esegue mai in-process se non con opt-in esplicito di sviluppo. Vedi la guida Skills.

---

## 3. Stack Tecnologico

| Layer              | Tecnologia                                     | Note                                                                          |
|--------------------|------------------------------------------------|-------------------------------------------------------------------------------|
| Backend API        | NestJS 10 (TypeScript)                         | Architettura modulare, JWT, SSE streaming                                     |
| Orchestrazione AI  | LangChain.js + LangGraph                       | ReAct agent, tool routing, streaming                                          |
| LLM                | Configurabile da UI admin                      | Anthropic, OpenAI, Gemini, Ollama, LM Studio, OpenAI-compatible, DeepSeek     |
| Frontend           | React 18 + Vite + Tailwind CSS                 | Zustand state, @tanstack/react-query                                          |
| DB applicativo     | PostgreSQL + TypeORM                           | Utenti, chat, messaggi, file, tool, MCP, config, datasources, skills, daemons |
| Vector DB          | Qdrant (default) / PGVector / Chroma / AstraDB | Configurabile via UI, provider-agnostico                                      |
| Desktop bridge     | Electron (electron-vite)                       | Spawn processi MCP stdio locali (transport `remote`)                          |
| Skill executor     | Node.js + Fastify (sidecar Docker)             | Runner Python/Node/JS-sandbox, Nix deps, API interna, daemon manager          |
| Isolamento skill   | Broker container-per-job + egress-proxy (squid) | D2: cap-drop/read-only/uid-non-root, gVisor opzionale; C1: egress allowlist `network:`        |
| Containerizzazione | Docker Compose                                 | base sicuro + overlay `egress`/`broker`; postgres·qdrant·redis·embedding·skill-executor·backend·frontend |

---

## 4. Struttura del Progetto

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
│   │   │   ├── llm-config.entity.ts      # Config LLM multi-record (llm_configs): isDefault + isSummarizer
│   │   │   ├── llm-configs.service.ts    # CRUD + setDefault/setSummarizer + buildModelForConfig(entity, overrides)
│   │   │   └── llm-configs.controller.ts
│   │   ├── app-config/
│   │   │   ├── app-config.entity.ts      # Tabella singleton app_config (id=1)
│   │   │   ├── app-config.service.ts     # CRUD config + cache in-memory
│   │   │   ├── app-config.controller.ts
│   │   │   ├── app-config.module.ts
│   │   │   └── llm-provider.service.ts   # Factory LLM multi-provider con cache + DeepSeek SSE interceptor
│   │   ├── custom-tools/
│   │   │   ├── custom-tool.entity.ts     # Entità PostgreSQL (custom_tools)
│   │   │   ├── custom-tool.types.ts      # ToolParameter, ExecutorConfig (http/sql/prompt/rag)
│   │   │   ├── custom-tool.factory.ts    # buildDynamicTool() → DynamicStructuredTool
│   │   │   ├── custom-tools.service.ts   # CRUD + loadToolsForUser()
│   │   │   ├── custom-tools.controller.ts
│   │   │   ├── tool-secret.entity.ts     # Segreti cifrati (tool_secrets)
│   │   │   └── crypto.utils.ts           # AES-256-CBC encrypt/decrypt
│   │   ├── datasources/
│   │   │   ├── datasource.entity.ts      # Sorgenti dati esterne (data_sources)
│   │   │   ├── datasources.service.ts    # CRUD + connessione MySQL/PostgreSQL runtime
│   │   │   ├── datasources.controller.ts
│   │   │   └── datasources.module.ts
│   │   ├── mcp-servers/
│   │   │   ├── mcp-server.entity.ts      # Entità PostgreSQL (mcp_servers)
│   │   │   ├── mcp-servers.service.ts    # CRUD + loadToolsForUser()
│   │   │   ├── mcp-servers.controller.ts
│   │   │   ├── mcp-bridge.gateway.ts     # WebSocket gateway (Socket.io /mcp-bridge)
│   │   │   ├── local-mcp-process.ts      # Spawn stdio diretto (transport local)
│   │   │   ├── mcp-servers.module.ts
│   │   │   └── mcp-server-secret.entity.ts
│   │   ├── vector-db/
│   │   │   ├── vector-db-config.entity.ts  # Singleton config vector DB (id=1)
│   │   │   ├── vector-collection.entity.ts # Collection gestite
│   │   │   ├── vector-db.service.ts        # CRUD collection + orchestrazione
│   │   │   ├── vector-db.controller.ts
│   │   │   ├── vector-db.module.ts
│   │   │   ├── vector-store.types.ts       # Interfaccia VectorStoreAdapter
│   │   │   ├── vector-store-provider.service.ts  # Factory adapter (Qdrant/PGVector/Chroma/Astra)
│   │   │   └── adapters/                   # Implementazioni provider
│   │   ├── embed/
│   │   │   ├── embed.service.ts
│   │   │   ├── embed.controller.ts
│   │   │   ├── embed.module.ts
│   │   │   ├── ingest.service.ts           # Chunking → VectorStore
│   │   │   └── embedding.provider.service.ts  # internal(default)/lmstudio/voyage/openai/ollama/openai-compatible
│   │   ├── auth/                           # JWT auth (login, register, guard)
│   │   ├── users/
│   │   ├── projects/                       # Progetti (raggruppano chat + file + systemPrompt)
│   │   ├── chats/
│   │   ├── messages/                       # SSE streaming: chunk / tool_call / file / usage / done
│   │   │   └── messages.controller.ts      # onToolResult → eventi 'file' per path prodotti dai tool
│   │   ├── files/                          # Upload + parsing PDF/Word/Excel + download ?rel=
│   │   ├── skills/                         # Package ZIP eseguibili: upload, install, scope, review, registry
│   │   │   ├── skills.service.ts           # CRUD + buildSkillSystemPromptSelective() + enabled filter
│   │   │   ├── skill-tool.factory.ts       # DynamicStructuredTool per ogni script skill
│   │   │   ├── skill-executor.client.ts    # HTTP client verso il sidecar executor
│   │   │   ├── registry.service.ts         # Fetch + cache registry GitHub (TTL, stale fallback)
│   │   │   └── internal-skills.controller.ts # POST /internal/skills/:id/save-config (InternalApiKeyGuard)
│   │   ├── daemons/                        # Processi daemon long-running per le skill
│   │   │   ├── daemons.service.ts          # start/stop/restart + onModuleInit auto-ripristino
│   │   │   ├── daemons.controller.ts       # REST /api/daemons
│   │   │   └── internal-daemons.controller.ts  # POST /internal/daemons/events
│   │   ├── notifications/                  # Socket.IO /notifications → emitToUser(userId)
│   │   ├── common/                         # Guard, decorator, interceptor condivisi
│   │   │   └── guards/internal-api-key.guard.ts  # Autenticazione servizio-a-servizio
│   │   ├── config/                         # app.config.ts (APP_NAME)
│   │   ├── database/
│   │   │   ├── data-source.ts              # TypeORM DataSource config
│   │   │   └── migrations/                 # ~52 migration files sequenziali
│   │   └── prompts/
│   │       └── system.prompt.ts            # System prompt di default (seed DB)
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
│   │   └── renderer/                       # UI bridge (React)
│   ├── resources/                          # Icone app
│   ├── electron-builder.yml
│   └── package.json
├── frontend/
│   └── src/
│       ├── api/           # axios client + api per ogni modulo
│       ├── store/         # Zustand (chat, auth, activeView)
│       ├── pages/
│       │   ├── DashboardPage.tsx
│       │   ├── LoginPage.tsx / RegisterPage.tsx
│       │   ├── SettingsPage.tsx      # Settings multi-sezione con nav laterale
│       │   ├── ToolsPage.tsx         # CRUD custom tool (sezione embeddabile)
│       │   ├── McpServersPage.tsx    # CRUD MCP server (sezione embeddabile)
│       │   └── DataSourcesPage.tsx   # CRUD data source (sezione embeddabile)
│       └── components/    # Sidebar · ChatWindow · MessageBubble · FilePanel
├── executor/                       # Skill executor sidecar (Fastify, porta 4000 interna)
│   └── src/
│       ├── main.ts                 # Fastify API: POST /install, POST /execute, daemon endpoints
│       ├── install.ts              # pip + npm + nix install isolato per skill
│       ├── daemon-manager.ts       # Map<daemonId, ChildProcess>: start/stop/list/status
│       └── runners/
│           ├── python.runner.ts    # subprocess python3 + PYTHONPATH .deps/python
│           ├── node.runner.ts      # subprocess node + NODE_PATH .deps/node/node_modules
│           ├── js.runner.ts        # isolated-vm V8 sandbox (globali input, config)
│           └── broker.runner.ts    # D2: esegue la skill come container-job via broker
├── broker/                         # Job-launcher broker (D2) — unico col socket Docker
├── runner/                         # Immagine pa-runner dei container-job (node+python3, uid 999)
├── egress-proxy/                   # squid.conf — allowlist egress (C1)
├── embedding-service/              # Microservizio embedding (FastAPI) — modello interno di default
├── whisper-service/                # Microservizio trascrizione (FastAPI + faster-whisper) — Whisper interno di default
├── docker-compose.yml              # base sicuro (postgres·qdrant·redis·embedding·whisper·skill-executor·backend·frontend)
├── docker-compose.override.yml     # dev: riespone le porte host
├── docker-compose.egress.yml       # overlay C1: egress allowlist
├── docker-compose.broker.yml       # overlay D2: container-per-job
└── .env                            # UNICO: Docker + dev non-Docker (backend lo legge da ../.env)
```

---

## 5. Custom Tools

Tool definiti dall'utente salvati in PostgreSQL e costruiti come `DynamicStructuredTool` LangChain a ogni richiesta.

### Executor types

| Tipo     | Cosa fa                                                                                                                                     | Stato          |
|----------|---------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| `http`   | Chiama endpoint REST esterno. Supporta `{{secret.KEY}}` e `{{env.VAR}}` in URL, headers, body                                               | ✅ Implementato |
| `sql`    | Esegue query SELECT su DB esterno (DataSource). Modalità template `:param` o free Text-to-SQL                                               | ✅ Implementato |
| `rag`    | Ricerca semantica su collection vettoriale. Usa EmbeddingProviderService + VectorStoreAdapter                                               | ✅ Implementato |
| `prompt` | Sub-agent LLM: system/user prompt custom interpolati, modello (LlmConfig) e maxTokens/temperature configurabili → sub-chiamata LLM separata | ✅ Implementato |

### Interpolazione template (executor HTTP)

- `{{paramName}}` → valore passato dal LLM
- `{{secret.MY_KEY}}` → segreto decifrato dalla tabella `tool_secrets`
- `{{env.MY_VAR}}` → variabile d'ambiente del processo NestJS

### Executor SQL — due modalità

**Mode A — Template parametrizzato:**

```sql
SELECT nome, email
FROM clienti
WHERE regione = :regione
```

I parametri `:name` vengono bindati in sicurezza (no SQL injection).

**Mode B — Free query / Text-to-SQL:**

- Il LLM compila il parametro `queryParam` con una SELECT libera
- Il tool valida che sia SELECT-only e aggiunge LIMIT prima di eseguire
- Se il parametro è assente, restituisce lo schema (prefetch tabelle/colonne)

#### Iniezione schema — modello unificato

Due assi **ortogonali** governano cosa riceve il LLM in Mode B:

- **Fonte (automatica):** se la DataSource ha un **manifest** curato (`schemaManifest`, prodotto da *Introspetti* + cura manuale/AI) lo schema viene da lì, rispettando tabelle (`deny`) e campi (`hidden`) nascosti; altrimenti **live** dal DB.
- **Verbosità (per-tool, `schemaMode`):**
  - **compact** — 1ª chiamata: lista tabelle + relazioni → il LLM sceglie → 2ª chiamata `describe_tables: [...]` (colonne + commenti + FK delle sole tabelle scelte) → query.
  - **full** — schema completo (tutte le colonne, FK inline, relazioni "referenziata da") subito.

`schemaHints` non è più lo schema: è un canale di **note/istruzioni libere** iniettate come blocco `[Note]`. Le vecchie checkbox di pre-fetch live confluiscono nel selettore compact/full. Pulsante **"Cancella introspezione"** (`DELETE /api/data-sources/:id/manifest`) svuota il manifest → ritorno al live. Render: `renderManifestCompact` / `renderManifestFull` / `renderManifestColumns` in `datasources/schema-manifest.types.ts`.

### Executor RAG

Due modalità (`mode`): `search` (default) e `index`.

```typescript
interface RagExecutorConfig {
    mode?: 'search' | 'index';
    collection: string;       // Collection vettoriale (deve esistere)
    // search:
    limit?: number;           // Chunk restituiti (default 5)
    searchScope?: 'auto' | 'universal' | 'all';  // visibilità (default 'auto', opzionale)
    // index:
    indexScope?: 'universal' | 'project' | 'personal';  // scope dei doc indicizzati (opzionale; default dal contesto)
    textParam?: string;       // param tool col testo da indicizzare (default 'text')
    fileIdParam?: string;     // param tool con fileId → estrazione nativa (pdf/docx/xlsx/OCR), ha precedenza
    metadataParams?: string[];// param tool extra salvati nel payload del vettore
}
```

**Scope del documento & visibilità dinamica.** Lo scope è una proprietà del **documento** (scelta all'embed:
`universal | project | personal`), salvata nel payload del vettore (`scope`, `userId`, `projectId`). La ricerca filtra
**dinamicamente in base al contesto** della chat, senza bisogno di un tool per progetto:

| `searchScope` | Cosa ritorna |
|---|---|
| `auto` (default) | unione di **universali ∪ personali-dell'utente ∪ del progetto della chat corrente** |
| `universal` | solo documenti universali (tool "base aziendale") |
| `all` | tutta la collection, nessun filtro (cross-progetto / admin) |

Il filtro è **nativo sul vector DB**: poiché gli adapter (Qdrant/PgVector/Chroma/AstraDB) supportano solo AND-equality,
`auto` esegue una query per scope (`{scope}`, `{scope,userId}`, `{scope,projectId}`) e ne fa l'unione
(`mergeSearchHits`: dedup per id + re-rank per score + taglio al `limit`) → niente degrado di recall. In `index`, lo
scope dei nuovi documenti è `indexScope` o, se omesso, derivato dal contesto (progetto della chat se presente,
altrimenti personale). L'embed manuale (`POST /api/embed/:fileId`) richiede lo `scope` (UI: selettore in FilePanel /
MessageInput / file manager).

### Executor Prompt (sub-agent)

```typescript
interface PromptExecutorConfig {
    systemPrompt: string;        // interpola {{param}}/{{secret.KEY}}/{{env.VAR}}
    userPromptTemplate?: string; // se omesso → args serializzati come JSON
    llmConfigId?: string;        // LlmConfig da usare (omesso = predefinito)
    maxTokens?: number;          // default 1024 — override sul LlmConfig
    temperature?: number;        // default 0 (deterministico)
}
```

`buildPromptContext.callLlm` risolve il LlmConfig, costruisce il modello con
`buildModelForConfig(entity, { maxTokens, temperature })` e invoca system+user; la risposta torna come tool result al
main agent.

### Scope (`personal | team | org`)

- `personal` — visibile/usabile solo dal creatore
- `team` — visibile/usabile dai membri del team `teamId`; gestione da **admin o owner del team**; nome unico per-team
- `org` — visibile/usabile da tutta l'organizzazione; gestione riservata agli **admin**; nome globalmente unico

Autorizzazione gestione (create/update/delete) centralizzata nel controller (`assertCanManage`): personal=owner,
org=admin, team=admin-o-owner. Il service usa lookup per-id (l'ownership non è più un vincolo del service). Stesso
modello su **custom tools, skills, data sources**.

### Logica caricamento per l'agente

```
loadToolsForUser(userId, projectId?):
  teamIds = teamIdsForUser(userId)
  candidati = visibilityWhere: { userId } ∪ { scope:'org' } ∪ { scope:'team', teamId ∈ teamIds }
  dedup per nome con precedenza personal > team > org
  → buildDynamicTool(..., projectId) per ciascuno (segreti decifrati, DataSource risolta)
    # projectId (= progetto della chat) alimenta il filtro RAG dinamico 'auto'
```

> Visibilità (e tool caricati dall'agente) **per-appartenenza anche per gli admin**: un admin non membro di un team non
> vede quelle risorse in lista, ma le gestisce per id / dalla UI Team.

### Delega gerarchica — `exposeAsTool` + `loadOnFirst`

Due assi **ortogonali** che permettono di non iniettare tutti i tool nel primo contesto della chat e di incapsularli dietro agli agenti (pattern *agent-as-tool*).

**`exposeAsTool`** (su agente / team — i Flow lo avevano già come *chat-as-tool*): se attivo, la risorsa viene avvolta in un `DynamicStructuredTool` ed esposta accanto agli altri tool. Il modello principale la vede come `agent_<slug>` / `team_<slug>` e le **delega** un task; i tool interni dell'agente NON entrano nel contesto del chiamante. Implementato in `MultiAgentService.loadToolsForUser` → `buildAgentTool` / `buildTeamTool`, agganciato in `AgentService.resolveAgent`.

**`loadOnFirst`** (su custom tool / flow / skill / mcp server, default `true`): decide se quel tool entra nel contesto *flat* della chat. A `false` sparisce dalla chat ma resta usabile da un agente che lo include nel `toolFilter`.

I due si combinano via il parametro **`flatOnly`** dei loader:

```
loadToolsForUser(userId, projectId, { flatOnly: true })   # chat principale
  → WHERE ... AND loadOnFirst = true        # solo i tool del contesto flat

loadToolsForUser(userId, projectId)                        # percorso per-agente
  → nessun filtro su loadOnFirst            # l'agente vede TUTTI i suoi tool
```

> `loadOnFirst` = configurazione del tool ("voglio stare in chat?"); `flatOnly` = intento del chiamante ("mi servono solo i tool flat?"). Il loader fa il match. Così un tool `loadOnFirst=false` è invisibile in chat ma l'agente che lo incapsula lo carica comunque → meno token nel primo contesto, perimetro netto, routing più affidabile.

Regressione: `backend/test/integration/load-on-first.integration.spec.ts` (testcontainers).

---

## 6. Data Sources

Sorgenti dati esterne configurate una volta e riutilizzate da più SQL tool.

```typescript
interface DataSourceEntity {
    id: string;
    name: string;
    description: string | null;
    encryptedConnectionString: string; // AES-256-CBC, mai esposto in API
    schemaHints: string | null;        // Note/istruzioni libere sul DB → iniettate come blocco [Note] (NON lo schema)
    prefetchRelations: boolean;        // Auto-rileva FK dichiarate (KEY_COLUMN_USAGE) durante Introspetti / live
    schemaManifest: SchemaManifest | null; // Schema curato (Introspetti + AI + edit): tabelle/colonne/commenti/relazioni
    scope: 'personal' | 'team' | 'org';
    teamId: string | null;             // valorizzato solo se scope='team'
}
```

**Schema arricchito (`schemaManifest`)** — fonte di verità dello schema quando presente:
- `Introspetti` (`POST :id/introspect`) → bozza dal DB live (commenti + FK dichiarate), merge non distruttivo
- `Genera con AI` (`POST :id/enrich`) → modello summarizer riempie i commenti vuoti + infera relazioni implicite
- L'utente cura: relazioni, tabelle (`deny` = nascosta + bloccata nel guard SQL, `comment`), **campi** (`deny` per colonna = stesso comportamento: nascosta + bloccata nel guard best-effort — referenza esplicita + rifiuto `SELECT *`/`tab.*`; per segreti veri → restrizione DB — più `comment`)
- `Cancella introspezione` (`DELETE :id/manifest`) → svuota il manifest → i tool SQL tornano allo schema **live**

**Multi-engine (engine → famiglia):** ogni DataSource ha un campo `engine` esplicito (non
più inferito dalla connection string), che appartiene a una **famiglia** (`relational` |
`document` | `keyvalue` | `fileshare`) — vedi `datasources/engine.types.ts`. Il layer DataSource (CRUD,
cifratura, **Test connessione**: `POST /data-sources/test` e `:id/test`, introspezione,
manifest editabile con `deny`) è unificato; il layer di interrogazione diverge per famiglia.

- **relational** (`SqlDriver`, `datasources/drivers/`): postgres, mysql, mariadb, mssql,
  oracle, sqlite. Tool `sql` (text-to-SQL / template). Aggiungere un DBMS = un file driver.
- **document** (`datasources/mongo/`): mongodb. Tool `mongo` (find/aggregate, template o
  free-query JSON). Introspezione a campionamento → manifest collezioni/campi.
- **keyvalue** (`datasources/redis/`): redis. Tool `redis` (comandi whitelisted, template o
  free-command). Introspezione a campionamento del keyspace → manifest pattern di chiavi.
- **fileshare** (`datasources/fileshare/`): smb/sftp/webdav. Niente schema; operazioni
  file `list/read/write/delete` via spec `file` sull'endpoint interno datasource (campo
  `file`), usate dalla skill `file-share`. Guardia anti path-traversal + cap read 10MB.

I tool NoSQL sono read-only di default (scrittura opt-in con confirm). I driver pesanti
(`mssql`, `oracledb`, `better-sqlite3`, `mongodb`, `ioredis`, e `@marsaud/smb2`,
`ssh2-sftp-client`, `webdav` per le file-share) sono caricati lazy: se il modulo non è
installato, l'engine dà un errore chiaro senza far cadere l'app.

**Formati connection string per engine:** `postgresql://…` · `mysql://…` · `mariadb://…` ·
`mssql://…` (o `Server=…;Database=…`) · `oracle://host:1521/service` · `sqlite:///path.db` ·
`mongodb://host:27017/db` · `redis://:password@host:6379/0` · `smb://[DOM;]user:pass@host/share[/dir]` ·
`sftp://user:pass@host:22[/dir]` · `webdavs://user:pass@host[/dir]`.

---

## 7. MCP Servers

Server MCP configurati dall'utente, convertiti in `DynamicStructuredTool` LangChain.

### Transport types

| Transport | Chi spawna il processo                             | Quando usarlo                                 |
|-----------|----------------------------------------------------|-----------------------------------------------|
| `http`    | — (server remoto già in ascolto)                   | Server MCP remoto raggiungibile via HTTP      |
| `sse`     | — (server remoto già in ascolto)                   | Come http ma con risposta SSE                 |
| `local`   | **Backend NestJS** (direttamente, `child_process`) | Backend e programma sulla **stessa macchina** |
| `remote`  | **Bridge Electron** (sulla macchina dell'utente)   | Backend e programma su **macchine diverse**   |

### Flusso transport `local` (diretto)

```
NestJS McpServersService
  └─ LocalMcpProcess (child_process.spawn)
       ├─ stdin/stdout JSON-RPC
       ├─ initialize → tools/list → cache tools
       ├─ auto-restart in caso di crash (backoff 5s)
       └─ callTool(name, args) → risultato stringa
```

### Flusso transport `remote` (bridge Electron)

```
1. Electron Bridge apre Socket.io verso /mcp-bridge (JWT auth)
2. Backend invia config: { servers: [{ id, name, command, args, env }] }
3. Bridge spawna il processo (npx, python, ecc.) → JSON-RPC stdio
4. Bridge esegue initialize + tools/list → invia tools:register al backend
5. McpBridgeGateway aggiorna bridgeTools[userId][serverId]
6. Quando l'agente chiama un tool:
   backend → tool:call (WebSocket) → bridge → JSON-RPC stdio → bridge → tool:result → backend
```

### Tool naming

`mcp_{server_name_snake}_{tool_name}` — es. `mcp_filesystem_read_file`

---

## 8. Agent ReAct (`agent.service.ts`)

```typescript
// Al boot: nessun tool built-in (recommend/completeness/pdf-gen rimossi)
onModuleInit()
{
    builtInTools = []
    // RAG → custom tool type 'rag' | SQL → custom tool type 'sql' | PDF/altro → skill
}

// Per ogni richiesta: resolve agent in due fasi
resolveAgent(userId, projectId, userInput, history, chatId)
:

// ── Fase 1 (parallelo) ─────────────────────────────────────────────────────
[basePrompt, model, customTools, mcpTools, skillTools,
    user, project, globalToolConfig, provider] = await Promise.all([...])

effectiveConfig = {
    strategy: user?.toolLoadingStrategy ?? globalToolConfig.toolLoadingStrategy,
    maxTools: user?.toolLoadingMaxTools ?? globalToolConfig.toolLoadingMaxTools,
    schemaFormat: user?.toolSchemaFormat ?? globalToolConfig.toolSchemaFormat,
}
effectiveMaxHistoryTokens = user?.maxHistoryTokens ?? globalToolConfig.maxHistoryTokens

// ── History compaction (rolling summary persistito sul Chat) ───────────────
// No-op se toggle off o senza chatId. Oltre soglia: riassume i turni vecchi.
{
    summary, effectiveHistory
}
= await compactHistory(chatId, history, effectiveMaxHistoryTokens,
    historyCompactionEnabled, historyCompactionThreshold)

// ── Fase 2 (seriale) ───────────────────────────────────────────────────────
// 2a. ToolSelectionService: selezione semantica / keyword / inject-all
optimizedExtraTools = await toolSelection.applyStrategy(allExtraManifests, userInput, effectiveConfig)

// 2b. SKILL.md selettivo: solo per le skill con tool selezionati
selectedToolNames = new Set(optimizedExtraTools.map(t => t.name))
skillsPrompt = await skillsService.buildSkillSystemPromptSelective(userId, projectId, selectedToolNames)

// ── System prompt 4 livelli (+ blocco summary cross-provider) ──────────────
systemPrompt = buildSystemPrompt(basePrompt, user.systemPrompt, project.systemPrompt, skillsPrompt)
// summary (se presente) aggiunto come blocco separato e NON cacheato

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

**System prompt a 4 livelli** (il più specifico va per ultimo):

1. `basePrompt` — identità globale (da DB `app_config`, modificabile admin senza redeploy)
2. `user.systemPrompt` — preferenze utente (es. "rispondimi in modo conciso").
   Allo stesso livello (cacheato) si aggiunge il blocco **memoria utente persistente** (fatti `user_memory` confermati),
   se `autoMemoryEnabled`
3. `project.systemPrompt` — contesto specifico del progetto (es. "cliente Acme, budget 180k€")
4. `skillsPrompt` — metadati e SKILL.md delle skill selezionate (caricamento selettivo)

**Tool Loading Strategy** (`ToolSelectionService`):

Due assi ortogonali — *quali* tool caricare (`toolLoadingStrategy`) e *come* descriverli (`toolSchemaFormat`):

- `strategy`:
  - `top_k_rag` — seleziona i `maxTools` tool più rilevanti per similarità semantica (embedding query↔tool)
  - `always_inject_all` — tutti i tool sempre; SKILL.md sempre completo
  - `auto` — `always_inject_all` se n_tool ≤ `maxTools`, altrimenti `top_k_rag`
- `schemaFormat`:
  - `full` — schema tool completo + SKILL.md pre-caricate nel system prompt
  - `compressed` — schema tool sfoltito (~-25%)
  - `deferred` — descrizioni tool minime e **SKILL.md NON pre-caricate**: servite on-demand via `get_tool_instructions`
- Override per-utente via `user.toolLoadingStrategy`, `user.toolLoadingMaxTools`, `user.toolSchemaFormat` (fallback su `app_config` globale)
- `top_k_rag` usa una **cache in-memory dei vettori tool** (`embedCache`, key = nome+descrizione+schema): ri-embedda solo i tool nuovi/modificati o dopo `invalidateEmbeddingCache()`; a regime paga **solo l'embedding della query** (1 chiamata batch). Cache persa al riavvio processo (non persistita)

**Costo token — modello mentale e risultati empirici** (benchmark interno, richiesta agentica multi-tool reale):

- Il costo di un turno è dominato dal **contesto fisso ri-spedito a OGNI iterazione ReAct** (system + definizioni tool + SKILL.md pre-caricate), moltiplicato per il numero di iterazioni. La history cresce ma è secondaria.
- **Il prompt caching serve il prefisso stabile a ~0.1×**: il costo "pieno" reale è molto minore dell'input grezzo. ⚠️ `cacheReadTokens` è un **sottoinsieme** di `inputTokens`, non un addendo — il consumo full-price è `inputTokens − cacheReadTokens`.
- **Leva dominante = la strategia di tool loading.** Misurato: passare da `always_inject_all/full` a `top_k_rag(+deferred)` riduce il contesto fisso/chiamata da **~28K a ~3-6K token (-80%)** e **~dimezza** il costo effettivo del turno, a parità di risultato.
  - `top_k_rag` taglia il numero di tool (e quindi schemi + SKILL.md caricate) → è il grosso del risparmio.
  - `deferred` azzera quasi il costo fisso delle skill (SKILL.md fuori dal prompt).
  - `compressed` è una leva **minore** (solo schemi tool).
- **Rischio `top_k_rag`**: la selezione semantica può scartare un tool necessario se la sua descrizione non somiglia alla richiesta → curare le descrizioni tool, tenere `maxTools` adeguato, o usare `auto`.
- **Anti-pattern**: non ottimizzare "a intuito" mutando/troncando messaggi vecchi **in mezzo** alla history nel loop — rompe il prefisso cacheato (controproducente). Le riduzioni vanno fatte **prima** del loop (selezione tool) o sul prefisso stabile, non a metà.

**Max History Tokens & trimming** (`buildMessages` → `trimMessages` di @langchain/core):

- Budget token per la storia; default 30 000 tok globale, override per-utente via `user.maxHistoryTokens`
- **Il budget è applicato SEMPRE**, indipendentemente dal toggle compaction: il trim è la rete di sicurezza
  finale e scarta in silenzio i turni più vecchi finché la storia rientra. Compaction OFF ≠ "passa tutto":
  significa solo che l'eccedenza viene persa invece che riassunta
- Il conteggio avviene sulla storia **espansa**: i tool-call persistiti (`Message.toolCalls`) vengono replayati
  come `AIMessage(tool_calls) → ToolMessage×N → AIMessage(testo)`, con ogni output troncato a
  `REPLAY_TOOL_OUTPUT_MAX_CHARS` (env, default 3 000 char) — senza cap un singolo turno con output SQL/schema
  poteva superare da solo il budget e far svuotare l'intera storia (`allowPartial:false` non spezza i turni)
- `trimMessages`: strategy `last`, `startOn:'human'` (no AIMessage orfano), non spezza le coppie human/AI
- tokenCounter **provider-aware**: modello (tiktoken) per openai/openai-compatible/deepseek/lmstudio; stima ~4
  char/token per anthropic/gemini/ollama (`AgentService.TIKTOKEN_PROVIDERS`)

**History Compaction** (`compactHistory`/`summarize`, rolling summary persistito sul Chat):

- Toggle globale `historyCompactionEnabled` (default ON; OFF → solo trimming, eccedenza scartata). No-op anche
  senza `chatId`
- Stato sul `Chat`: `summary`, `summaryUpToMessageId`, `summaryTokens`
- Oltre `historyCompactionThreshold`% del budget (default 80%): tiene verbatim ~50% della soglia, riassume il
  resto col **modello summarizer** (`isSummarizer` ?? default). Errore summarization → fallback al solo trimming
- La stima del peso conta `content + JSON.stringify(toolCalls)` — la stessa misura del trim a valle: i due
  stadi DEVONO vedere lo stesso peso, altrimenti la compaction non scatta e il trim taglia al posto suo
- Il summary va nel **system prompt** (unica sede cross-provider), blocco separato e non cacheato

**Limite step agente:** env `AGENT_RECURSION_LIMIT` (default 50 ≈ 25 giri LLM↔tool, minimo 10) passato a
`agent.stream()` e `agent.invoke()`; il default LangGraph (25 ≈ 12 giri) era insufficiente per esplorazioni DB
lunghe e produceva `GraphRecursionError`. Flusso completo con diagrammi e tabella soglie: **`DATAFLOW_AGENT.md`**.

**Feedback loop / memoria attiva** (`FeedbackService`, modulo `feedback/`):

- Toggle globale `feedbackMemoryEnabled` (default OFF). All'attivazione (PATCH admin) crea la collection
  `feedback_memory`
- L'utente vota 👍/👎 un messaggio assistant e può aggiungere una **correzione** (commento) → `message_feedback` (unique
  `messageId`+`userId`)
- I feedback **con commento** vengono embeddati sulla **domanda** e salvati in `feedback_memory` con payload
  `{ feedbackId, userId, scope, approved, rating, question, answer, comment }`
- **Scope** `personal` (solo l'autore) | `shared` (tutti, ma solo dopo `isApproved` dell'admin)
- In `resolveAgent` (se toggle ON): ricerca semantica = **due query** unite (`{userId, scope:personal}` +
  `{scope:shared, approved:true}`, l'adapter filtra per uguaglianza), dedup per `feedbackId`, soglia score 0.35 →
  blocco "Correzioni da feedback passati" iniettato nel system prompt come **blocco separato e non cacheato** (come il
  summary)
- Best-effort: errori di embedding/ricerca non bloccano la chat

**Memoria utente persistente / auto-memory** (`UserMemoryService`, modulo `user-memory/`):

- Opt-in **per-utente**: toggle `User.autoMemoryEnabled` (default OFF) attivato da Impostazioni→Profilo
- Tabella `user_memory`: una riga = un fatto durevole sull'utente, stato `pending` (proposto) → `confirmed` (attivo),
  con `sourceChatId`
- **Estrazione a soglia** (non per messaggio): a fine turno, se si sono accumulati ≥ soglia messaggi nuovi dall'ultima
  estrazione (marcatore `Chat.memoryUpToMessageId`, gemello di `summaryUpToMessageId`), il **modello summarizer** (
  `getSummarizerModel`, cross-provider, singola `invoke`) estrae fatti come array JSON; dedup contro la memoria
  esistente → salvati come `pending`. Soglia = `User.memoryThreshold` (override) ?? `app_config.autoMemoryThreshold` (
  default globale 6)
- **Estrazione on-demand**: pulsante "Aggiorna memoria" in chat → `POST /api/user-memory/extract`
- **Conferma inline**: le proposte arrivano in chat via evento SSE `memory_proposal`; l'utente conferma/ignora ogni
  fatto (card in `ChatWindow`). I rifiutati vengono eliminati
- **Iniezione**: i fatti `confirmed` entrano nel system prompt come blocco "cosa so dell'utente" a **livello utente**,
  dentro il prefisso **cacheato** (stabili → cambiano solo su conferma/modifica) — a differenza del feedback/summary che
  sono non-cacheati
- Pruning a `MAX_FACTS_PER_USER` (50). Pannello di gestione (modifica/elimina) in Impostazioni→Profilo. Best-effort:
  errori di estrazione non bloccano la chat

**Token usage dashboard** (`UsageService`, modulo `usage/`):

- Ogni messaggio assistant registra `provider`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheWriteTokens` (catturati in `streamResponse`) → attribuzione del costo al modello corretto anche se il default
  cambia nel tempo
- Aggregazione SQL (messages → chats → users/projects) group by user/project/provider/model; roll-up e costi calcolati
  in JS
- **Costo provider-aware** (`usage/pricing.ts`): la semantica di `input_tokens` differisce (Anthropic lo riporta al
  netto della cache; OpenAI/Gemini/DeepSeek lo includono → si sottraggono i cache-read). Moltiplicatori cache per
  provider (Anthropic read ×0.10/write ×1.25, OpenAI ×0.50, Gemini ×0.25, DeepSeek ×0.10). Prezzi base ($/1M in/out) su
  `llm_configs.inputPricePerM`/`outputPricePerM` (admin); prezzo mancante → costo "n/d"
- **Permessi**: admin vede token + costi di tutti, per utente/progetto/modello (`GET /api/usage`); l'utente vede solo i
  propri token, senza costi (`GET /api/usage/me`). Filtro temporale `from/to`
- UI: sezione "Consumi" in Impostazioni con preset di intervallo, card totali e tabelle per utente/progetto/modello

**LLM multi-config / multi-provider** (`LlmProviderService` + `LlmConfigsService`):

- Config salvate in `llm_configs` (multi-record): `isDefault` (agente) + `isSummarizer` (compaction) + `isVision` (task multimodali, es. OCR immagini — fallback al default)
- Provider: `anthropic | openai | gemini | ollama | lmstudio | openai-compatible | deepseek`
- `buildModelForConfig(entity, { maxTokens?, temperature? })`: override per-chiamata (usati dal Prompt executor)
- Cache in-memory del modello default: invalidata dopo ogni modifica config
- DeepSeek: SSE interceptor inietta `reasoning_content` e logga cache hit (`prompt_cache_hit_tokens`)

**Prompt Caching**:

- Anthropic: esplicito con `cache_control: { type: 'ephemeral' }` sul SystemMessage → TTL 5 min, risparmio ~90%
- OpenAI / Gemini: automatico sul prefisso stabile → loggato via `usage_metadata.input_token_details.cache_read`
- DeepSeek: automatico → loggato nell'SSE interceptor `fetch`

**Streaming:** LangGraph `streamMode: 'messages'` — gestisce sia Anthropic (content blocks `tool_use`) che
OpenAI-compatible (`message.tool_calls`). Logga token per step + totali cache read/write.

**`onToolResult` callback** (opzionale, aggiunto a `streamResponse`):

```typescript
onToolResult ? : (toolName: string, result: any) => void
```

Invocata su ogni `ToolMessage` (risultato di un tool), prima del `continue`. Permette al chiamante di ispezionare il
risultato senza modificare il flusso dell'agente.

**SSE — eventi emessi dal channel `/api/chats/:id/messages/stream`:**

| `type`        | Payload                             | Quando                                        |
|---------------|-------------------------------------|-----------------------------------------------|
| `chunk`       | `{ chunk: string }`                 | Token testo LLM                               |
| `tool_call`   | `{ toolCall: {...} }`               | Il LLM ha invocato un tool                    |
| `tool_result` | `{ name: string, ok: boolean }`     | Un tool ha restituito un risultato (✓/✗ live) |
| `file`        | `{ name: string, rel: string }` | Un tool ha prodotto un file su disco; `rel` = path per il download `?rel=` access-aware (`trackOutput` → `canAccess`) |
| `usage`       | `{ inputTokens, outputTokens }`     | Fine generazione                              |
| `done`        | —                                   | Stream completato                             |

`messages.controller.ts` passa `onToolResult` che scansiona ricorsivamente ogni risultato JSON: ogni stringa con `/` che
si risolve in un file esistente dentro `UPLOAD_DIR` genera un evento `file`. URL HTTP e path `/api/…` sono ignorati.

---

## 9. Vector DB (provider-agnostico)

```
VectorStoreProviderService
  └── VectorStoreAdapter (interfaccia)
       ├── QdrantAdapter      (default, self-hosted)
       ├── PGVectorAdapter    (PostgreSQL con pgvector extension)
       ├── ChromaAdapter      (Chroma server)
       └── AstraDBAdapter     (DataStax AstraDB cloud)
```

Configurato da UI admin in "Impostazioni → Vector DB" (tabella singleton `vector_db_config`, id=1).
I parametri variano per provider: URL, connection string, API key cifrata, configurazione extra JSON.

### Servizi interni auto-configurati (embedding & whisper)

Sia l'**embedding** che la **trascrizione** hanno un provider speciale **`internal`** (default su installazione nuova) che punta ai microservizi inclusi nell'app (`embedding-service`, `whisper-service`), senza che l'admin configuri nulla:

- **URL dal deployment, non dal DB**: risolto da env (`EMBEDDING_BASE_URL` / `TRANSCRIPTION_BASE_URL`, impostati in docker-compose; default `localhost:8000`/`:9000` in dev). Spostare/rinominare il servizio non richiede riconfigurazione.
- **Modello e dimensioni auto-rilevati**: il backend sonda `GET {baseUrl}/v1/models` del servizio (best-effort, timeout 3s, fallback ai valori salvati). Per l'embedding le `dims` rilevate evitano disallineamenti con le collection Qdrant.
- **UI**: opzione "Interno (default)" come prima voce del selettore provider; nasconde URL/modello/key e mostra un box info. Il pulsante "Testa" verifica il servizio e ne mostra modello/dimensioni rilevate.
- **Override**: l'utente che vuole un provider proprio (OpenAI/Groq/Ollama/LM Studio/self-hosted) sceglie un'altra voce e configura come di consueto.
- **Dev**: entrambi i servizi si avviano a mano per i test — `./embedding-service/start.sh`, `./whisper-service/start.sh` (oppure `docker compose up embedding whisper`).

Migration `InternalServicesDefault1784500000062`: porta i default a `internal` e migra la riga singleton se ancora intatta.

---

## 10. Schema DB

```
users
  ├── role (varchar, default 'user')       ← admin | user (1° registrato = admin)
  ├── status (varchar, default 'active')   ← active | disabled (login bloccato se disabled)
  ├── systemPrompt (text, nullable)        ← istruzioni personalizzate utente
  ├── toolLoadingStrategy (nullable)       ← override per-utente (null = usa globale)
  ├── toolLoadingMaxTools (nullable)
  ├── toolSchemaFormat (nullable)
  ├── maxHistoryTokens (integer, nullable) ← budget storia per-utente (null = usa globale)
  ├── autoMemoryEnabled (boolean, default false)  ← memoria utente persistente (opt-in)
  ├── memoryThreshold (integer, nullable)  ← override soglia estrazione (null = usa globale)
  ├── user_memory              (content, status pending|confirmed, sourceChatId)  ← fatti durevoli sull'utente
  ├── projects   # userId = OWNER (nullable, ON DELETE SET NULL → progetto del team sopravvive all'eliminazione owner)
  │     ├── systemPrompt (text, nullable)  ← contesto progetto specifico
  │     ├── project_teams (projectId, teamId FK→teams, role collaborator|viewer; unique (projectId,teamId))
  │     │     # condivisione multi-team del progetto; ON DELETE CASCADE su projects e teams
  │     ├── chats   # visibili a tutti i membri del progetto; thread scrivibili da collaborator/owner
  │     │     ├── summary (text, nullable)            ← rolling summary (history compaction)
  │     │     ├── summaryUpToMessageId (uuid, null)   ← ultimo msg incorporato nel summary
  │     │     ├── summaryTokens (int, nullable)       ← stima token del summary
  │     │     ├── memoryUpToMessageId (uuid, null)    ← ultimo msg analizzato per l'estrazione memoria
  │     │     └── messages
  │     │           ├── authorId (uuid, null, FK→users SET NULL)  ← autore del turno utente (thread condivisi)
  │     │           ├── inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens  ← consumi (dashboard)
  │     │           ├── provider/model (varchar, null)   ← chi ha generato il msg, per attribuire il costo
  │     │           └── message_feedback   (rating up|down, comment, question, answer, scope, isApproved, vectorId)
  │     └── files   # visibili a tutti i membri; upload = collaborator/owner
  ├── custom_tools              (scope personal|team|org + teamId FK→teams)
  │     └── tool_secrets        (keyName + encryptedValue AES)
  ├── mcp_servers
  │     └── mcp_server_secrets
  └── data_sources              (connection string cifrata + schemaHints; scope personal|team|org + teamId)

teams
  └── team_memberships          (userId, teamId, role owner|member; unique (teamId,userId))
       # scope='team' delle risorse → teamId; visibilità per-appartenenza; ON DELETE SET NULL su teams

app_config (singleton, id=1)
  ├── systemPrompt              ← prompt base modificabile da admin (seed da SYSTEM_PROMPT)
  │   # ⚠️ campi llmProvider/llmModel/llmApiKey/llmBaseUrl/llmMaxTokens ANCORA presenti ma LEGACY:
  │   #    l'agente usa llm_configs (default). Endpoint app-config/llm non più la fonte di verità.
  ├── embeddingProvider / embeddingModel / embeddingApiKey (cifrata) / embeddingBaseUrl /
  │   embeddingVectorSize / embeddingQueryPrefix / embeddingChunkSize / embeddingChunkOverlap
  ├── toolLoadingStrategy (top_k_rag|always_inject_all|auto)  ← default globale
  ├── toolLoadingMaxTools (integer)   ← max tool iniettati per richiesta
  ├── toolSchemaFormat (full|compressed|deferred)
  ├── maxHistoryTokens (integer, default 6000)  ← budget storia globale
  ├── historyCompactionEnabled (boolean, default false)  ← riassumi invece di scartare
  ├── historyCompactionThreshold (int, default 80)       ← % budget oltre cui scatta (50–95)
  ├── feedbackMemoryEnabled (boolean, default false)     ← memoria attiva da feedback (collection feedback_memory)
  └── autoMemoryThreshold (int, default 6)               ← default globale soglia estrazione memoria utente (n. messaggi)

llm_configs (multi-record)
  ├── name / provider / model / apiKey (cifrata) / baseUrl / maxTokens
  ├── inputPricePerM / outputPricePerM (numeric, null)  ← prezzo $/1M per stima costi (dashboard consumi)
  ├── isDefault (boolean)       ← config usato dall'agente (uno solo)
  └── isSummarizer (boolean)    ← config per i riassunti compaction (uno solo; fallback al default)

vector_db_config (singleton, id=1)
  ├── provider (qdrant|pgvector|chroma|astradb)
  ├── url / connectionString / apiKey (cifrata) / extraConfig (jsonb)
  └── vector_collections        (collection create/gestite)
```

```
users → skills
  ├── skill_scripts (language, mode: oneshot|daemon)
  ├── skill_configs (config vars, secret flag, cifrate AES)
  └── skill_project_assignments (M:N skills ↔ projects)

skills
  ├── enabled (boolean, default true)  ← toggle abilitazione da UI
  ├── scope (personal|team|org) + teamId (FK→teams) + isApproved (boolean)
  │     # team = pubblicazione diretta owner-del-team (no review); org = review admin (isApproved)
  └── status (installing|ready|error)

skill_daemons
  ├── skillId, scriptFilename, userId
  ├── daemonId (UUID executor)
  ├── status (starting|running|stopped|error)
  └── lastEventAt

notifications
  ├── userId, skillId, daemonId
  ├── eventType, payload (jsonb)
  └── readAt
```

**Migrazioni TypeORM** (~52 file sequenziali in `backend/src/database/migrations/`, `migrationsRun: true` → applicate al
boot):
`InitialSchema → CustomTools → CustomToolScope → McpServers → McpRemoteTransport → DataSources → SystemPrompts → AppConfig → LlmConfig → VectorDb → EmbeddingConfig → VectorDbProvider → AddRagExecutorType → Skills → AddNodeLanguage → SkillConfigVars → AddScriptMode → CreateSkillDaemons → CreateNotifications → AddNixDeps → ToolLoadingConfig → TokenCount → HistoryTokenLimit → DeferredAsStrategy → SkillEnabled → SkillScriptLlmCallable → SkillScriptContextNote → SkillScriptLastInfoOutput → SkillSourceId → LlmConfigs → HistoryCompaction → HistoryCompactionThreshold → MessageFeedback → UserMemory → TokenUsage → UserStatus → Teams → CustomToolScopeTeam → CustomToolScopeIndexes → SkillScopeTeam → DataSourceScopeTeam → ProjectTeams → MessageAuthor → **CreateFlows → CreateAgents → ChatAgentTeam → CreateScheduledTasks → ScheduledTaskTokens → ScheduledTaskToolsCost → ScheduledTaskChatDelivery → FlowChatDelivery (+ Fix)**`

> **RAG & scope documenti**: lo scope (`universal|project|personal`) non è una tabella ma vive nel **payload del
> vettore** (`scope`, `userId`, `projectId`) accanto al testo del chunk — vedi §5 Executor RAG.

---

## 11. API Esposte

```
# Auth
POST   /api/auth/register        ← il PRIMO utente registrato diventa admin (bootstrap); login bloccato se status='disabled'
POST   /api/auth/login

# Profilo utente
GET    /api/users/me
PATCH  /api/users/me             ← include systemPrompt utente, autoMemoryEnabled, memoryThreshold
POST   /api/users/me/change-password

# Gestione utenti (admin)
GET    /api/admin/users          ← lista paginata + filtri (search, role, status)
POST   /api/admin/users          ← crea utente
PATCH  /api/admin/users/:id      ← nome/email
PATCH  /api/admin/users/:id/role          ← admin|user (no demote dell'ultimo admin)
PATCH  /api/admin/users/:id/status        ← active|disabled
POST   /api/admin/users/:id/reset-password
DELETE /api/admin/users/:id

# Team (scrittura admin; /mine per ogni utente)
GET    /api/teams/mine           ← team dell'utente corrente (selettori di scope)
GET    /api/teams                ← lista con memberCount (admin)
POST   /api/teams                ← crea team (admin)
PATCH  /api/teams/:id            ← aggiorna (admin)
DELETE /api/teams/:id            ← elimina (admin)
GET    /api/teams/:id/members
POST   /api/teams/:id/members            ← aggiungi membro { userId, role }
PATCH  /api/teams/:id/members/:userId    ← owner|member (no demote ultimo owner)
DELETE /api/teams/:id/members/:userId

# Progetti (gestione team: owner del progetto o admin)
GET    /api/projects                ← propri (owner) + condivisi coi propri team
POST   /api/projects
PUT    /api/projects/:id            ← include systemPrompt progetto
DELETE /api/projects/:id            ← chat/file NON cancellati (projectId→null); team assignment CASCADE
GET    /api/projects/:id/teams                  ← team assegnati (membri in lettura)
POST   /api/projects/:id/teams                  ← assegna team { teamId, role: collaborator|viewer }
PATCH  /api/projects/:id/teams/:teamId          ← cambia ruolo del team
DELETE /api/projects/:id/teams/:teamId          ← rimuove il team

# Chat + streaming
GET    /api/chats?projectId=        ← con projectId: chat di TUTTI i membri del progetto (authorId/authorName)
POST   /api/chats                   ← in un progetto: serve write (collaborator/owner); viewer no
GET    /api/chats/:id               ← include canWrite per l'utente corrente
GET    /api/chats/:id/messages      ← lettura per autore o membro del progetto
POST   /api/chats/:id/messages/stream   ← SSE; scrittura per autore o collaborator/owner del progetto

# File + RAG
POST   /api/files/upload?projectId=     ← in un progetto serve write (collaborator/owner)
GET    /api/files?projectId=            ← file del progetto (tutti i membri) | ?chatId= | propri
GET    /api/files/:id/download          ← scaricabile da proprietario o membro del progetto
GET    /api/files/raw?rel=<path>        ← download autenticato (whitelist UPLOAD_DIR)
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
POST   /api/data-sources/:id/test     ← test connessione

# MCP Servers
GET    /api/mcp-servers
POST   /api/mcp-servers
GET    /api/mcp-servers/:id
PATCH  /api/mcp-servers/:id
DELETE /api/mcp-servers/:id
GET    /api/mcp-servers/:id/secrets
POST   /api/mcp-servers/:id/secrets
DELETE /api/mcp-servers/:id/secrets/:key

# Configurazione app (admin only)
GET    /api/app-config
PATCH  /api/app-config                    ← system prompt base
GET    /api/app-config/tool-loading
PATCH  /api/app-config/tool-loading       ← strategia tool + maxHistoryTokens + history compaction
GET    /api/app-config/embedding
PATCH  /api/app-config/embedding
POST   /api/app-config/embedding/test
GET    /api/app-config/llm                ← ⚠️ legacy (campi app_config.llm*, non più fonte di verità)
PATCH  /api/app-config/llm                ← ⚠️ legacy
POST   /api/app-config/llm/test           ← ⚠️ legacy

# LLM Configs — multi-record (admin only) — fonte di verità per l'agente
GET    /api/llm-configs
POST   /api/llm-configs
PATCH  /api/llm-configs/:id
DELETE /api/llm-configs/:id
POST   /api/llm-configs/:id/set-default
POST   /api/llm-configs/:id/set-summarizer
POST   /api/llm-configs/clear-summarizer
POST   /api/llm-configs/:id/set-vision        ← designa il modello per task vision/OCR
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
POST   /api/skills/upload                    ← carica ZIP
GET    /api/skills
GET    /api/skills/:id
PATCH  /api/skills/:id
DELETE /api/skills/:id
PATCH  /api/skills/:id/enabled               ← { enabled: bool } — owner o admin
POST   /api/skills/:id/reinstall
POST   /api/skills/:id/assign                ← assegna a progetto
POST   /api/skills/:id/install               ← installa copia da marketplace interno
GET    /api/skills/registry                  ← indice registry GitHub (cachato)
POST   /api/skills/registry/install          ← { downloadUrl } — scarica ZIP da GitHub
POST   /api/skills/registry/refresh          ← [admin] invalida cache registry
POST   /api/skills/:id/propose-compilation   ← [owner] l'AI propone input_schema (descriptive→typed)
POST   /api/skills/:id/compile               ← [owner] { scripts } applica → kind=typed

# Sandbox (esecuzione codice/shell arbitrari, tool run_in_sandbox)
GET    /api/admin/config/sandbox             ← [admin] gating (enabled, allowlist team/progetti, rete)
PATCH  /api/admin/config/sandbox             ← [admin] aggiorna gating
GET    /api/sandbox/file?chatId=&path=       ← scarica un file dal workspace della chat (scoped)

# Daemons
GET    /api/daemons
POST   /api/daemons                          ← { skillId, scriptFilename } — avvia
GET    /api/daemons/:id
POST   /api/daemons/:id/restart
DELETE /api/daemons/:id                      ← ferma (status=stopped)
DELETE /api/daemons/:id/record               ← elimina record DB

# Feedback loop
GET    /api/feedback/config                  ← { enabled, vectorAvailable } (tutti)
PATCH  /api/feedback/config                  ← { enabled } [admin] — on enable crea collection feedback_memory
POST   /api/feedback                         ← { messageId, rating, comment?, scope? } — upsert (unique messageId+userId)
GET    /api/feedback/chat/:chatId            ← i miei feedback per una chat (stato UI)
GET    /api/feedback                         ← dashboard (admin: tutti, utente: solo i propri)
PATCH  /api/feedback/:id/approve             ← { approved } [admin] — approva feedback shared
PATCH  /api/feedback/:id/scope               ← { scope } — owner o admin
DELETE /api/feedback/:id                     ← owner o admin (rimuove anche il punto vettoriale)

# Memoria utente persistente
GET    /api/user-memory                      ← i miei fatti (confirmed + pending)
POST   /api/user-memory/extract              ← { chatId } — estrazione on-demand → { proposals }
POST   /api/user-memory/confirm              ← { ids } — conferma fatti pending → confirmed
POST   /api/user-memory                      ← { content } — aggiungi fatto manuale (confermato)
PATCH  /api/user-memory/:id                  ← { content } — modifica un fatto
DELETE /api/user-memory/:id                  ← elimina (rifiuto pending o cancellazione confermato)

# Consumi token (dashboard)
GET    /api/usage/me                         ← i miei consumi (solo token, no costi) — ?from&to
GET    /api/usage                            ← [admin] token + costi stimati di tutti (per utente/progetto/modello) — ?from&to

# Internal (auth: x-internal-token header — token di run/daemon firmato; vedi RUN_TOKEN_SECRET)
POST   /internal/skills/:id/save-config      ← upsert config vars sicure (no JWT)
POST   /internal/daemons/events              ← push evento daemon → Socket.IO
POST   /internal/datasources/:id/query       ← query/file-op (scope-checked sull'identità del token)
POST   /internal/vector/search · /ingest     ← ricerca/indicizzazione vettoriale

# WebSocket
WS     /mcp-bridge        ← Electron Bridge (Socket.io, JWT auth)
WS     /notifications     ← Notifiche real-time daemon → frontend (Socket.IO)

# Docs
GET    /api/docs           ← Swagger UI
```

---

## 12. Variabili d'Ambiente Chiave

### Backend (`.env` di root)

```bash
# Server
PORT=3000
NODE_ENV=development

# CORS — origini consentite (comma-separated). Se non impostato = allow all.
FRONTEND_URL=http://localhost:5173

# Auth
JWT_SECRET=...
JWT_EXPIRES_IN=7d

# LLM · Embedding · Vector DB → configurati dalla UI admin (Impostazioni → Sistema AI),
# persistiti cifrati nel DB (tabelle llm_configs / app_config / vector_db_config).
# Non si impostano via env. (Il container `embedding` usa EMBEDDING_MODEL/DEVICE/BATCH_SIZE.)

# Agent (opzionali) — limite step LangGraph per messaggio e cap replay output tool in history
AGENT_RECURSION_LIMIT=50            # default 50 ≈ 25 giri LLM↔tool, min 10
REPLAY_TOOL_OUTPUT_MAX_CHARS=3000   # default 3000 char/output, min 500

# Database applicativo
DB_HOST=localhost
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
DB_NAME=arkimede

# Crypto — chiave AES-256-GCM per segreti tool, data source, config LLM (A1)
# OBBLIGATORIA: 64 char hex. Senza, il backend NON parte (fail-fast).
TOOL_SECRETS_KEY=...   # openssl rand -hex 32

# App branding
APP_NAME=Arkimede

# Skills — upload e path
UPLOAD_DIR=./uploads
SKILL_EXECUTOR_URL=http://skill-executor:4000   # URL sidecar Docker (porta 4000 interna)

# Isolamento skill — overlay broker (D2, opzionale). Se BROKER_URL è impostato,
# le skill python/node girano come container-job effimeri lanciati dal broker.
# BROKER_URL=http://broker:4100
# JOB_RUNTIME=runc                 # runc | runsc (gVisor)
# JOB_EGRESS_NETWORK=sandboxnet    # rete egress per i job (col combo egress)
# SKILLS_HOST_BASE / WORK_HOST_BASE / SKILL_STATE_HOST_BASE / SKILLS_OUTPUT_HOST_BASE  # path host condivisi

# API interna /internal/* — token di run firmati (HMAC). Segreto SOLO nel backend.
RUN_TOKEN_SECRET=<secret>   # openssl rand -hex 32 (obbligatorio)
# Auth mesh servizi (header x-service-key): backend→executor e executor→broker. Obbligatoria.
SERVICE_API_KEY=<secret>    # openssl rand -hex 32

# Registry GitHub skills
SKILLS_REGISTRY_URL=https://...              # default: registry community ufficiale
SKILLS_REGISTRY_CACHE_TTL_MS=300000         # TTL cache in ms (default 5 min)
SKILLS_REGISTRY_ALLOWED_DOMAINS=cdn.com     # domini extra ammessi per download ZIP
```

### Frontend (`frontend/.env`)

```bash
VITE_APP_NAME=Arkimede

# URL base del backend NestJS (senza /api).
# Se non impostato → Vite proxia /api → localhost:3000 (no CORS in dev).
# VITE_BACKEND_URL=http://localhost:3000

# URL WebSocket per il bridge Electron.
# VITE_WS_URL=ws://localhost:3000
```

---

## 13. Avvio Sviluppo

```bash
# 1. Infrastruttura (Postgres + Qdrant + skill-executor)
docker compose up postgres qdrant skill-executor -d

# 2. Backend NestJS
cd backend
npm install
npm run migration:run   # applica le ~52 migration TypeORM (o auto al boot: migrationsRun=true)
npm run start:dev       # → http://localhost:3000

# 3. Frontend
cd frontend
npm install
npm run dev             # → http://localhost:5173

# 4. Bridge Electron (opzionale — solo per MCP transport 'remote')
cd bridge
npm install
npm run dev
```

**Primo avvio:** `app_config` viene inizializzata con il system prompt di default da `system.prompt.ts` e provider
Anthropic. Modificabile da admin in "Impostazioni → Sistema AI" senza redeploy.

---

## 14. Decisioni Architetturali

- **Nessun tool built-in:** `builtInTools = []`. Tutti i tool del dominio iniziale (`rag.tool.ts`, `database.tool.ts`,
  `recommend.tool.ts`, `completeness.tool.ts`, `pdf-gen.tool.ts`) e il sistema di raccomandazione (
  `recommendation.service.ts`) sono stati rimossi. RAG/SQL → custom tool type; generazione file/PDF → skill. Più
  flessibile, multi-tenant, nessun hard-coding di dominio.
- **Custom tool rebuild per richiesta:** `createReactAgent` è in-memory (~1-2ms), non fa I/O — è sicuro ricostruirlo a
  ogni richiesta per includere i tool aggiornati dell'utente.
- **AppConfig singleton:** tabella `app_config` con `id=1` per system prompt base, embedding, tool loading e history
  compaction. I vecchi campi `llm*` restano nello schema ma sono legacy (vedi sotto).
- **LLM config multi-record (llm_configs):** sostituisce di fatto i campi `llm*` di app_config. `LlmConfigsService`
  contiene la logica di build per provider (`buildModelForConfig(entity, overrides?)`); `LlmProviderService` è un
  wrapper con cache attorno al config `isDefault` (e `getSummarizerModel()` per il config `isSummarizer`). Cache
  invalidata quando cambia il default. Fallback su env vars se API key non nel DB.
- **VectorDb provider-agnostico:** `VectorStoreAdapter` isola la logica di business dai dettagli di connessione.
  Aggiungere un nuovo provider = aggiungere un adapter.
- **DataSource separata dal tool SQL:** `DataSource` = la connessione (cosa è il DB). `CustomTool[sql]` = come
  interrogarlo (query, prefetch, limiti). Riuso della stessa DataSource da tool diversi.
- **System prompt a 4 livelli:** basePrompt (admin) + userPrompt (utente) + projectPrompt (progetto) + skillsPrompt (
  SKILL.md selettivo). Ordine: il più specifico va per ultimo. `buildSystemPrompt()` concatena i layer non vuoti.
- **`local` vs `remote` MCP:** `local` → NestJS spawna stdio direttamente (stessa macchina). `remote` → bridge Electron
  spawna sulla macchina utente e proxia via WebSocket. Scegliere `local` per setup self-hosted.
- **Bridge routing multi-utente:** ogni bridge si autentica con il JWT dell'utente. Il gateway indicizza tutto per
  `userId`.
- **Segreti cifrati in DB (AES-256-CBC):** API key tool, connection string DataSource, API key LLM, API key vector DB.
  Mai esposte in API response.
- **CORS backend:** un solo punto in `enableCors()` (`main.ts`). NON passare `cors: true` a `NestFactory.create` — causa
  doppio header.
- **Compilatore backend = tsc** (non più SWC): `nest-cli.json` ha `"builder": "tsc"`. `nest build` e `npm run typecheck`
  (`tsc --noEmit`) validano i tipi e girano puliti (consigliato `NODE_OPTIONS=--max-old-space-size=4096`). `.swcrc` e le
  dep `@swc/*` restano nel repo ma sono inerti. (Storico: in passato `tsc` andava OOM sui tipi LangGraph → ora risolto.)
- **OpenAI SDK base64:** SDK v4.25+ manda `encoding_format=base64` di default → server locali rompono. Il probe usa
  `fetch()` diretto con `encoding_format: 'float'` esplicito.
- **`LocalMcpProcess` porting:** porting fedele di `McpProcess` del bridge per NestJS. Mantenere i due file allineati.
- **Tool loading strategy:** `ToolSelectionService` applica la strategia prima di costruire l'agente. Con `top_k_rag`
  (o `auto` sopra soglia) solo i tool selezionati vengono iniettati nel contesto; con `deferred` anche le SKILL.md
  restano fuori dal prompt → contesto fisso/chiamata ridotto di ~80%, costo turno ~dimezzato (misurato).
- **SKILL.md selettivo:** marker `<!-- @tool: script.py -->` nel SKILL.md dividono il contenuto in sezioni. Solo le
  sezioni dei tool selezionati vengono incluse nel system prompt. Il blocco prima del primo marker è sempre incluso (
  shared/intro).
- **Prompt caching Anthropic:** `SystemMessage` con `cache_control: { type: 'ephemeral' }` sul contenuto del system
  prompt. Il provider Anthropic cacha fino al primo 32k token stabili. Scrittura cache: ×1.25 costo; lettura: ×0.10 (90%
  risparmio).
- **DeepSeek reasoning_content:** l'API DeepSeek richiede `reasoning_content` su ogni messaggio assistant nella storia.
  Poiché non viene salvato nel DB, viene iniettato come stringa vuota nell'interceptor fetch prima di ogni richiesta.
- **`always_inject_all` legacy:** per compatibilità, questa strategia bypassa la selezione e carica tutti i tool e tutti
  i SKILL.md. Usare per test o quando tutti i tool sono sempre rilevanti.
- **Skills come DynamicStructuredTool:** ogni script `mode: oneshot` di ogni skill abilitata e assegnata al progetto
  viene convertito in un `DynamicStructuredTool` LangChain da `skill-tool.factory.ts`. Costruito a ogni `resolveAgent` (
  ≤2ms, no I/O).
- **`onToolResult` per SSE file events:** invece di far sì che ogni skill restituisca esplicitamente un URL scaricabile
  per ogni file, il backend scansiona ricorsivamente il JSON di ritorno di ogni tool. Qualunque stringa che si risolve
  in un file su disco genera un evento SSE `file` — trasparente per gli script.
- **Enabled toggle senza eliminare:** le skill possono essere disabilitate (`enabled=false`) senza perdere
  configurazione o assegnazioni. Filtro applicato in `buildSkillSystemPromptSelective` e in `resolveAgent` prima di
  costruire i tool.
- **API interna `/internal/*` (token di run firmati):** ogni esecuzione skill/daemon riceve un token HMAC
  coniato dal backend (`RUN_TOKEN_SECRET`, solo lato backend) e iniettato come env `INTERNAL_TOKEN`; lo script lo
  inoltra in `x-internal-token`. Il token porta l'identità (`sub`=userId) non falsificabile → gli endpoint scoped
  (es. datasource) applicano l'ownership su quell'identità. Sostituisce la vecchia `INTERNAL_API_KEY` condivisa
  iniettata negli script. L'auth **servizio-a-servizio** del mesh (backend→executor→broker) usa invece
  `SERVICE_API_KEY` (header `x-service-key`), separata dalla firma dei token. Verifica in `InternalTokenGuard`; conio in `skill-tool.factory`
  (run) e `daemons.service` (daemon).
- **Daemon ripristino automatico:** `DaemonsService.onModuleInit()` riavvia automaticamente i daemon in stato `running`
  o `starting` al boot del backend.

---

## 15. Sezioni Settings Frontend

| Sezione             | Visibilità | Contenuto                                                                                                                    |
|---------------------|------------|------------------------------------------------------------------------------------------------------------------------------|
| Profilo             | Tutti      | Nome, email, systemPrompt utente, cambio password                                                                            |
| Provider LLM        | Admin      | Config LLM multi-record (llm_configs): aggiungi/modifica, ⭐ predefinito, ✨ summarizer, test connessione                      |
| Sistema AI          | Admin      | Embedding provider, system prompt base, tool loading + memoria conversazione (maxHistoryTokens, history compaction + soglia) |
| Tool Custom         | Tutti      | CRUD tool HTTP/SQL/RAG/prompt, test inline, segreti                                                                          |
| Server MCP          | Tutti      | CRUD MCP server (http/sse/local/remote), segreti                                                                             |
| File                | Tutti      | File caricati nei progetti, gestione indicizzazione                                                                          |
| Database            | Tutti      | CRUD DataSource (connessioni DB esterne per SQL tool)                                                                        |
| Vector DB           | Admin      | Configurazione provider vector DB, gestione collection                                                                       |
| Skills              | Tutti      | Upload ZIP, configurazione vars, assegnazione progetti, enabled toggle                                                       |
| Skills / Pubblica   | Tutti      | Team (owner, diretto) · Org → marketplace interno (org+approved) + Registry GitHub esterno                                   |
| Skills / Review     | Admin      | Approvazione/rifiuto skill in attesa                                                                                         |
| Skills / Background | Tutti      | Avvio/stop daemon skill, stato e log in tempo reale                                                                          |
| Flows               | Tutti      | Canvas React Flow: 11 tipi di nodo, trigger, error-policy, esecuzione + storico run                                          |
| Agenti              | Tutti      | CRUD agenti Multi-Agent (prompt, modello, filtro tool, scope)                                                               |
| Team agenti         | Tutti      | Composizione team (membri ordinati) + topologia supervisor/sequential/parallel                                              |
| Automazioni         | Tutti      | Automazioni programmate (Auto-Scheduling): stato, pending+Attiva, token/costo per run, abilita/elimina                       |
| Attività            | Tutti      | Cruscotto sola-lettura: daemon skill, automazioni, flow schedulati e ultimi run aggregati (refetch auto ogni 10s)            |

---

## Multi-Agent (Livello 2)

> **Stato: IMPLEMENTATO E VERIFICATO.** Modulo `agents/` a codice: entità `agents` /
> `agent_teams` / `agent_team_members`, `AgentsService` + `AgentTeamsService` (CRUD con scope `personal|team|org`,
> `assertCanManage`), `MultiAgentService` runtime con topologie **single / sequential / parallel / supervisor** (loop
> di routing cross-provider). Integrazione chat: `chats.agentTeamId` → la chat gira col team, eventi SSE `agent_step`
> attribuiti al sub-agente. UI: **Impostazioni → Agenti** (`AgentsPage`) e **Team agenti** (`TeamsPage`), selettore
> "esegui con un team" in `ChatWindow`. Migration `CreateAgents` + `ChatAgentTeam`. La sezione sotto resta come spec di
> riferimento; le differenze rispetto al codice sono annotate (es. supervisor = loop TS, non `StateGraph`).
> 🔭 **Resta da fare (Opzione 4):** versione **letterale su `StateGraph`** (handoff `Command`, checkpoint/resume,
> human-in-the-loop).
>
> **Agent-as-tool (delega gerarchica).** Oltre a far girare l'**intera** chat con un team (`chats.agentTeamId`,
> aut-aut), un agente/team con `exposeAsTool=true` è esposto come `DynamicStructuredTool` (`agent_<slug>` / `team_<slug>`)
> **tra** i tool di una chat normale: il modello principale gli delega un task senza vederne i tool interni. Si combina con
> `loadOnFirst` (per-tool) per tenere fuori dal contesto flat i tool incapsulati — vedi
> [Delega gerarchica](#delega-gerarchica--exposeastool--loadonfirst).

### Punto di partenza (stato attuale)

Oggi il motore è **single-agent**: `resolveAgent()` costruisce **un solo** `createReactAgent` (LangGraph prebuilt) con
l'LLM `isDefault` e tutti i tool selezionati. L'unica forma di "secondo agente" è l'executor `prompt` (§5), che è in
realtà una **singola `callLlm` stateless** (`custom-tool.factory.ts`): system+user → una risposta, **senza tool propri,
senza loop, senza stato**. È una *funzione LLM*, non un agente autonomo. Mancano: orchestratore, sub-agenti con tool
propri, parallelismo, handoff.

### Visione Livello 2 — team di agenti configurabili da UI (no-code)

Coerente con il principio del prodotto ("tutto configurabile da UI, niente codice"): l'utente **definisce i propri
agenti e li compone in team**, riusando l'infrastruttura già esistente. È il differenziatore vs i concorrenti
(Agent Zero / OpenHands hanno team gerarchici ma code-first; Open WebUI / Claude Desktop non hanno veri team di
agenti).

Un **agente** = (system prompt + un `LlmConfig` + un sottoinsieme di tool/skill/MCP filtrati per scope). Un **team** =
N agenti + una **topologia** che ne governa la collaborazione. Tutti i mattoni esistono già:

| Mattone riusato | Da dove |
|---|---|
| Modello per-agente (anche economico per ruoli "writer") | `llm_configs` multi-record + `buildModelForConfig` |
| Tool/skill/MCP per-agente, filtrati | `loadToolsForUser` + scope `personal\|team\|org` |
| RAG dinamico per progetto | executor `rag` `searchScope:auto` |
| System prompt a layer | `buildSystemPrompt` (si aggiunge il prompt dell'agente) |
| Streaming + tool events | SSE `chunk\|tool_call\|tool_result\|file\|usage\|done` |
| Costi per modello | `usage/` attribuisce già per `provider/model` |

### Topologie supportate (target)

| Topologia | Comportamento | Caso d'uso |
|---|---|---|
| `supervisor` | Un agente-supervisor riceve la richiesta e fa **handoff** (`Command(goto=...)`) all'agente specializzato, raccoglie l'esito, decide il prossimo passo o risponde | Routing per dominio (es. "analista SQL" vs "redattore documenti") |
| `sequential` | Pipeline fissa A→B→C, l'output di uno è input del successivo | Flussi deterministici (estrai → trasforma → scrivi) |
| `parallel` | N agenti lavorano in parallelo su sotto-task, un nodo finale (`fan-in`) aggrega | "Analizza questi 5 fornitori" → 5 sub-agenti in `Promise.all` |
| `agent-as-tool` | Un agente è esposto come `DynamicStructuredTool` al main agent (evoluzione dell'executor `prompt` → tipo `agent`) | Migrazione incrementale dal single-agent attuale (Livello 0) |

**Vantaggi** (vedi anche §perché): isolamento del contesto (un sub-agente fa 10 query RAG e restituisce **solo la
sintesi** → contesto del supervisor pulito), **latenza** (parallelismo), **specializzazione** (modello/prompt/tool
giusti per ruolo). **Trade-off**: costo token (ogni sub-agente ricarica il proprio contesto) e debug più complesso →
il multi-agent va usato dove il task è **decomponibile**, non ovunque.

### Implementazione — da `createReactAgent` a `StateGraph`

> **Nota implementativa (stato attuale).** Il supervisor è realizzato come **loop di routing** in TypeScript
> (`MultiAgentService.runSupervisor`): il supervisor sceglie il prossimo membro o `FINISH` con chiamate LLM **normali**,
> non `withStructuredOutput` — perché quest'ultimo è provider-dipendente e viola la regola "il codice LLM deve girare su
> tutti i provider". Comportamento identico. 🔭 **Possibile implementazione futura (Opzione 4):** versione **letterale
> su `StateGraph`** (handoff `Command`, checkpoint/resume, streaming per-nodo, human-in-the-loop). Conviene solo se
> servono quelle capacità: il loop attuale è funzionalmente equivalente e cross-provider.

`resolveAgent()` viene rifattorizzato (non riscritto): se il chat/progetto usa un team, invece del singolo
`createReactAgent` si compila uno **`StateGraph`** di LangGraph in cui ogni agente è un nodo (a sua volta un
`createReactAgent` con i **suoi** tool e il **suo** modello), e gli archi/`Command` implementano la topologia. Il
supervisor decide gli handoff via **structured output**, cross-provider (mai logica single-provider).

```
resolveTeam(userId, projectId, teamId, userInput, history, chatId):
  agents = loadAgentsForTeam(teamId)          # ognuno: systemPrompt + llmConfig + tool scope
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

### Modello dati (implementato)

```
agents                         # un agente riusabile (come tool/skill: scope personal|team|org)
  ├── id, name, description
  ├── systemPrompt (text)
  ├── llmConfigId (FK→llm_configs)        ← modello dell'agente (override per-ruolo)
  ├── toolFilter (jsonb)                  ← quali tool/skill/MCP carica (per nome o per scope)
  ├── maxIterations (int, null)           ← cap loop ReAct del sub-agente
  └── scope (personal|team|org) + teamId  ← stesso modello di custom_tools/skills (assertCanManage)

agent_teams
  ├── id, name, description
  ├── topology (supervisor|sequential|parallel)
  ├── supervisorAgentId (FK→agents, null) ← solo per topology=supervisor
  └── scope (personal|team|org) + teamId

agent_team_members             # join agenti ↔ team, con ordine per le pipeline
  ├── teamId (FK→agent_teams), agentId (FK→agents)
  ├── position (int)                      ← ordine per sequential
  └── role (varchar, null)                ← etichetta libera ("ricercatore", "writer"...)

# Collegamento all'esecuzione:
chats.agentTeamId  (FK→agent_teams, null) ← se valorizzato, la chat gira col team invece del default
# (oppure projects.agentTeamId per impostare il team a livello progetto)
```

### Esecuzione & streaming SSE

Lo stream deve restare leggibile lato UI: ogni evento dei sotto-agenti viene **attribuito** all'agente che lo ha
prodotto, estendendo gli eventi SSE esistenti con un campo `agent`:

| `type` | Estensione | Significato |
|---|---|---|
| `agent_start` | `{ agent: string, role?: string }` | Un sub-agente prende il controllo (handoff) o parte (parallel) |
| `chunk` / `tool_call` / `tool_result` / `file` | `+ { agent: string }` | Stesso payload di oggi, attribuito al sub-agente |
| `agent_end` | `{ agent: string, summary?: string }` | Il sub-agente ha finito e restituisce l'esito al supervisor |

I costi continuano ad attribuirsi correttamente: `usage/` registra già `provider/model` **per messaggio**, quindi i
token di ciascun sub-agente vanno sul modello giusto senza modifiche allo schema di usage.

### Scope, permessi, multi-tenant

Agenti e team seguono **lo stesso modello di scope** di tool/skill/datasource (`personal | team | org`, `teamId`,
`assertCanManage`: personal=owner, org=admin, team=admin-o-owner). Un team `org` = workflow standard aziendale curato
dagli admin; `team` = workflow di reparto; `personal` = sperimentazione. La visibilità per-appartenenza vale come per
le altre risorse.

### Roadmap di rollout — ✅ completata

1. ✅ **Livello 0 — `agent-as-tool`.** Un agente esposto come `DynamicStructuredTool`.
2. ✅ **Livello 1 — supervisor.** Topologia supervisor (loop di routing TS cross-provider) + sequential + parallel in
   `MultiAgentService`.
3. ✅ **Livello 2 — team configurabili da UI.** Tabelle `agents`/`agent_teams`/`agent_team_members`, sezioni
   "Impostazioni → Agenti / Team agenti", selettore del team sulla chat (`chats.agentTeamId`). L'USP no-code.

> 🔭 Resta solo l'**Opzione 4** (supervisor su `StateGraph` letterale con checkpoint/resume/human-in-the-loop) —
> opzionale.

### UI prevista (Settings)

| Sezione | Visibilità | Contenuto |
|---|---|---|
| Agenti | Tutti | CRUD agente: prompt, `LlmConfig`, tool/skill/MCP selezionati, scope |
| Team di agenti | Tutti | Composizione team, topologia (supervisor/sequential/parallel), ordine membri, scope |

---

## Flows

> **Stato: FETTE 1–4 COMPLETE + VERIFICATE.** Backend `flows/` (entità+migration, `FlowEngine` a DAG +
> `BindingResolver`, storico `flow_runs`) e frontend (canvas React Flow in Impostazioni → Flows, palette per famiglia +
> picker di binding). **12 tipi di nodo:** tool, llm, condition, http, skill, transform, flow (sub-flow ricorsivo con
> depth-guard), **agent, team** (ponte Multi-Agent), **loop** (map su array via sub-flow), **join** (fan-in) e **chat**
> (consegna/posta un messaggio in una chat). **Motore a ondate** (parallelismo reale: rami indipendenti in `Promise.all`)
> + **error-policy per-nodo** (stop/continue/retry). **Test run per-nodo**: esegue il subgraph dei predecessori per
> provare un singolo nodo dall'editor. **Trigger:** manual, **cron** (ricorrente), **scheduled** (one-shot), **webhook**
> (endpoint pubblico) e **chat-as-tool** (flow esposti all'agente). Scheduler su **BullMQ + Redis** (`syncAll` al boot,
> degrada con grazia se Redis è giù). ⚠️ isolated-vm (nodo `transform`) richiede l'executor in **Docker** (no prebuilt
> arm64 in locale). Complementare al [Multi-Agent](#multi-agent-livello-2), non alternativo: editor visuale a blocchi,
> grafo **DAG con rami** (parallelo + join), tutti i tipi di nodo/trigger, storico esecuzioni persistito.

### Perché — il terzo paradigma (determinismo)

I tre livelli di controllo di una piattaforma agentica, dal più libero al più rigido:

| Paradigma | Chi decide il "come" | Quando usarlo | Stato |
|---|---|---|---|
| **Agente** (ReAct) | l'LLM a runtime | conversazione, task aperti | ✅ a codice |
| **Multi-Agent** | l'LLM, ma in ruoli strutturati | task decomponibili per dominio | 🎯 design |
| **Flow** | **l'autore** (passi e ordine fissi) | **processi ripetibili e prevedibili** | 🎯 design (questa sezione) |

Un Flow risponde alla domanda *"e quando NON voglio che l'LLM improvvisi?"* — che in B2B arriva sempre. L'autore
definisce i **passi e l'ordine**; l'LLM lavora solo **dentro** i nodi che gli vengono assegnati. Vantaggi:
**ripetibilità** (stessa richiesta → stesso percorso), **controllo costi** (numero di chiamate LLM noto a priori),
**riuso** (un processo multi-step impacchettato e invocabile). È il pattern degli "Agent Flows" di AnythingLLM e, sul
lato trigger, il punto in comune con n8n.

### I nodi esistono già

Un Flow non introduce nuovi mattoni: **riusa i `custom_tools` (http/sql/rag/prompt), le `skills` e — quando ci saranno
— gli `agents`/`agent_teams` come nodi.** Quello che manca oggi è lo strato che li **concatena in modo dichiarativo**,
con passaggio esplicito di output→input tra un passo e il successivo. La topologia `sequential` del Multi-Agent è di
fatto un caso particolare di Flow (A→B→C di soli agenti); il Flow è la versione **più granulare e deterministica**, in
cui un nodo può essere anche una singola chiamata tool, una condizione o una trasformazione.

### Tassonomia dei mattoncini (3 famiglie = 3 gruppi colore)

`cron` **non è un nodo di mezzo, è un mattoncino di trigger** (l'ingresso del flow). I blocchi si dividono in 3 famiglie,
che sul canvas diventano i gruppi di colore:

| Famiglia | Colore | Mattoncini | Ruolo |
|---|---|---|---|
| **Trigger** (entry, 1 per flow) | 🟢 verde | `manual`, `cron`, `chat-as-tool`, `webhook`, `flow-call` | da dove parte il flow |
| **Azione** | 🔵 blu | `tool`, `skill`, `llm`, `http`, `transform`, `flow` (invoca un altro flow) | fanno il lavoro, producono output |
| **Controllo** | 🟠 arancio | `condition` (if/else), `branch`/`join`, `loop` | decidono il percorso (DAG con rami) |

> Ponte col Multi-Agent: i nodi `agent`/`team` (famiglia Azione) arriveranno con l'implementazione del Multi-Agent; il
> nodo `flow` rende i flow **componibili ricorsivamente**.

### Modello I/O tra nodi (il cuore del design)

**Chi converte i dati da un nodo all'altro:** non il nodo produttore né il consumatore, ma il **`BindingResolver`** del
motore, che gira *prima* di eseguire ogni nodo. Tre pezzi:

**1. Busta standard** — ogni nodo ritorna sempre la stessa forma. Lo `status` c'è sempre (risolve i nodi
"fire-and-forget" tipo invio email: `{ status:'ok' }` senza `output`); l'`output` è opzionale.

```
NodeResult {
  status: 'ok' | 'error'     // SEMPRE presente (caso email OK/KO)
  output?: any               // payload JSON — assente per nodi senza dato di ritorno
  error?:  string
  meta?:   { durationMs, ... }
}
```

**2. Stato del run** — il motore accumula gli output per id-nodo, così *qualsiasi* nodo a valle legge *qualsiasi* nodo
a monte (necessario nei rami che si ricongiungono):

```
flow_runs.state = {
  input: { ... },                              // variabili dal trigger/start
  nodes: {
    estrai_pdf: { status:'ok', output:{ righe:[...] } },
    invia_mail: { status:'ok' },               // niente output, solo status
  }
}
```

**3. Binding sul consumatore** — ogni nodo dichiara i propri input come **mapping** sullo stato; il `BindingResolver` li
valuta e passa al nodo gli argomenti già pronti. Estende l'interpolazione esistente (`{{param}}`/`{{secret.KEY}}`) con
due namespace: `{{input.*}}` e `{{nodes.<id>.output.*}}`.

```
nodo "invia_mail":  to = "{{ input.email_cliente }}",  body = "{{ nodes.riassumi.output }}"
nodo "interroga_db": regione = "{{ nodes.estrai_pdf.output.regione }}"
```

**Conversione leggera vs pesante:** il binding fa conversione leggera (pesca campo, interpola, coercizione). Per
ristrutturazioni pesanti si inserisce un nodo **`transform`** (deterministico) o **`llm`** (fuzzy). Sul canvas: i fili =
ordine + disponibilità del dato; il pannello-input del nodo = contratto di conversione (con picker degli output a monte,
stile n8n).

**Decisioni di design (confermate):**
- **Espressioni nel binding:** templating + path (`{{ nodes.A.output.campo }}`, JSONPath) **ovunque**; espressioni **JS
  arbitrarie** ammesse **solo dentro il nodo `transform`**, eseguite in sandbox **`isolated-vm`** (già usata dal runner
  JS delle skill). Niente `eval` di codice utente fuori da lì.
- **Tipi:** **JSON libero** (dynamic). Schema di output per-nodo **facoltativo**, usato solo dall'editor (autocomplete
  del picker + warning), mai bloccante.
- **Topologia:** **DAG con rami** — `condition` biforca, due rami possono andare in **parallelo** e ricongiungersi in un
  nodo `join`. Il motore esegue in **ordine topologico**, non come catena lineare.

### Modello dati

```
flows                          # definizione riusabile (scope come tool/skill: personal|team|org)
  ├── id, name, description
  ├── definition (jsonb)       ← { nodes:[...], edges:[...] } — grafo DAG + binding per-nodo
  ├── trigger (jsonb)          ← { type: manual|cron|chat-as-tool|webhook|flow-call, ...config }
  ├── exposeAsTool (bool)      ← se true, l'agente lo invoca come DynamicStructuredTool
  ├── inputSchema (jsonb)      ← variabili di start (firma del tool / form UI)
  ├── enabled (bool)           ← toggle (come le skill)
  └── scope (personal|team|org) + teamId   ← assertCanManage (personal=owner, org=admin, team=admin/owner)

flow_runs                      # storico esecuzioni (osservabilità + debug)
  ├── id, flowId (FK→flows), userId, projectId (null), triggeredBy (manual|cron|agent|webhook|flow)
  ├── status (running|completed|error|cancelled)
  ├── state (jsonb)            ← input + nodes[].output (vedi sopra)
  ├── nodeRuns (jsonb)         ← per-nodo: status, durationMs, error (timeline debug)
  ├── error (text, null)
  └── startedAt / finishedAt
```

> Nodi/archi vivono **dentro `flows.definition`** (jsonb), non in tabelle `flow_nodes`/`flow_edges`: la topologia si
> legge/scrive in blocco dall'editor, il jsonb evita join e migrazioni a ogni nuovo tipo di nodo.

### Motore di esecuzione

Il `FlowEngine` interpreta `definition` come **DAG**: calcola l'ordine topologico dai nodi-trigger, e per ogni nodo
**(1)** il `BindingResolver` risolve gli input dallo `state`, **(2)** esegue il nodo riusando i service esistenti
(`CustomToolsService.buildToolForTest`/`loadToolsForUser` per `tool`, `SkillsService` per `skill`, il pattern `callLlm`
per `llm`, `isolated-vm` per `transform`), **(3)** scrive il `NodeResult` nello `state`. I `condition` selezionano l'arco
da seguire; i rami indipendenti girano in **parallelo** (`Promise.all`) e si ricongiungono nei `join`. Control-flow
**deterministico** (deciso dall'autore), **LLM confinato** nei nodi `llm`. Error-policy per-nodo (stop | continue |
retry); `flow_runs` persiste stato e timeline per **debug**. Runtime su `StateGraph` di LangGraph (stesso del
Multi-Agent) o interprete dedicato — da decidere in Fetta 1.

### Trigger — il pezzo "n8n-like"

| Trigger | Come parte | Note |
|---|---|---|
| `manual` | UI "Esegui flow" con form delle variabili | Test e run ad-hoc |
| `chat-as-tool` | L'agente lo invoca come tool (`exposeAsTool`) | Il flow diventa un'azione deterministica nella chat |
| `cron` | Schedulato (lega con la riga §16 "CRON") | Flow che parte da solo, senza chat → vera automazione |
| `webhook` | POST esterno con token | Integrazione con sistemi terzi |

`chat-as-tool` + `cron` sono ciò che colma il gap verso n8n: un processo **ripetibile** che può partire **da chat,
da solo, o da un evento esterno**.

### Streaming SSE & costi

Run avviati da chat riusano il canale SSE esistente, estendendo gli eventi con l'attribuzione al nodo:

| `type` | Estensione | Significato |
|---|---|---|
| `flow_node_start` | `{ flowRunId, nodeId, nodeType }` | Inizio esecuzione di un nodo |
| `tool_call` / `tool_result` / `file` | `+ { nodeId }` | Stessi payload di oggi, attribuiti al nodo |
| `flow_node_end` | `{ nodeId, ok }` | Fine nodo |
| `flow_end` | `{ flowRunId, status }` | Flow completato/errore |

I costi continuano ad attribuirsi via `usage/` (`provider/model` per messaggio): i token dei nodi `llm`/`agent` finiscono
sul modello corretto senza modifiche allo schema di usage.

### Rapporto con il Multi-Agent (no duplicazione)

I due sistemi **condividono il runtime `StateGraph`** e si annidano: un **nodo di Flow può essere un agente/team**, e
un **agente può invocare un Flow come tool**. La regola di confine: **Flow = control-flow deciso dall'autore**
(deterministico); **Multi-Agent = control-flow deciso dagli LLM** (supervisor/handoff). La topologia `sequential` del
Multi-Agent resta come scorciatoia per pipeline di soli agenti; il Flow è il caso generale e granulare.

### UI prevista (Settings)

| Sezione | Visibilità | Contenuto |
|---|---|---|
| Flows | Tutti | Lista/CRUD flow, editor a blocchi (nodi + archi + mapping variabili), trigger, `exposeAsTool`, scope |
| Flows / Esecuzioni | Tutti | Storico `flow_runs`, stato, debug per-nodo, ri-esecuzione |

### Roadmap — fette verticali (ognuna funzionante end-to-end, nessun throwaway)

L'obiettivo è la feature **completa**; per arrivarci senza un mezzo-prodotto buttabile si costruisce a fette verticali
(backend+motore+canvas insieme), ciascuna usabile e basata sulla precedente:

1. **Fetta 1 — spina dorsale. ✅ FATTA + VERIFICATA.** Modulo `flows/` (entità `flows`+`flow_runs`, migration),
   `FlowEngine` a DAG + `BindingResolver`, nodi `tool`/`llm`/`condition`, trigger `manual`, **canvas React Flow** base,
   storico `flow_runs`. → un flow vero gira e si vede.
2. **Fetta 2 — copertura nodi. ✅ FATTA + VERIFICATA.** `skill`, `transform` (JS sandbox `isolated-vm`), `http`, `flow`
   (annidato); picker di binding visuale completo (selezione output a monte).
3. **Fetta 3 — trigger esterni. ✅ FATTA + VERIFICATA.** `cron` (ricorrente) e `scheduled` (one-shot "giorno X alle Y")
   su **scheduler BullMQ + Redis** (`FlowSchedulerService`: Job Scheduler per il cron, delayed job per il one-shot;
   `syncAll` al boot riallinea Redis al DB; degrada con grazia se Redis è giù). `webhook` = endpoint pubblico
   `POST /api/flows/webhook/:token` (controller separato, no JWT; token generato alla creazione). `chat-as-tool` =
   flow esposti come `DynamicStructuredTool` via `FlowsService.loadToolsForUser`, agganciato in `resolveAgent`.
   Redis aggiunto a `docker-compose` + `REDIS_URL` (default `redis://localhost:6379`).
4. **Fetta 4 — ✅ FATTA + VERIFICATA.** Nodi `agent`/`team` (ponte Multi-Agent via `MultiAgentService`/ModuleRef),
   error-policy per-nodo (`stop`/`continue`/`retry`), motore **a ondate** (parallelismo reale: rami indipendenti in
   `Promise.all`), nodi `join` (fan-in) e `loop` (map su array via sub-flow). Tutto verificato end-to-end.
5. **Fetta 5 — usabilità & integrazione chat. ✅ FATTA.** Nodo **`chat`** (posta/consegna un messaggio in
   una chat, anche per le automazioni → vedi unread badge in §Auto-Scheduling), **test run per-nodo** (esegue il
   subgraph dei soli predecessori per provare un nodo dall'editor con binding live). Migration `FlowChatDelivery`.

---

## Auto-Scheduling (Design)

> **Stato: IMPLEMENTATO E VERIFICATO.** Modulo `scheduling/`: built-in tool `schedule_task` (sempre
> iniettato nell'agente), `SchedulingService` su BullMQ (cron + one-shot), runner **headless** che ri-esegue l'agente
> (`AgentService.invoke` via ModuleRef) e consegna via notifica; sezione UI "Automazioni". Verificato end-to-end:
> in chat → l'agente programma (cron `* * * * *`) → fire dopo ~27s → istruzione eseguita → `lastResult` consegnato.
> Realizzato il **modello B** (re-invocazione agente). Obiettivo raggiunto: *"da domani alle 8, ogni giorno, controlla
> la mail e riassumi"* viene programmato davvero. **+ Conferma (Opzione 2)**: flusso a due tool sicuro di default
> (`schedule_task`→`pending`, `confirm_scheduled_task`→`active`) — verificato (il pending non scatta finché non
> confermato). **+ Guardrail (Opzione 3)**: `SCHED_MAX_TASKS_PER_USER`/`SCHED_MAX_ACTIVE_RECURRING` via env.
> (Modello A flow-generation: estensione futura.)

### Il gap di oggi

Abbiamo le **rotaie** (scheduler BullMQ, trigger cron/scheduled sui Flow) ma manca la **leva in cabina**: l'agente non
ha alcuno strumento per *creare* una programmazione dalla conversazione. Oggi a quella richiesta l'agente non schedula
nulla (o, peggio, "fa finta"). Serve un ponte NL → automazione programmata.

### Tre assi di decisione

**1. Dove sta l'entry point.** → **Built-in tool, con motore intrinseco.**
- **Skill: esclusa** (giustamente): gira nel sandbox dell'executor, non conosce il backend, non può creare flow né
  registrare job BullMQ.
- **Custom tool**: configurato dall'utente, non garantito presente; lo scheduling è una **primitiva di piattaforma** →
  deve essere sempre disponibile.
- **Built-in tool** (sempre iniettato all'agente) che chiama un **`SchedulingService` intrinseco** (generalizzazione di
  `FlowSchedulerService`). Più una **UI "Automazioni"** per vedere/cancellare i task schedulati. Quindi: *façade
  conversazionale come tool + capacità reale intrinseca nel backend.*

**2. Cosa viene schedulato (la scelta centrale).**

| Modello | Come | Pro | Contro |
|---|---|---|---|
| **A — Flow-generation** (deterministico) | Il task viene compilato in un **Flow** (nodi + trigger) e salvato; il FlowEngine lo riesegue identico | Deterministico, debuggabile/editabile nella UI Flows, economico, osservabile (`flow_runs`) | Il task deve essere esprimibile come grafo; comporre nodi/binding da NL aperta è difficile |
| **B — Re-invocazione agente** (agentico) | Si salva l'istruzione+contesto; al fire un **AgentRunner headless** riesegue l'agente (con i suoi tool) che ri-ragiona e agisce; output consegnato via notifiche/email | Gestisce **qualsiasi** cosa esprimibile in NL ("programma il qualunque"); nessuna composizione di grafo | Non deterministico, ripaga il costo LLM a ogni fire, serve un canale di consegna |

> **NB:** in nessun caso l'LLM deve emettere JSON di flow grezzo (fragile). In modello A, il tool prende uno **spec
> strutturato di alto livello** e il **backend** assembla il flow (oppure, post-Multi-Agent, lo compone un *agente
> flow-author*).

### Raccomandazione: ibrido, default B, promozione ad A

- Built-in tool **`schedule_task`** → registra un job sullo **scheduler BullMQ esistente**.
- Esecuzione default = **modello B** (re-invocazione agente headless): è ciò che fa funzionare davvero "programma
  qualsiasi cosa". Consegna del risultato via canale **notifiche** (Socket.IO già presente) e/o email se c'è un mail
  tool; valutare un thread chat "Automazioni" dove postare gli esiti.
- Quando il task è ben definito → **materializza un Flow** (modello A) per determinismo/costo, visibile/editabile in UI.
- Ponte **Multi-Agent**: il runner headless può eseguire un intero **team**; un *agente-automazione* può decidere A vs B
  e comporre i flow.

### Stato estensioni

- ✅ **UX di conferma (Opzione 2) — FATTA.** Flusso a due tool sicuro di default: `schedule_task` crea il task in stato
  `pending` (NON registrato su BullMQ → non scatta); l'agente riassume e chiede conferma; `confirm_scheduled_task`
  attiva (o elimina). In UI il pending mostra "in attesa" + bottone "Attiva" (`POST /scheduled-tasks/:id/activate`).
- ✅ **Guardrail (Opzione 3) — FATTI.** `SCHED_MAX_TASKS_PER_USER` (default 25) e `SCHED_MAX_ACTIVE_RECURRING`
  (default 10), **configurabili via env**.
- ✅ **Token tracking (Opzione 6) — FATTO.** Util `common/llm-usage.util.ts`. **Team-in-chat** → token aggregati sul
  messaggio assistant (→ dashboard Consumi); **automazioni** → `scheduled_tasks.lastInputTokens/lastOutputTokens` (via
  `AgentService.invokeWithUsage`) mostrati nella UI Automazioni. Verificato (team 44/113; automazione 24173/68).
- ✅ **Guardrail di costo (token) — FATTO.** Cap per-run `SCHED_MAX_TOKENS_PER_RUN` (default 200000, env, 0=off):
  oltre la soglia il task viene **disattivato** + notifica `scheduled_task_disabled`. `scheduled_tasks.totalTokens`
  (bigint) accumula i token su tutti i run (mostrato in UI).
- ✅ **Tool-subset per i run headless — FATTO.** `scheduled_tasks.toolFilter` (default **`none`** = run economico).
  L'agente sceglie i tool necessari al momento dello `schedule_task` (arg `tools`), l'utente li **conferma** (Opzione 2),
  e il run headless carica **solo** quel sottoinsieme: `AgentService.invokeWithUsage(..., toolFilter)` →
  `resolveAgent` pre-filtra i manifest. Decisione **una volta, confermata** (non a ogni run): predicibile, sicura,
  economica.
- ✅ **Consegna esiti in chat (Opzione) — FATTA.** Oltre alla notifica, l'esito di un'automazione può essere **postato
  in un thread chat** dedicato con **unread badge** sulla sidebar (migration `ScheduledTaskChatDelivery`); il nodo
  `chat` dei Flow consente la stessa consegna dai workflow (`FlowChatDelivery`).
- 🔭 **Altre possibili implementazioni future:**
  - **Modello A (flow-generation)**: materializzare un Flow deterministico per task ben definiti (oggi solo modello B,
    re-invocazione agente). Pro: determinismo/costo; contro: compilare NL aperta in un grafo valido.
  - **Automazioni nel dashboard globale** (oggi i token sono per-task, non aggregati nel dashboard): tabella
    `usage_events` + UnionView nel `UsageService`.
  - **Consegna esiti via email** (oltre a notifica e chat).

---

## Cruscotto Attività in corso

> **Stato: FATTO.** Vista **sola-lettura** che aggrega in un unico posto *tutto ciò che è in esecuzione o schedulato*
> per l'utente, dando visibilità trasversale su feature altrimenti sparse (daemon, automazioni, flow).

- **Backend** `activity/` — `ActivityService.getActivity(userId)` esegue in parallelo (`Promise.all`) le query già
  esistenti e ne fa un unico snapshot: **daemon skill** in `running`/`starting` (`DaemonsService.findAll`),
  **automazioni** (`SchedulingService.list`), **flow** con trigger `cron`/`scheduled` ed `enabled`
  (`FlowsService.findAll`), e gli **ultimi 15 run** dei flow (`FlowRun` repo, ordinati per `startedAt`). Riusa i
  service esistenti — nessuna logica di business duplicata. `ActivityController` → `GET /api/activity`.
- **Frontend** — Impostazioni → **Attività**: 4 contatori (daemon attivi, automazioni attive + pending, flow
  schedulati, run recenti) e 4 blocchi con empty-state e badge di stato. **Refetch automatico ogni 10s**
  (`react-query refetchInterval`).
- **Estendibile**: il payload è un singolo snapshot tipizzato; aggiungere una sorgente (es. team-run live, job BullMQ
  in coda) significa una query in più nel `Promise.all` e un blocco in UI.

---

## 16. Funzionalità Future

| Funzionalità                     | Priorità | Note                                                                                                                                                                                                                                                                                                              |
|----------------------------------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ~~Bridge auto-reconnect config~~ | ✅ Fatto  | `handleConfig` confronta command/args/env e riavvia solo il processo cambiato (`configEquals`), senza riavviare il bridge                                                                                                                                                                                         |
| ~~Tool call history / debug~~    | ✅ Fatto  | Tool call persistite su `Message.toolCalls` (name/input/output troncato ~8KB/ok/durationMs). Pannello debug collassabile in `MessageBubble`. Evento SSE `tool_result` per stato ✓/✗ live                                                                                                                          |
| ~~Feedback loop 👍👎~~           | ✅ Fatto  | `message_feedback` + memoria attiva: i feedback con correzione sono vettorizzati in `feedback_memory` e reiniettati nel system prompt sulle richieste simili (scope personal/shared con approvazione admin). Toggle `feedbackMemoryEnabled`                                                                       |
| ~~Memoria utente persistente~~   | ✅ Fatto  | `user_memory` (fatti pending/confirmed) + toggle per-utente `autoMemoryEnabled`. Estrazione automatica a soglia (`autoMemoryThreshold` globale, override `memoryThreshold`) o on-demand; conferma inline in chat (SSE `memory_proposal`); fatti confermati iniettati nel system prompt (livello utente, cacheato) |
| ~~Input vocale (Whisper)~~       | ✅ Fatto  | Pulsante microfono in chat (`MessageInput`): `MediaRecorder` → `POST /api/transcription` (audio transiente, mai su disco) → testo nella textarea, rivedibile prima dell'invio. Engine = endpoint OpenAI-compatibile `/v1/audio/transcriptions`. **Default = servizio interno `whisper-service`** (faster-whisper small, incluso in Docker, provider `internal` auto-configurato via `TRANSCRIPTION_BASE_URL` + sondaggio `/v1/models`); l'admin può scegliere OpenAI/Groq/self-hosted nei campi `transcription*` di `app_config`. Modulo `transcription/`; toggle globale (ON di default) + sezione UI accanto a Embedding; hint lingua da `i18n.language` |
| ~~Token usage dashboard~~        | ✅ Fatto  | Modulo `usage/`: aggregazione token per utente/progetto/modello + costi **stimati provider-aware** (prezzi su `llm_configs`, cache calcolata per provider). Admin vede token+costi (`/api/usage`), utente solo token (`/api/usage/me`). Sezione "Consumi" in Impostazioni                                         |
| ~~Gestione utenti & Team~~       | ✅ Fatto  | CRUD admin utenti + status account (bootstrap 1° admin) · `teams`/`team_memberships` (owner/member) · scope risorse **personal\|team\|org** su tool/skill/datasource (`assertCanManage` + `visibilityWhere`). UI: Impostazioni → Utenti / Team. Vedi [sezione dedicata](#gestione-utenti-team--scope)             |
| ~~Progetti condivisi~~           | ✅ Fatto  | Progetti condivisibili a **N team** via join `project_teams` (ruoli collaborator/viewer); chat e file del progetto visibili a tutti i membri. Vedi [Progetti collaborativi](#gestione-utenti-team--scope)                                                                                                          |
| ~~Allegare documenti al progetto~~ | ✅ Fatto | File di progetto (`?projectId=`) visibili da tutte le chat del progetto + RAG filtrato per progetto (`searchScope:auto`)                                                                                                                                                                                          |
| ~~Chat condivise~~               | ✅ Fatto  | Thread condivisi: ogni membro del progetto vede le chat; collaborator/owner scrivono nello stesso thread (`messages.authorId`), viewer in sola lettura                                                                                                                                                            |
| ~~Auto-Scheduling (programma da chat)~~ | ✅ Fatto | → [sezione dedicata](#auto-scheduling-design). Built-in tool `schedule_task` + `SchedulingService` (BullMQ), runner headless (modello B) + consegna via notifica **e chat** (unread badge) + UI "Automazioni". Modello A (flow-generation) = estensione futura |
| ~~Attività in corso (cruscotto "running")~~ | ✅ Fatto | **Impostazioni → Attività** (`activity/`): daemon skill attivi, automazioni schedulate + pending, flow cron/scheduled attivi, ultimi 15 run. Refetch auto 10s → [Cruscotto Attività](#cruscotto-attività-in-corso) |
| ~~Flows (workflow deterministici)~~  | ✅ Fatto (F1-5) | **COMPLETO** (motore DAG **a ondate/parallelo** + canvas; **12 tipi di nodo** incl. agent/team/loop/join/chat; error-policy/retry; **test run per-nodo**; trigger manual/cron/scheduled/webhook/chat-as-tool su BullMQ+Redis) → [sezione dedicata](#flows). Complementare al Multi-Agent (un nodo può essere un agente, un agente può invocare un flow) |
| ~~CRON, attivazioni una tantum~~ | ✅ Fatto  | Confluito nei trigger `cron`/`scheduled` dei [Flows](#flows) e nell'[Auto-Scheduling](#auto-scheduling-design) (BullMQ + Redis)                                                                                                                                                                                  |
| ~~Multilingua~~                  | ✅ Fatto  | **IT + EN** su tre assi: UI frontend (react-i18next, ~20 namespace, copertura 100%), errori backend (nestjs-i18n + filtro globale `i18n-exception.filter`, 18 namespace per-modulo), lingua di risposta dell'assistente. Persistenza su `User.language`; default = auto-detect browser, fallback `en`. Convenzioni in `I18N_CONVENTIONS.md`                                                                                       |
| ~~Multi Agent~~                  | ✅ Fatto  | **Implementato (Livello 2)** → [sezione dedicata](#multi-agent-livello-2). Modulo `agents/`: agenti riusabili + team (supervisor/sequential/parallel), `chats.agentTeamId`, UI Agenti/Team agenti. Resta solo l'Opzione 4 (StateGraph letterale)                                                                  |

---

## 17. Licenze & Terze Parti

### Licenza del progetto — AGPL-3.0

Copyright © 2026 Andrea Genovese. Licenza unica, libera e open source (vedi [`LICENSING.md`](LICENSING.md)):

- **GNU AGPL-3.0** ([`LICENSE`](../LICENSE)) — gratuita; copyleft di rete (chi offre il software via
  rete/SaaS deve rendere disponibile il sorgente delle proprie modifiche). Fornito "AS IS", senza garanzie.
- **Contributi** — accettati sotto la stessa licenza (*inbound = outbound*, AGPL-3.0); nessun CLA richiesto.

### Terze parti

L'audit completo delle licenze delle dipendenze è in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
(attribuzioni Node + Python + modelli ML, elenco pacchetti raggruppati per licenza).

### Esito audit

- **~1375 pacchetti Node** (workspace `backend`, `frontend`, `bridge`, `executor`) deduplicati per `nome@versione`.
- Distribuzione: MIT (~1132), ISC (85), Apache-2.0 (62), BSD-3 (37), BSD-2 (28), più Unlicense/0BSD/CC0/BlueOak.
- **Nessun copyleft forte (GPL/AGPL/LGPL)** nella distribuzione.
- Dual-license usate sotto l'opzione permissiva: `jszip` → MIT, `oracledb` → Apache-2.0.

### Casi che richiedono attenzione (compliance)

| Componente | Licenza | Nota |
|---|---|---|
| `lightningcss` (+ binario nativo) | MPL-2.0 | Copyleft debole *file-level*; solo tooling di build (Tailwind/Vite), non modificato → nessun obbligo sul codice |
| `caniuse-lite` | CC-BY-4.0 | È un **database** (browserslist a build-time), non codice; richiede attribuzione se ridistribuito |
| Dipendenze dirette Apache-2.0 | Apache-2.0 | `openai`, `mongodb`, `@qdrant/js-client-rest`, `puppeteer`, `rxjs`, `reflect-metadata`, `xlsx`, `oracledb` → conservare NOTICE in caso di redistribuzione |

### Servizi Python

`embedding-service` e `whisper-service`: tutte permissive (FastAPI MIT, uvicorn BSD-3,
sentence-transformers Apache-2.0, torch BSD-3, faster-whisper MIT, CTranslate2 MIT).

### Modelli ML (scaricati a runtime, non ridistribuiti)

| Modello | Uso | Licenza |
|---|---|---|
| `mixedbread-ai/mxbai-embed-large-v1` | Embedding testo | Apache-2.0 |
| OpenAI Whisper (via faster-whisper) | Trascrizione audio | MIT |

Entrambi permissivi, uso commerciale consentito.

> Rigenerare l'elenco dopo update dipendenze: `npx license-checker --production` in ciascun workspace.