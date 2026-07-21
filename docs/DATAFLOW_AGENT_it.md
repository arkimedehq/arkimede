# Dataflow Agent — dal prompt utente alla risposta

Percorso completo di un messaggio chat: ingresso, risoluzione config/soglie, compaction,
costruzione del contesto, loop agente↔tool, streaming e persistenza.
Riferimenti: `backend/src/agent/agent.service.ts` (streamResponse → resolveAgent →
compactHistory → buildMessages → createReactAgent) e `messages.controller`.

Legenda: ⚙️ = configurabile (admin o utente) · 🔒 = costante hardcoded

## Diagramma 0 — Vista d'insieme: l'agente e i servizi

Mappa di alto livello: come un messaggio entra, come l'agente (LangGraph
`createReactAgent`) ragiona col LLM e quali servizi/sorgenti tocca tramite i tool.
I dettagli del loop e della compaction sono nei Diagrammi A–C.

```mermaid
flowchart LR
  subgraph CLIENT["Client"]
    SPA["💬 Frontend SPA<br/>chat · mic voce · allegati"]
    BRG["🖥️ Electron bridge"]
  end
  BRG --> SPA

  subgraph BE["Backend NestJS — orchestratore"]
    CTRL["messages.controller (SSE)"]
    AGENT["🧠 AgentService<br/>createReactAgent (LangGraph)<br/>compaction · selezione tool (RAG/deferred)"]
    CTRL --> AGENT
  end
  SPA -->|"REST + SSE /api"| CTRL

  subgraph LLMS["LLM — llm_configs ⚙️ (cross-provider)"]
    LD["default · chat/agente"]
    LS["summarizer · compaction"]
    LV["vision · immagini"]
  end
  AGENT <-->|"prompt + tool-calls"| LLMS

  subgraph CORE["Stato & servizi AI interni"]
    PG[("PostgreSQL<br/>chat · config · entità")]
    RD[("Redis<br/>BullMQ: scheduling/flow")]
    QD[("Qdrant<br/>vettori RAG")]
    EM["embedding-service"]
    WH["whisper-service<br/>voce → testo"]
  end
  AGENT --> PG
  AGENT --> RD
  AGENT -->|"search / ingest"| QD
  QD <--> EM
  CTRL -->|"trascrizione audio"| WH

  subgraph EXEC["Esecuzione isolata skill/sandbox (livelli di sicurezza)"]
    SE["skill-executor"]
    BK["broker<br/>(unico col socket Docker)"]
    JOB["runner — container-job effimero<br/>cap-drop ALL · rootfs ro · uid 999"]
    EP["egress-proxy<br/>allowlist domini (L3)"]
    OUT[("skills-output<br/>= fileshare 'local'")]
    SE -->|"L2/L3: container-per-job"| BK --> JOB
    JOB --> OUT
    JOB -.->|"L3: rete filtrata"| EP
  end
  AGENT -->|"skill · run_in_sandbox<br/>(L1: in-process)"| SE
  OUT -->|"allegati scaricabili"| CTRL

  subgraph EXT["Sorgenti esterne — DataSource & tool"]
    DSQL[("DataSource<br/>SQL 6+ engine · Mongo · Redis")]
    DFS["fileshare<br/>SMB · SFTP · WebDAV"]
    MCP["MCP servers<br/>http · sse · local"]
    HTTPX["HTTP API esterne"]
  end
  AGENT -->|"custom-tools SQL"| DSQL
  AGENT -->|"files"| DFS
  AGENT -->|"MCP tools"| MCP
  AGENT -->|"custom-tools HTTP"| HTTPX
```

## Diagramma 0b — Fan-out dei tool dell'agente

Dallo stesso set di tool selezionato, ogni categoria instrada verso un servizio
diverso. La user-memory non è un tool: viene fusa nel system prompt.

```mermaid
flowchart TB
  AG["🧠 Agente<br/>set tool selezionato (RAG semantica / deferred / all)"]

  AG --> CT["custom-tools"]
  AG --> SK["skills"]
  AG --> SB["run_in_sandbox"]
  AG --> SCH["schedule_task · get_current_datetime"]
  AG --> FL["flows-as-tool"]
  AG --> TM["agent / team (multi-agente)"]
  AG --> MC["MCP tools"]
  AG -. "nel system prompt" .-> MEM["user-memory"]

  CT -->|HTTP| EXTA["API esterne"]
  CT -->|SQL/Mongo/Redis| DSA["DataSource"]
  CT -->|RAG| VDB["Qdrant + embedding"]
  SK --> EXX["skill-executor → broker → job"]
  SB --> EXX
  EXX --> OUTA["skills-output (allegati chat)"]
  SCH --> RDA["Redis / BullMQ"]
  FL --> RDA
  TM --> AG
  MEM --> PGA["PostgreSQL"]
```

