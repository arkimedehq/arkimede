<div align="center">

# Arkimede

**La piattaforma AI sovrana e self-hosted per i team.**
Esegui agenti AI, workflow deterministici e codice custom in sandbox — multi-tenant, sulla tua infrastruttura, con i tuoi dati che non escono mai di casa.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](docs/LICENSING_it.md#contributi)
![Built with NestJS · React · LangGraph](https://img.shields.io/badge/built_with-NestJS_·_React_·_LangGraph-6E56CF.svg)

[🇬🇧 English](README.md) · 🇮🇹 Italiano

![Arkimede in 45 secondi: l'agente sceglie un tool SQL e risponde, poi lo stesso lavoro gira come flow schedulato](docs/images/demo.gif)

*All'agente viene chiesto quali regioni hanno perso fatturato. Sceglie il tool SQL, interroga il warehouse e risponde. Poi lo stesso lavoro — estrai i numeri, scrivi il digest, pubblicalo al team — gira come flow deterministico su cron. **Improvvisazione e ripetibilità, nello stesso sistema.***

</div>

---

## Perché Arkimede?

La maggior parte dei tool AI self-hosted sceglie una sola corsia: un'interfaccia di chat (Open WebUI, LibreChat), un builder di app/agenti (Dify, Flowise), o un automatore di workflow (n8n). **Arkimede è l'unico prodotto che unisce tutte e tre le cose sotto un vero modello di governance multi-tenant** — così un'intera organizzazione può usare l'AI su un'infrastruttura che controlla, senza mandare i dati a un SaaS di terze parti.

La combinazione difendibile, in un solo prodotto:

- 🧠 **Agenti stateful** (LangGraph ReAct) *e* 🔀 **workflow deterministici** (canvas DAG) — improvvisazione *e* ripetibilità.
- 🧩 **Skill eseguibili** — esegui Python/Node/JS non fidato in una sandbox blindata, un container per job.
- 🔌 **MCP nativo** (Model Context Protocol) — transport `http` · `sse` · `local` · `remote`.
- 🏢 **Multi-tenant by design** — org · team · utenti, con scope risorse `personal | team | org` e progetti condivisi tra più team.
- 🗄️ **Sorgenti dati eterogenee** — SQL (Postgres/MySQL/MSSQL/Oracle/SQLite), MongoDB, Redis e file share (SMB/SFTP/WebDAV).
- 🔒 **Sicurezza a capability** — ogni potere (rete, filesystem, operazioni SQL, MCP `local`) è dichiarato e approvato, con default sicuri.

> **La sovranità del dato è il punto.** Usa il tuo LLM (Anthropic, OpenAI, Gemini, Ollama, LM Studio, DeepSeek, qualsiasi endpoint OpenAI-compatible) o esegui i modelli in locale. Nulla lascia il tuo perimetro se non lo decidi tu.

## Come si colloca

Le due cose di cui un'organizzazione ha davvero bisogno — **governance multi-tenant** e **isolamento a livello di sistema operativo per il codice non fidato** — sono esattamente le due che le alternative mettono dietro a un piano enterprise, a una restrizione di licenza, o non hanno affatto.

| | **Arkimede** | Dify | n8n | Flowise | LibreChat | Open WebUI |
|---|---|---|---|---|---|---|
| **Licenza** | AGPL-3.0 (OSI) | Apache modificata — *source-available* [^1] | Sustainable Use — *source-available* [^2] | Core Apache-2.0; la dir `enterprise/` è proprietaria [^3] | MIT (OSI) | BSD-3 + clausola sul branding — *source-available* [^4] |
| **Governance multi-tenant**<br/>*(gratis, self-hosted)* | ✅ Org · team · utenti, con scoping `personal / team / org` su ogni risorsa | ❌ Un solo workspace. Multipli = Enterprise — **e la licenza vieta di operare in multi-tenant** [^1] | ❌ Progetti, RBAC e condivisione sono tutti esclusi dalla Community [^2] | ❌ I workspace sono solo Cloud/Enterprise [^3] | ⚠️ Ruoli custom + ACL per risorsa + gruppi — ma nessun confine di organizzazione | ⚠️ Gruppi + RBAC solo additivo — ma nessun confine di organizzazione |
| **Esecuzione di codice non fidato** | ✅ Container **per singolo job** — cap-drop, rootfs read-only, non-root, allowlist di egress, gVisor opzionale | ✅ `dify-sandbox`: allowlist seccomp, ma **un container condiviso da tutti i tenant** | ⚠️ I task runner sono in modalità **internal** di default — la doc di n8n stessa la definisce "un rischio di sicurezza" in produzione [^5] | ⚠️ `vm2` in-process; Python solo tramite il SaaS **cloud** E2B | ✅ NsJail / microVM libkrun (Apache-2.0, self-hostabile) | ❌ Gira **in-process** — la doc lo definisce "equivalente a root". I container per utente sono a licenza enterprise |
| **Workflow deterministici (DAG)** | ✅ 12 tipi di nodo | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Agente stateful (loop sui tool)** | ✅ LangGraph ReAct | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Trasporti MCP (client)** | `http` · `sse` · `local` (stdio) · `remote` | Solo HTTP (niente stdio) | SSE + streamable HTTP | stdio + SSE + HTTP | stdio + SSE + HTTP | Solo streamable HTTP, **riservato agli admin** |
| **RAG** | ✅ Qdrant / PGVector / Chroma / Astra | ✅ | ✅ | ✅ | ✅ solo pgvector, come servizio a parte | ✅ |
| **Stelle su GitHub** | *appena partiti* | ~149k | ~196k | ~55k | ~41k | ~145k |

**Dove ci battono — onestamente.** Sono tutti più vecchi di anni, molto più collaudati, e hanno ecosistemi che noi non abbiamo. Il catalogo di integrazioni di n8n (400+ nodi) è di un'altra categoria. Open WebUI e LibreChat sono client di *pura chat* migliori, più rifiniti schermata per schermata. Dify ha più provider di modelli. Se ti serve uno strumento maturo a workspace singolo e il multi-tenant non è un requisito, oggi molto probabilmente conviene uno di loro.

**Scegli Arkimede quando** a doverlo far girare è un'organizzazione, non un singolo sviluppatore: più team, risorse che non devono trapelare tra loro, codice di terze parti che non deve toccare l'host, e dati che non devono uscire dall'azienda.

*Verificato su licenze, documentazione e sorgenti il 2026-07-14. Qualcosa di sbagliato o non più attuale? [Apri una issue](https://github.com/arkimedehq/arkimede/issues) — correggiamo la tabella.*

[^1]: [LICENSE di Dify](https://raw.githubusercontent.com/langgenius/dify/main/LICENSE): *"you may not use the Dify source code to operate a multi-tenant environment"* — e *"one tenant corresponds to one workspace"* — più una clausola che vieta di rimuovere il logo. GitHub la classifica `NOASSERTION`. Per correttezza: i cinque ruoli predefiniti *ci sono* nella community edition ([account.py](https://github.com/langgenius/dify/blob/main/api/models/account.py)); è solo l'[RBAC granulare](https://github.com/langgenius/dify/blob/main/api/services/enterprise/rbac_service.py) a essere riservato all'enterprise. Il workspace singolo è confermato dal [pricing](https://dify.ai/pricing) e dall'assenza di un endpoint per creare workspace.
[^2]: [Sustainable Use License di n8n](https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md): *"You may use or modify the software only for your own internal business purposes or for non-commercial or personal use."* Le esclusioni della Community (Progetti, RBAC, condivisione, SSO) sono nella [documentazione di n8n](https://docs.n8n.io/deploy/host-n8n/community-edition-features): *"In Community Edition, only the instance owner and the user who creates workflows or credentials can access them."*
[^3]: [LICENSE.md di Flowise](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md): Apache-2.0 tranne `packages/server/src/enterprise` e `IdentityManager.ts`, che hanno una licenza commerciale proprietaria — ed è esattamente lì che vive il codice del multi-tenant. Senza chiave enterprise la piattaforma resta `OPEN_SOURCE` e il set di funzionalità è vuoto ([IdentityManager.ts](https://github.com/FlowiseAI/Flowise/blob/main/packages/server/src/IdentityManager.ts)).
[^4]: La [LICENSE di Open WebUI](https://github.com/open-webui/open-webui/blob/main/LICENSE) (clausola 4, da v0.6.6) vieta di alterare o rimuovere il suo branding a meno di avere ≤50 utenti finali in 30 giorni, un permesso scritto o una licenza enterprise. A loro merito, RBAC e SSO **non** sono a pagamento — ma [i container di esecuzione isolati per utente sì](https://github.com/open-webui/terminals/blob/main/LICENSE).
[^5]: [Documentazione dei task runner di n8n](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-task-runners): *"Using internal mode in production environments can pose a security risk. For production deployments, use external mode."* E internal è il default. Due cose che spesso si leggono sbagliate e che qui non ripetiamo: n8n non usa più `vm2`, e il suo Python non è più Pyodide.

*Tutto quanto sopra è stato letto dalle licenze, dalla documentazione e dai sorgenti dei progetti stessi — non da articoli di terze parti. Due affermazioni da correggere ovunque le si veda ripetute: il code interpreter di LibreChat [non è più un servizio a pagamento](https://github.com/ClickHouse/code-interpreter) (è Apache-2.0 e self-hostabile da metà 2026), e Dify i ruoli nella community edition ce li ha.*

## Screenshot

|  |  |
| :--: | :--: |
| ![Chat con una tool call](docs/images/chat.png)<br/>**Chat** — un agente stateful che sceglie il tool giusto, lo esegue e risponde col risultato. | ![Canvas dei flow](docs/images/flows.png)<br/>**Flows** — workflow DAG deterministici: HTTP, LLM, condizioni, tool, skill, sub-flow, su cron. |
| ![Tool custom](docs/images/tools.png)<br/>**Tool** — tool custom REST / SQL / RAG / prompt, con segreti cifrati e scope `personal · team · org`. | ![Marketplace delle skill](docs/images/skills-marketplace.png)<br/>**Skills** — installa pacchetti eseguibili Python/Node/JS dal registry; girano in sandbox. |
| ![Team di agenti](docs/images/agent-teams.png)<br/>**Team di agenti** — componi agenti con una topologia (supervisor / sequential / parallel) ed esponi il team come tool. | ![Impostazioni sistema AI](docs/images/ai-system.png)<br/>**Sistema AI** — più configurazioni LLM (default / summarizer / vision) e ottimizzazione del prompt dei tool. |

## Avvio rapido

> Richiede Docker + Docker Compose. Avvia l'intero stack (Postgres, Qdrant, Redis, servizi embedding e whisper, skill executor, backend, frontend).
>
> **Footprint:** a riposo l'intero stack occupa **~2 GB di RAM** — i due servizi ML fanno la parte del leone (embedding `mxbai-embed-large` ~1 GB, Whisper `small`/`int8` ~0,4 GB); tutto il resto insieme sta sotto i 550 MB. **4 GB di RAM sono un minimo comodo**; 8 GB consigliati per un uso reale (utenti concorrenti, RAG attivo). Solo CPU di default — nessuna GPU necessaria. Prevedi ~10 GB di disco per immagini, modelli e lo store Nix persistente. Puoi togliere il servizio embedding (−1 GB) se non ti serve il RAG, o Whisper (−0,4 GB) se non ti serve l'input vocale.

```bash
git clone https://github.com/arkimedehq/arkimede.git
cd arkimede
./scripts/install.sh
```

L'**installer guidato** fa tutto: preflight Docker → genera tutti i segreti → scegli un livello di isolamento per l'esecuzione di skill/sandbox (**Standard / Isolato / Massimo**) → builda le immagini necessarie → avvia lo stack. È idempotente — puoi rilanciarlo quando vuoi. Poi gestisci lo stack con il wrapper che genera:

```bash
./scripts/compose.sh ps         # stato
./scripts/compose.sh logs -f    # segui i log
./scripts/compose.sh down       # ferma
```

Per aggiornare un deployment attivo a una versione più recente — fa backup, pull, rebuild e restart, preservando dati e configurazione:

```bash
./scripts/update.sh
```

Vedi [**Aggiornare** nella guida](docs/GUIDE_it.md#28-aggiornare-un-deployment-esistente) per cosa fa e l'equivalente manuale.

<details>
<summary><b>Setup manuale</b> (senza l'installer)</summary>

```bash
cp .env.example .env
```

Compila i segreti obbligatori nel `.env` (il backend **fa fail-fast** se ne manca uno o è debole — genera ognuno con `openssl rand -hex 32`):

```bash
JWT_SECRET=          # min 32 caratteri casuali — altrimenti l'app non parte
TOOL_SECRETS_KEY=    # 64 caratteri hex — chiave AES-256-GCM per i segreti a riposo
RUN_TOKEN_SECRET=    # firma i token dei run interni
SERVICE_API_KEY=     # auth mesh: backend ↔ executor ↔ broker
DB_PASSWORD=         # password Postgres
```

Poi avvialo:

```bash
# Sviluppo (espone le porte dei servizi, comodità dev)
docker compose up -d

# Produzione (i servizi interni NON hanno porte host; richiede i segreti sopra)
docker compose -f docker-compose.yml up -d
```

Per gli overlay di isolamento (broker / allowlist egress) che `install.sh` collega in automatico, vedi **[GUIDE.md](docs/GUIDE.md)**.

</details>

- Frontend → http://localhost:5173
- API backend → http://localhost:3000 · Swagger → http://localhost:3000/api/docs

Il **primo utente registrato diventa admin**. Provider LLM, embedding e vector DB si configurano dalla UI (**Impostazioni → Sistema AI**) — nessuna API key nei file.

Per lo sviluppo non-Docker, l'accesso da LAN e gli overlay di hardening opzionali, vedi **[GUIDE.md](docs/GUIDE.md)**.

## Deploy senza build

Non vuoi compilare dal sorgente? Usa il **bundle pull-based** — pochi KB di file compose che
scaricano immagini già pronte dal GitHub Container Registry (`ghcr.io/arkimedehq/arkimede-*`)
invece di compilare qualcosa in locale:

```bash
git clone https://github.com/arkimedehq/arkimede-deploy.git
cd arkimede-deploy
./install-hub.sh
```

`install-hub.sh` è lo stesso flusso guidato di `install.sh` (segreti, livello di isolamento,
device embedding) ma **scarica** le immagini invece di buildarle. Fissa `ARKIMEDE_VERSION` nel
`.env` a un tag di release per deploy riproducibili. Dettagli completi nel repo
[arkimede-deploy](https://github.com/arkimedehq/arkimede-deploy).

> Build da sorgente (questo repo, `./scripts/install.sh`) e pull-and-run
> ([arkimede-deploy](https://github.com/arkimedehq/arkimede-deploy)) avviano lo **stesso** stack —
> scegli quello che preferisci.

## I quattro pilastri

Oltre alla chat, quattro sistemi integrati — e interconnessi (i flow sono tool dell'agente e possono invocare agenti/team; le automazioni girano headless e possono usare un team):

| Pilastro | Cosa fa |
|---|---|
| 🤖 **Agente** | Agente LangGraph ReAct con tool custom, server MCP, RAG e system prompt a 4 livelli (base → utente → progetto → skill). |
| 🔀 **Flows** | Canvas DAG visuale per workflow ripetibili. 12 tipi di nodo (`tool`, `llm`, `condition`, `http`, `skill`, `transform`, `flow`, `agent`, `team`, `loop`, `join`, `chat`); trigger: manual, cron, scheduled, webhook, chat-as-tool. |
| 👥 **Multi-Agent** | Agenti riusabili composti in team con topologie `supervisor` / `sequential` / `parallel`. Agent-as-tool per la delega gerarchica. |
| ⏰ **Auto-Scheduling** | Programma automazioni *dalla chat* («ogni mattina alle 8 controlla la mail e riassumi»). Conferma di default, runner headless, consegna via notifica o thread chat dedicato, con guardrail token/costo per run. |

Altre funzionalità: **tool custom** no-code (HTTP/SQL/RAG/prompt), **RAG con scope** (universale/progetto/personale), **DataSource**, **Skill eseguibili**, una **Sandbox** per codice arbitrario (`run_in_sandbox`), **streaming SSE** con rilevamento automatico dei file, input vocale (Whisper), i18n (EN/IT) e un **bridge** Electron per i processi MCP locali.

👉 Riferimento completo delle funzionalità e architettura: **[PROJECT.md](docs/PROJECT.md)**. Creare Skill: **[SKILLS.md](docs/SKILLS.md)**.

## Client da terminale (CLI)

Preferisci la shell? La CLI `arkimede` (in `cli/`) replica login e chat da
qualsiasi terminale — TUI full-screen (sidebar delle chat, streaming SSE
live, righe di stato dei tool, Esc per fermare la generazione) con un
fallback a righe `--plain` che la rende scriptabile via pipe. Include un
pannello impostazioni a schede (profilo, config LLM con CRUD completo, tool,
skill, data source, server MCP, consumo token) che parla con la stessa API e
gli stessi permessi della web UI. Linux/macOS, Node ≥ 18.

```bash
npm install -g arkimede-cli        # oppure build da sorgente in cli/
arkimede login --url http://localhost:3000
arkimede            # apre la TUI
```

👉 Riferimento completo: **[CLI_it.md](docs/CLI_it.md)**.

## Stack tecnologico

| Layer | Tecnologia |
|---|---|
| Backend API + Agent | NestJS 10 (TypeScript) |
| Orchestrazione AI | LangChain.js + LangGraph |
| LLM | Configurabile da UI: Anthropic, OpenAI, Gemini, Ollama, LM Studio, DeepSeek, qualsiasi OpenAI-compatible |
| Frontend | React 18 + Vite + Tailwind CSS |
| Database app | PostgreSQL + TypeORM |
| Vector DB | Qdrant (default) / PGVector / Chroma / AstraDB |
| Coda / scheduler | BullMQ + Redis |
| Skill executor | Sidecar Node.js (Fastify) — runner Python/JS/Node |
| Isolamento skill | Egress allowlist (Squid), capability `network`/`filesystem` dichiarate, container-per-job via broker (cap-drop, read-only, non-root, gVisor opzionale) |
| Packaging | Docker Compose (base sicuro + overlay `egress`/`broker`) |

## Architettura

```
[Browser]
    │
    ├── React SPA (Vite + Tailwind) — JWT auth · streaming SSE · upload file
    │
    └── REST + SSE /api/* ◄─────────────────────────────────────────────┐
                   ▼                                                      │
           NestJS Backend :3000                                          │
                   │                                                      │
              AgentModule — LangGraph ReAct Agent                        │
                   │                                                      │
    ┌──────────────┼──────────────────────────┐                          │
    ▼              ▼              ▼            ▼                          │
CustomTools    McpServers   DataSources   VectorDb                       │
 http/sql/rag  http/sse/    SQL/Mongo/    Qdrant/PGV/                     │
               local/remote Redis         Chroma/Astra                   │
                   │                                                      │
              McpBridgeGateway (WebSocket /mcp-bridge)                    │
                   │                                                      │
              Electron Bridge ◄────────────────────────────────────────┘
              └─ McpProcess (stdio → JSON-RPC)
```

## Sicurezza & isolamento

Arkimede usa un **modello a capability**: ogni potere (rete, filesystem, operazioni SQL, MCP `local`) è *dichiarato e approvato*, con default sicuri e un soffitto legato all'identità — mai implicito e globale.

- **AES-256-GCM** autenticata per i segreti; `TOOL_SECRETS_KEY` obbligatoria (fail-fast).
- **Docker prod sicuro**: i servizi interni non hanno porte host; password obbligatorie.
- **MCP `local`** ristretto agli admin; **guard anti-SSRF** su `http`/`sse` (blocca metadata cloud, RFC1918, localhost).
- **Skill** (codice di terze parti non fidato): egress allowlist, filesystem per-tenant access-aware, container-per-job blindati via broker, capability dichiarate, checksum dei pacchetti.
- **Audit log strutturato** sui chokepoint (auth, admin, esecuzioni, file, SQL, MCP) con identità "runs-as".

## Documentazione

| Doc | Contenuto |
|---|---|
| [PROJECT.md](docs/PROJECT.md) | Approfondimento completo prodotto & architettura |
| [GUIDE.md](docs/GUIDE.md) | Guida uso & sviluppo (setup, overlay, LAN, note dev) |
| [CLI_it.md](docs/CLI_it.md) | Client da terminale (TUI, REPL, pannello impostazioni) |
| [SKILLS.md](docs/SKILLS.md) | Come creare Skill (schema, template, convenzioni) |
| [MEMORY.md](docs/MEMORY.md) | Design della memoria agentica (A-MEM) |
| [LICENSING_it.md](docs/LICENSING_it.md) | Licenza (AGPL-3.0) e termini di contribuzione |
| [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md) | Attribuzioni di terze parti |

## Contribuire

I contributi sono benvenuti! Vengono accettati sotto la licenza del progetto — **AGPL-3.0**, *inbound = outbound*: aprendo una Pull Request accetti di licenziare il tuo contributo sotto AGPL-3.0. Nessun CLA — solo un leggero sign-off [DCO](DCO) (`git commit -s`). Vedi [CONTRIBUTING](CONTRIBUTING.md).

## Sostieni il progetto

Arkimede è libero e open source sotto AGPL-3.0. Se è utile a te o alla tua organizzazione, puoi sostenerne lo sviluppo tramite [GitHub Sponsors](https://github.com/sponsors/andreagenovese). La sponsorizzazione è del tutto volontaria: **non** modifica la licenza né concede diritti aggiuntivi — serve solo a sostenere la manutenzione e le nuove funzionalità.

## Licenza

Arkimede è software libero e open source sotto **GNU AGPL-3.0** (vedi [LICENSE](LICENSE) e [LICENSING_it.md](docs/LICENSING_it.md)):

- 🆓 Libero da usare, modificare e self-hostare — anche come servizio di rete (SaaS) — **a condizione di rendere disponibile il codice sorgente corrispondente sotto AGPL-3.0** (copyleft di rete, art. 13).
- Il software è fornito **"AS IS", senza garanzie né responsabilità** (AGPL-3.0 §15–16).

Tutte le dipendenze distribuite sono sotto licenze permissive (MIT, ISC, BSD, Apache-2.0) o copyleft debole a livello di file (MPL-2.0, solo build tooling) — **nessun copyleft forte (GPL/LGPL) tra le dipendenze**. Vedi [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
