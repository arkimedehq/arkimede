# Agent Dataflow — from user prompt to response

Complete path of a chat message: entry, config/threshold resolution, compaction,
context building, agent↔tool loop, streaming and persistence.
References: `backend/src/agent/agent.service.ts` (streamResponse → resolveAgent →
compactHistory → buildMessages → createReactAgent) and `messages.controller`.

Legend: ⚙️ = configurable (admin or user) · 🔒 = hardcoded constant

## Diagram 0 — Overview: the agent and the services

High-level map: how a message comes in, how the agent (LangGraph
`createReactAgent`) reasons with the LLM, and which services/sources it touches through the tools.
The loop and compaction details are in Diagrams A–C.

```mermaid
flowchart LR
  subgraph CLIENT["Client"]
    SPA["💬 Frontend SPA<br/>chat · voice mic · attachments"]
    BRG["🖥️ Electron bridge"]
  end
  BRG --> SPA

  subgraph BE["NestJS Backend — orchestrator"]
    CTRL["messages.controller (SSE)"]
    AGENT["🧠 AgentService<br/>createReactAgent (LangGraph)<br/>compaction · tool selection (RAG/deferred)"]
    CTRL --> AGENT
  end
  SPA -->|"REST + SSE /api"| CTRL

  subgraph LLMS["LLM — llm_configs ⚙️ (cross-provider)"]
    LD["default · chat/agent"]
    LS["summarizer · compaction"]
    LV["vision · images"]
  end
  AGENT <-->|"prompt + tool-calls"| LLMS

  subgraph CORE["State & internal AI services"]
    PG[("PostgreSQL<br/>chat · config · entities")]
    RD[("Redis<br/>BullMQ: scheduling/flow")]
    QD[("Qdrant<br/>RAG vectors")]
    EM["embedding-service"]
    WH["whisper-service<br/>voice → text"]
  end
  AGENT --> PG
  AGENT --> RD
  AGENT -->|"search / ingest"| QD
  QD <--> EM
  CTRL -->|"audio transcription"| WH

  subgraph EXEC["Isolated skill/sandbox execution (security levels)"]
    SE["skill-executor"]
    BK["broker<br/>(only one with the Docker socket)"]
    JOB["runner — ephemeral container-job<br/>cap-drop ALL · rootfs ro · uid 999"]
    EP["egress-proxy<br/>domain allowlist (L3)"]
    OUT[("skills-output<br/>= fileshare 'local'")]
    SE -->|"L2/L3: container-per-job"| BK --> JOB
    JOB --> OUT
    JOB -.->|"L3: filtered network"| EP
  end
  AGENT -->|"skill · run_in_sandbox<br/>(L1: in-process)"| SE
  OUT -->|"downloadable attachments"| CTRL

  subgraph EXT["External sources — DataSource & tools"]
    DSQL[("DataSource<br/>SQL 6+ engines · Mongo · Redis")]
    DFS["fileshare<br/>SMB · SFTP · WebDAV"]
    MCP["MCP servers<br/>http · sse · local"]
    HTTPX["external HTTP APIs"]
  end
  AGENT -->|"custom-tools SQL"| DSQL
  AGENT -->|"files"| DFS
  AGENT -->|"MCP tools"| MCP
  AGENT -->|"custom-tools HTTP"| HTTPX
```

## Diagram 0b — Agent tool fan-out

From the same selected tool set, each category routes to a different service.
The user-memory is not a tool: it is merged into the system prompt.

```mermaid
flowchart TB
  AG["🧠 Agent<br/>selected tool set (semantic RAG / deferred / all)"]

  AG --> CT["custom-tools"]
  AG --> SK["skills"]
  AG --> SB["run_in_sandbox"]
  AG --> SCH["schedule_task · get_current_datetime"]
  AG --> FL["flows-as-tool"]
  AG --> TM["agent / team (multi-agent)"]
  AG --> MC["MCP tools"]
  AG -. "in the system prompt" .-> MEM["user-memory"]

  CT -->|HTTP| EXTA["external APIs"]
  CT -->|SQL/Mongo/Redis| DSA["DataSource"]
  CT -->|RAG| VDB["Qdrant + embedding"]
  SK --> EXX["skill-executor → broker → job"]
  SB --> EXX
  EXX --> OUTA["skills-output (chat attachments)"]
  SCH --> RDA["Redis / BullMQ"]
  FL --> RDA
  TM --> AG
  MEM --> PGA["PostgreSQL"]
```