**Come leggerli insieme:** il Diagramma 0 è la topologia (chi parla con chi); il
Diagramma 0b è il fan-out dei tool (quale servizio tocca ciascuna categoria); i
Diagrammi A–C sotto sono il dettaglio runtime di un singolo messaggio (contesto,
compaction, loop tool, streaming).

## Diagramma A — Preparazione del contesto (fasi 1–4)

```mermaid
flowchart TB

UI["💬 UI Chat — messaggio utente + allegati"]
UI --> CTRL["messages.controller (SSE)<br/>allegati: embed→RAG · inline→testo · attachment→base64"]
CTRL --> HIST[("DB messages<br/>content + toolCalls jsonb")]

HIST --> RA["resolveAgent()"]

CFG["⚙️ app_config (admin)<br/>maxHistoryTokens = 30000<br/>historyCompactionEnabled (default: ON)<br/>historyCompactionThreshold = 80%<br/><br/>⚙️ users (per-utente)<br/>maxHistoryTokens override<br/>toolLoadingStrategy/MaxTools/schemaFormat<br/>autoMemoryEnabled · systemPrompt · language"]
CFG --> RA

RA --> BUDGET["budget = user.maxHistoryTokens ?? global<br/>(default 30000 tok)"]

BUDGET --> CEN{"compaction ON<br/>+ chatId?"}
CEN -- "no (no-op)" --> REPLAY
CEN -- "sì" --> TRIG{"summary + freschi<br/>> 80% × budget = 24000 tok?<br/>peso msg = content + toolCalls"}
TRIG -- "no: passa tutto" --> REPLAY
TRIG -- "sì" --> COMPACT["tieni verbatim ultimi ~12000 tok<br/>(50% del trigger)<br/>riassumi il resto con LLM summarizer ⚙️"]
COMPACT --> ROLL[("chat.summary<br/>rolling, persistito")]
ROLL -- "summary → system prompt<br/>(non consuma budget history)" --> SYS
COMPACT --> REPLAY

REPLAY["buildMessages(): replay tool-call<br/>AIMessage(tool_calls) → ToolMessage×N → AIMessage(testo)<br/>⚙️ env: output troncato a 3000 char"]
REPLAY --> TRIM{"storia espansa<br/>≤ budget (30000 tok)?"}
TRIM -- "sì" --> FINAL
TRIM -- "no: scarta TURNI INTERI più vecchi<br/>🔒 last · startOn:human · allowPartial:false" --> FINAL

FINAL["📨 messages finali =<br/>history trimmata + msg corrente<br/>+ testi inline + block multimodali"]

SYS["🧠 System prompt (unico, cross-provider)<br/>── prefisso stabile/cacheato ──<br/>base ⚙️admin + user ⚙️ + project ⚙️<br/>+ SKILL.md + memoria utente + lingua<br/>── blocchi variabili ──<br/>summary + feedback (🔒 3 hit) + data/ora"]

FINAL --> NEXT(["→ Diagramma B: loop agente"])
SYS --> NEXT
```

## Diagramma B — Loop agente, tool e output (fasi 5–6)

```mermaid
flowchart TB

CTX(["da Diagramma A:<br/>messages + system prompt"]) --> LLM

TOOLS["🧰 Tool assemblati:<br/>built-in (datetime, schedule_task)<br/>+ custom HTTP/SQL/RAG/prompt + MCP<br/>+ skills + flows + agent-team<br/>↓<br/>ToolSelection.applyStrategy<br/>⚙️ strategy: all | rag-N<br/>⚙️ schemaFormat: full | compact | deferred<br/>(deferred → meta-tool get_tool_instructions)"]
TOOLS --> LLM

LLM["🤖 Chiamata LLM"] --> DEC{"tool_calls<br/>nella risposta?"}

DEC -- "sì (+2 step nel grafo)" --> EXEC["ToolNode esegue<br/>es. SQL: ⚙️ maxRows=10000 · timeoutMs=60s<br/>⚙️ prefetchTables/AllColumns (per-tool)"]
EXEC -- "ToolMessage (risultato)" --> LLM

DEC -- "⚙️ env AGENT_RECURSION_LIMIT<br/>raggiunto (default 50 ≈ 25 giri)" --> RERR["⚠️ GraphRecursionError"]
DEC -- "no → risposta finale" --> OUT["✅ Risposta completa"]

LLM -. "SSE: chunk (testo progressivo)" .-> SSE["📡 UI Chat"]
DEC -. "SSE: tool_call" .-> SSE
EXEC -. "SSE: tool_result / file" .-> SSE

OUT --> SAVE[("DB: assistant Message<br/>content + toolCalls<br/>{name, input, output, ok, durationMs}")]
OUT --> TOK[("usage per-step + cache r/w<br/>→ chat.totalInput/OutputTokens")]
SAVE -. "al turno successivo:<br/>replay nella history (Diagramma A)" .-> CTX
```

