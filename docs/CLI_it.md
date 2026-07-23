# Arkimede CLI — Client da terminale

`arkimede` è il client ufficiale da terminale: login e chat con i tuoi agenti
direttamente dalla shell, verso qualsiasi backend Arkimede in esecuzione.
Replica l'esperienza di login e chat del frontend web — stessa API REST +
SSE, stessa auth JWT, zero modifiche lato server — più un pannello
impostazioni per l'amministrazione quotidiana. Linux e macOS, Node ≥ 18.17.

Vive nella workspace `cli/` del monorepo.

## Installazione

Da npm (consigliato — funziona con qualsiasi metodo di installazione,
incluso il pull-based [arkimede-deploy](https://github.com/arkimedehq/arkimede-deploy)):

```bash
npm install -g arkimede-cli
# oppure senza installare:
npx arkimede-cli login --url http://localhost:3000
```

Da sorgente:

```bash
cd cli
npm install
npm run build
npm link        # opzionale: rende disponibile il comando `arkimede` globalmente
```

Senza `npm link`, si lancia con `node dist/index.js <comando>`.

## Comandi

```bash
arkimede login --url http://localhost:3000   # chiede email + password
arkimede chats                               # elenca le tue chat
arkimede chat                                # TUI full-screen (default)
arkimede chat --new "Mio argomento"          # nuova chat
arkimede chat --chat <id>                    # apre una chat specifica
arkimede chat --last                         # chat più recente
arkimede chat --plain                        # REPL a righe invece della TUI
arkimede whoami                              # verifica la sessione salvata
arkimede logout
```

`arkimede` senza argomenti apre la TUI sulla chat più recente (`chat` è il
comando di default).

## La TUI

Interfaccia full-screen (Ink/React): sidebar delle chat, pannello messaggi
scrollabile, barra di input e status line.

| Tasto | Effetto |
|---|---|
| `Invio` | invia il messaggio |
| `Esc` | ferma l'assistente mentre sta rispondendo |
| `Tab` | alterna il focus tra input e sidebar delle chat |
| `↑`/`↓` | input: scroll messaggi · sidebar: sposta la selezione |
| `PgSu`/`PgGiù` | scroll messaggi |
| `n` (sidebar) | nuova chat |
| `s` (sidebar) | pannello impostazioni |
| `q` (sidebar) / `Ctrl+C` | esci |

La risposta dell'assistente arriva in streaming live; le invocazioni dei
tool compaiono come righe di stato compatte `⚙ tool` / `✓ tool`, i file
prodotti dalle skill sono elencati con l'URL di download, e le chat
multi-agente mostrano blocchi `◆` per agente con gli eventi `agent_step`.
Fermare la generazione chiude semplicemente la connessione HTTP — il backend
annulla l'esecuzione quando il client si disconnette.

## Il pannello impostazioni

Si apre con `s` dalla sidebar. Organizzato in schede — si cambiano con
`←`/`→`, `Tab` o i tasti numerici, si chiude con `Esc`. Nelle schede a
lista `↑`/`↓` seleziona una riga e `Spazio`/`Invio` esegue l'azione.

| Scheda | Contenuto | Azioni |
|---|---|---|
| 1 Profile | nome, email, ruolo, lingua, preferenze memoria/history, sessione (URL backend, scadenza token) | — |
| 2 LLM | configurazioni LLM con ruoli `default`★/`summarizer`/`vision` (solo admin) | set default · crea/modifica/elimina |
| 3 Tools | custom tool: stato enabled, tipo executor, scope | toggle · crea/modifica/elimina |
| 4 Skills | skill installate: stato enabled, versione, typed/descriptive, scope | toggle enabled |
| 5 Data | data source: engine e scope | — |
| 6 MCP | server MCP: transport, endpoint/comando, stato enabled | toggle · crea/modifica/elimina |
| 7 Usage | totali token, per modello e (admin) per utente con costi | — |

I form di creazione/modifica condividono lo stesso pattern: navigazione
campi con `↑`/`↓`/`Tab`, valori enum ciclati con `←`/`→`, submit dalla riga
`[Save]`, annulla con `Esc`. L'eliminazione chiede conferma (`y`).

Note per scheda:

- **LLM**: il campo API key è mascherato e write-only — lasciarlo vuoto in
  modifica conserva la chiave salvata. L'ultima configurazione rimasta non è
  eliminabile (regola applicata anche server-side; eliminando la default
  viene promossa la più vecchia rimasta).
- **Tools**: la TUI crea i tipi executor autocontenuti — `http` (URL +
  method) e `prompt` (prompt del sub-agente). I tool `sql`/`rag` richiedono
  i picker di data source/collection e si creano dalla web UI; la loro
  descrizione resta modificabile qui. La modifica fa merge nella config
  executor esistente, così i campi avanzati impostati dal web (header,
  timeout, parametri…) sono preservati. Il nome del tool è immutabile dopo
  la creazione.
- **MCP**: url per i transport `http`/`sse`/`remote`, command+args per
  `local` (solo admin). Header, variabili d'ambiente e secrets si gestiscono
  dalla web UI.

Tutte le azioni chiamano gli stessi endpoint della web UI, quindi scoping,
ownership e regole admin valgono invariate (un 403 è mostrato come "not
allowed"; le schede solo-admin mostrano una nota esplicativa agli utenti
normali). Le API key non tornano mai al client — il backend espone solo un
flag has-key.

## Il REPL a righe (`--plain`)

Fallback line-based, selezionato automaticamente quando stdin/stdout non
sono un terminale — il che rende il client scriptabile:

```bash
printf 'riassumi l\''ultima riunione\n/quit\n' | arkimede chat --last
```

| Comando | Effetto |
|---|---|
| `/chats` | elenca le chat e cambia |
| `/new [titolo]` | crea una nuova chat e ci si sposta |
| `/history [n]` | mostra gli ultimi *n* messaggi (default 20) |
| `/title <testo>` | rinomina la chat corrente |
| `/quit`, `/exit` | esci |

Qualsiasi altro testo viene inviato come messaggio; Ctrl+C durante una
risposta ferma la generazione, al prompt esce.

## Sessione e sicurezza

- JWT e profilo utente sono salvati in `~/.config/arkimede/config.json` con
  permessi `0600` (`ARKIMEDE_CONFIG_DIR` lo sposta). Non esiste refresh
  token: alla scadenza (`JWT_EXPIRES_IN` del backend, default 7 giorni)
  basta rifare `arkimede login`.
- Il modello/LLM si risolve lato server (config LLM default dell'admin); la
  CLI non seleziona mai un modello.
- I messaggi d'errore rispettano la locale della shell via `Accept-Language`
  (`it` → italiano).

## Note implementative

- Lo streaming usa esattamente il protocollo del frontend web: `POST
  /api/chats/:id/messages/stream` consumato come body SSE via `fetch`
  (l'endpoint è una POST, quindi `EventSource` non è applicabile). Gli
  eventi sono righe `data: {json}` con chiave `type` (`chunk`, `tool_call`,
  `tool_result`, `file`, `agent_step`, `memory_proposal`, `error`, `done`).
- Le esecuzioni lunghe dei tool possono restare silenziose tra un evento e
  l'altro; il client tiene la connessione aperta senza read timeout (il
  backend non manda heartbeat dopo l'evento iniziale `connected`).
- Con `ARKIMEDE_DEBUG=/path/al/log` la TUI appende diagnostica su file.

Le evoluzioni pianificate (download autenticato dei file, packaging a
binario singolo, altre schede impostazioni) sono tracciate internamente.