**How to read them together:** Diagram 0 is the topology (who talks to whom);
Diagram 0b is the tool fan-out (which service each category touches); Diagrams
A–C below are the runtime detail of a single message (context, compaction, tool
loop, streaming).

## Diagram A — Context preparation (phases 1–4)

```mermaid
flowchart TB

UI["💬 Chat UI — user message + attachments"]
UI --> CTRL["messages.controller (SSE)<br/>attachments: embed→RAG · inline→text · attachment→base64"]
CTRL --> HIST[("DB messages<br/>content + toolCalls jsonb")]

HIST --> RA["resolveAgent()"]

CFG["⚙️ app_config (admin)<br/>maxHistoryTokens = 30000<br/>historyCompactionEnabled (default: ON)<br/>historyCompactionThreshold = 80%<br/><br/>⚙️ users (per-user)<br/>maxHistoryTokens override<br/>toolLoadingStrategy/MaxTools/schemaFormat<br/>autoMemoryEnabled · systemPrompt · language"]
CFG --> RA

RA --> BUDGET["budget = user.maxHistoryTokens ?? global<br/>(default 30000 tok)"]

BUDGET --> CEN{"compaction ON<br/>+ chatId?"}
CEN -- "no (no-op)" --> REPLAY
CEN -- "yes" --> TRIG{"summary + fresh<br/>> 80% × budget = 24000 tok?<br/>msg weight = content + toolCalls"}
TRIG -- "no: pass everything" --> REPLAY
TRIG -- "yes" --> COMPACT["keep last ~12000 tok verbatim<br/>(50% of the trigger)<br/>summarize the rest with LLM summarizer ⚙️"]
COMPACT --> ROLL[("chat.summary<br/>rolling, persisted")]
ROLL -- "summary → system prompt<br/>(does not consume history budget)" --> SYS
COMPACT --> REPLAY

REPLAY["buildMessages(): tool-call replay<br/>AIMessage(tool_calls) → ToolMessage×N → AIMessage(text)<br/>⚙️ env: output truncated to 3000 char"]
REPLAY --> TRIM{"expanded history<br/>≤ budget (30000 tok)?"}
TRIM -- "yes" --> FINAL
TRIM -- "no: drop OLDEST WHOLE TURNS<br/>🔒 last · startOn:human · allowPartial:false" --> FINAL

FINAL["📨 final messages =<br/>trimmed history + current msg<br/>+ inline texts + multimodal blocks"]

SYS["🧠 System prompt (single, cross-provider)<br/>── stable/cached prefix ──<br/>base ⚙️admin + user ⚙️ + project ⚙️<br/>+ SKILL.md + user memory + language<br/>── variable blocks ──<br/>summary + feedback (🔒 3 hits) + date/time"]

FINAL --> NEXT(["→ Diagram B: agent loop"])
SYS --> NEXT
```

## Diagram B — Agent loop, tools and output (phases 5–6)

```mermaid
flowchart TB

CTX(["from Diagram A:<br/>messages + system prompt"]) --> LLM

TOOLS["🧰 Assembled tools:<br/>built-in (datetime, schedule_task)<br/>+ custom HTTP/SQL/RAG/prompt + MCP<br/>+ skills + flows + agent-team<br/>↓<br/>ToolSelection.applyStrategy<br/>⚙️ strategy: all | rag-N<br/>⚙️ schemaFormat: full | compact | deferred<br/>(deferred → meta-tool get_tool_instructions)"]
TOOLS --> LLM

LLM["🤖 LLM call"] --> DEC{"tool_calls<br/>in the response?"}

DEC -- "yes (+2 steps in the graph)" --> EXEC["ToolNode executes<br/>e.g. SQL: ⚙️ maxRows=10000 · timeoutMs=60s<br/>⚙️ prefetchTables/AllColumns (per-tool)"]
EXEC -- "ToolMessage (result)" --> LLM

DEC -- "⚙️ env AGENT_RECURSION_LIMIT<br/>reached (default 50 ≈ 25 rounds)" --> RERR["⚠️ GraphRecursionError"]
DEC -- "no → final response" --> OUT["✅ Complete response"]

LLM -. "SSE: chunk (progressive text)" .-> SSE["📡 Chat UI"]
DEC -. "SSE: tool_call" .-> SSE
EXEC -. "SSE: tool_result / file" .-> SSE

OUT --> SAVE[("DB: assistant Message<br/>content + toolCalls<br/>{name, input, output, ok, durationMs}")]
OUT --> TOK[("per-step usage + cache r/w<br/>→ chat.totalInput/OutputTokens")]
SAVE -. "on the next turn:<br/>replay in the history (Diagram A)" .-> CTX
```