## Soglie e parametri

### Configurabili ⚙️ (admin o utente)

| Parametro | Dove si configura | Default | Effetto nel flusso |
|---|---|---|---|
| `maxHistoryTokens` | Settings admin (`app_config`) | 30000 | Budget token della history: base per trigger compaction (A) e tetto del trim (A) |
| `users.maxHistoryTokens` | Profilo utente (override) | null = usa global | Sostituisce il budget globale per quell'utente |
| `historyCompactionEnabled` | Settings admin (`app_config`) | **true** | Accende il rolling summary; spento → solo trim (il contesto vecchio si perde) |
| `historyCompactionThreshold` | Settings admin (`app_config`) | 80% (clamp 50–95) | % del budget oltre cui scatta la compaction (80% × 30000 = 24000 tok) |
| `toolLoadingStrategy` / `toolLoadingMaxTools` | Profilo utente | all | Quali/quanti tool vengono iniettati (selezione semantica RAG sui manifest) |
| `toolSchemaFormat` | Profilo utente | full | `deferred` = SKILL.md on-demand via `get_tool_instructions` (prompt più leggero) |
| `autoMemoryEnabled` | Profilo utente | off | Inietta i fatti confermati della memoria utente nel prefisso stabile |
| System prompt base / utente / progetto | Admin / profilo / progetto | — | I 4 livelli del prompt |
| LLM default + summarizer + vision | `llm_configs` | — | Modello del loop agente, modello dei rolling summary, modello per task multimodali (OCR immagini) |
| `maxRows`, `timeoutMs`, `prefetchTables`, `prefetchAllColumns` | `executorConfig` del singolo tool SQL | 10000 / 60s / on | Dimensione output dei tool (incide molto sul peso della history) |
| `AGENT_RECURSION_LIMIT` | env backend (`.env`) | 50 (~25 giri LLM, min 10) | Limite step LangGraph per messaggio su `stream()`/`invoke()`; superato → `GraphRecursionError` |
| `REPLAY_TOOL_OUTPUT_MAX_CHARS` | env backend (`.env`) | 3000 char (min 500) | Cap per output di tool ri-iniettati nella history (replay dei turni precedenti) |

### Hardcoded 🔒

Le costanti restanti sono **invarianti di correttezza o dettagli d'algoritmo**, non manopole
di tuning: esporle in env permetterebbe configurazioni che rompono il sistema.

| Costante | Valore | Dove | Perché resta hardcoded |
|---|---|---|---|
| Trim | `last` · `startOn:'human'` · `allowPartial:false` | `buildMessages` | Invariante API: cambiare questi valori può produrre `tool_use` orfani o turni spezzati → 400 dai provider |
| Keep-budget compaction | 50% del trigger | `compactHistory` | Dettaglio anti-thrashing dell'algoritmo: valori alti fanno scattare la compaction a ogni turno |
| Feedback-memory | 3 hit | `resolveAgent` | Micro-tuning del prompt; se mai servisse regolarlo, la sede giusta è `app_config` (accanto al toggle), non l'env |

## Note operative

- **Il budget è applicato sempre** (trim), anche con compaction spenta: il toggle decide
  solo se l'eccedenza diventa un summary (memoria conservata) o viene scartata (memoria
  persa). Dal 2026-06-11 (migration `RaiseHistoryBudget`) i default sono budget 30000 tok
  e compaction ON — prima erano 6000/OFF, troppo stretti per chat agentiche con tool SQL.
- Il peso "vero" di un messaggio in history è `content + toolCalls`: i tool SQL con
  prefetch possono produrre output da decine di kToken — per questo esistono il cap di
  replay (3000 char) e la stima compaction che conta anche i toolCalls.
- Il summary NON consuma budget history: vive nel system prompt (unica sede valida per
  tutti i provider), in un blocco separato per non invalidare la prompt-cache Anthropic
  del prefisso stabile.