## Thresholds and parameters

### Configurable ⚙️ (admin or user)

| Parameter | Where it is configured | Default | Effect on the flow |
|---|---|---|---|
| `maxHistoryTokens` | Admin settings (`app_config`) | 30000 | History token budget: baseline for the compaction trigger (A) and the trim ceiling (A) |
| `users.maxHistoryTokens` | User profile (override) | null = use global | Replaces the global budget for that user |
| `historyCompactionEnabled` | Admin settings (`app_config`) | **true** | Enables the rolling summary; off → trim only (old context is lost) |
| `historyCompactionThreshold` | Admin settings (`app_config`) | 80% (clamp 50–95) | % of the budget beyond which compaction triggers (80% × 30000 = 24000 tok) |
| `toolLoadingStrategy` / `toolLoadingMaxTools` | User profile | all | Which/how many tools get injected (semantic RAG selection over the manifests) |
| `toolSchemaFormat` | User profile | full | `deferred` = SKILL.md on-demand via `get_tool_instructions` (lighter prompt) |
| `autoMemoryEnabled` | User profile | off | Injects the confirmed facts of the user memory into the stable prefix |
| Base / user / project system prompt | Admin / profile / project | — | The 4 prompt levels |
| LLM default + summarizer + vision | `llm_configs` | — | Agent-loop model, rolling-summary model, model for multimodal tasks (image OCR) |
| `maxRows`, `timeoutMs`, `prefetchTables`, `prefetchAllColumns` | `executorConfig` of the individual SQL tool | 10000 / 60s / on | Tool output size (heavily affects history weight) |
| `AGENT_RECURSION_LIMIT` | backend env (`.env`) | 50 (~25 LLM rounds, min 10) | LangGraph step limit per message on `stream()`/`invoke()`; exceeded → `GraphRecursionError` |
| `REPLAY_TOOL_OUTPUT_MAX_CHARS` | backend env (`.env`) | 3000 char (min 500) | Cap for tool output re-injected into the history (replay of previous turns) |

### Hardcoded 🔒

The remaining constants are **correctness invariants or algorithm details**, not tuning
knobs: exposing them in env would allow configurations that break the system.

| Constant | Value | Where | Why it stays hardcoded |
|---|---|---|---|
| Trim | `last` · `startOn:'human'` · `allowPartial:false` | `buildMessages` | API invariant: changing these values can produce orphan `tool_use` or split turns → 400 from the providers |
| Keep-budget compaction | 50% of the trigger | `compactHistory` | Anti-thrashing detail of the algorithm: high values trigger compaction on every turn |
| Feedback-memory | 3 hits | `resolveAgent` | Prompt micro-tuning; if it ever needs adjusting, the right place is `app_config` (next to the toggle), not env |

## Operational notes

- **The budget is always applied** (trim), even with compaction off: the toggle only
  decides whether the excess becomes a summary (memory preserved) or is discarded (memory
  lost). Since the `RaiseHistoryBudget` migration the defaults are a 30000 tok
  budget and compaction ON — previously they were 6000/OFF, too tight for agentic chats with SQL tools.
- The "true" weight of a message in history is `content + toolCalls`: SQL tools with
  prefetch can produce output of tens of kTokens — this is why the replay cap
  (3000 char) and the compaction estimate that also counts the toolCalls exist.
- The summary does NOT consume history budget: it lives in the system prompt (the only valid
  location for all providers), in a separate block so as not to invalidate the Anthropic prompt-cache
  of the stable prefix.
