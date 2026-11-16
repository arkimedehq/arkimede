# Creare un Plugin per Arkimede

Un **plugin** è un pacchetto ZIP che estende Arkimede nel suo insieme: può portare skill, server MCP, daemon in
background e flow, rispondere a rotte HTTP, mostrare pagine proprie, emettere eventi che avviano flow o raggiungono
altri plugin, e usare alcuni servizi del nucleo (notifiche, uno spazio chiave-valore, l'agente). Skill e tool estendono
ciò che il modello può chiamare; il plugin è l'unità più ampia, che si installa, approva, configura, aggiorna e toglie
tutta insieme.

Questa pagina è il contratto pubblico, **plugin-contract v1**. Un esempio da cui partire è in
[`examples/plugins/notes-demo`](../examples/plugins/notes-demo).

---

## Indice

1. [Principi](#1-principi)
2. [Il pacchetto e plugin.yaml](#2-il-pacchetto-e-pluginyaml)
3. [Contribuzioni](#3-contribuzioni)
4. [Backend: rotte e gestori di eventi](#4-backend-rotte-e-gestori-di-eventi)
5. [Pagine](#5-pagine)
6. [Eventi](#6-eventi)
7. [Servizi del nucleo](#7-servizi-del-nucleo)
8. [Ciclo di vita, ambito e persone](#8-ciclo-di-vita-ambito-e-persone)
9. [Firme e fiducia](#9-firme-e-fiducia)
10. [Registro](#10-registro)
11. [Limiti](#11-limiti)
12. [Versioni del contratto](#12-versioni-del-contratto)

---

## 1. Principi

- **Il codice di un plugin non gira mai dentro Arkimede.** Rotte, gestori di eventi e daemon sono script delle sue
  skill, eseguiti dall'executor delle skill negli stessi container isolati di qualsiasi skill (rete, limiti e sandbox
  compresi).
- **Una sola via d'ingresso e una d'uscita.** Il plugin raggiunge il nucleo solo da `/internal/plugins/*` con il suo
  token; gli utenti raggiungono il plugin solo da `/api/plugins/<nome>/…`, dove Arkimede li autentica.
- **Default deny.** Servizi, iscrizioni, rete, daemon, rotte e pagine si dichiarano in `plugin.yaml`; ciò che tocca
  la rete, il backend (servizi, iscrizioni, daemon, rotte) o le risorse (spazio dati) lo approva un admin. Un
  aggiornamento che chiede di più si ferma finché non è riapprovato.
- **Personale o condiviso.** Un plugin dichiara la sua `audience`: `personal` quando usa l'account, i dati o la memoria
  di una persona — chiunque installa la sua copia, mai condivisa — oppure `shared` (il default) quando è generico e può
  servire un team o l'organizzazione, cosa che decide solo un admin (specs/EXTENSION_AUDIENCE.md).
- **Il nucleo non conosce nessun plugin.** Niente in Arkimede dipende da un plugin in particolare; gli eventi si
  consegnano senza interpretarli.

## 2. Il pacchetto e plugin.yaml

Uno ZIP con `plugin.yaml` alla radice:

```
notes-demo.zip
  plugin.yaml
  skills/notes/SKILL.md
  skills/notes/scripts/list.py
  skills/notes/scripts/add.py
  flows/note-added.json
  ui/index.html
  ui/app.js
```

```yaml
contract: 1                       # versione di plugin-contract (obbligatoria)
name: notes-demo                  # kebab-case, unico; è anche lo spazio dei nomi dei suoi eventi
version: 1.0.0
label: Note                       # mostrato nell'interfaccia (default: name)
audience: shared                  # personal (account, dati o memoria di una persona: mai condiviso) | shared (default)
description: Brevi note tenute dal plugin.
author: …
license: AGPL-3.0-or-later
homepage: https://…

settings:                         # condivise da tutte le parti del plugin
  - { key: API_URL, required: true, description: … }
  - { key: API_TOKEN, secret: true }
  - { key: NOTIFY_TITLE, default: Nuova nota }

contributes:
  skills: [skills/notes]          # cartelle con un SKILL.md (docs/SKILLS_it.md)
  mcp:
    - { name: notes, transport: http, url: "${API_URL}/mcp", headers: { Authorization: "Bearer ${API_TOKEN}" } }
  daemons:
    - { skill: notes, script: scripts/watch.py }
  flows: [flows/note-added.json]
  routes:
    - { method: GET, path: notes, skill: notes, script: scripts/list.py }
    - { method: POST, path: "notes/:id/pin", skill: notes, script: scripts/pin.py }
  ui:
    pages:
      - { id: notes, title: Note, entry: ui/index.html }

events:                           # i tipi che emette
  - name: note.added
    schema: { type: object, required: [id], properties: { id: { type: string } } }   # JSON Schema
subscribes: [altro-plugin/order.paid]   # eventi di altri plugin che vuole ricevere
handlers:
  events: { skill: notes, script: scripts/on_event.py }
people: { skill: notes, script: scripts/people.py }   # facoltativo: le persone che conosce, per la scheda Persone

services: [notify, storage, agent.ask]
storage: { quotaKb: 1024 }        # al massimo 10240
```

I campi sconosciuti sono rifiutati. Ogni percorso deve stare nel pacchetto; ogni script nominato da `daemons`, `routes`,
`handlers` e `people` deve essere dichiarato nel `SKILL.md` della sua skill (`mode: daemon` per i daemon, uno script task
altrimenti).

Le skill di un plugin passano dal proxy di uscita, salvo che un admin ne imposti la rete in altro modo: finché il plugin
è attivo il proxy apre gli host dei suoi URL MCP (con le impostazioni), sia per i suoi script sia per i suoi daemon.

**Cosa riceve ogni script del plugin** in `_config` (su stdin, come ogni skill): le impostazioni del plugin (i segreti
in chiaro), `PLUGIN_TOKEN`, `PLUGIN_NAME`, `PLUGIN_VERSION`. L'API del nucleo per i plugin è in
`$BACKEND_INTERNAL_URL/internal/plugins` (una variabile d'ambiente che l'executor dà a ogni script).

## 3. Contribuzioni

| Chiave | Diventa | Note |
|---|---|---|
| `skills` | skill, installate dall'installer normale delle skill | rete, dipendenze e sandbox come dichiarate in ogni `SKILL.md` |
| `mcp` | server MCP (`http` o `sse`) chiamati `<plugin>-<nome>` | `${KEY}` viene dalle impostazioni; un'impostazione segreta è salvata come segreto MCP; un server a cui mancano impostazioni resta spento |
| `daemons` | il daemon di quello script | avviati quando le skill sono installate; riavviati quando cambiano le impostazioni |
| `flows` | flow **spenti e in sola lettura** | JSON con `name` e, facoltativi, `description`, `trigger`, `definition` (`nodes`, `edges`), `inputSchema`, `exposeAsTool`. Gli utenti li accendono o li **duplicano** per modificarli; la copia è loro e resta se il plugin se ne va |

Le primitive contribuite appartengono al proprietario del plugin, hanno l'ambito del plugin e non si modificano né si
cancellano a mano: se ne vanno con il plugin. Le pagine Skill e MCP le segnano con un badge *Plugin* e non offrono
quelle modifiche (una skill si può comunque accendere e spegnere).

## 4. Backend: rotte e gestori di eventi

### Rotte

`/api/plugins/<nome>/routes/<path>` (con i metodi dichiarati), con il JWT dell'utente o una chiave `ak_`. Arkimede
verifica che il plugin sia attivo e che l'utente lo veda, trova la rotta (segmenti `:param`; un segmento letterale vince
su un parametro) ed esegue lo script **come l'utente**, con questo input:

```json
{
  "route": { "method": "POST", "path": "notes/n-1/pin", "params": { "id": "n-1" }, "query": {}, "body": { } },
  "user": { "id": "…", "name": "…", "isAdmin": false },
  "_config": { "PLUGIN_TOKEN": "…", "…": "…" }
}
```

Lo script stampa la risposta su stdout: `{"status": 201, "body": …}` fissa lo stato; qualsiasi altro JSON è la
risposta con 200. Uno script che fallisce dà 502, senza dettagli.

### Gestori di eventi

`handlers.events` riceve gli eventi a cui il plugin si è iscritto: `{"event": {"plugin", "type", "id", "at",
"subject", "data"}}`. Gira come il proprietario del plugin.

## 5. Pagine

Una pagina è un file statico del pacchetto mostrato in un **iframe isolato**: `sandbox="allow-scripts allow-forms"`
senza `allow-same-origin` (un'origine opaca: nessun accesso a cookie, storage o token di Arkimede), servito con
`Content-Security-Policy: default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'` — la pagina non può
chiamare nessun server. I file accanto alla pagina (stessa cartella) si caricano con URL relativi.

La pagina parla con Arkimede via `postMessage`:

```js
let next = 1;
const waiting = new Map();
addEventListener('message', (e) => {
  const m = e.data;
  if (e.source === parent && m?.arkimede === 1 && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const ask = (msg) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); parent.postMessage({ arkimede: 1, id, ...msg }, '*'); });

await ask({ type: 'request', method: 'GET', path: 'notes', query: { limit: '10' } });
// → { arkimede: 1, id, ok: true, status: 200, body: { … } }   — una chiamata a una rotta del plugin, come l'utente
await ask({ type: 'context' });
// → { arkimede: 1, id, ok: true, body: { user: { name }, theme: 'dark' | 'light', lang: 'it' } }
```

I percorsi sono segmenti semplici (niente `.`/`..`, niente query: si usa `query`). Ogni pagina compare nel menu degli
utenti che vedono il plugin.

## 6. Eventi

`POST $BACKEND_INTERNAL_URL/internal/plugins/events`, intestazione `x-plugin-token: <PLUGIN_TOKEN>`, fino a 100
eventi:

```json
{ "events": [
  { "id": "8f1c…", "type": "note.added", "at": "2026-11-09T10:00:00Z", "data": { "id": "n-1" }, "subject": { "id": "n-1" } }
] }
```

- `id` (obbligatorio, ≤ 128 caratteri) rende innocuo un nuovo invio: lo stesso id è `duplicate`.
- `type` dev'essere dichiarato in `events`; `data` deve rispettare il suo schema; `at` e `subject` sono facoltativi.
- Risposta: `{"results": [{"id", "outcome": "accepted" | "duplicate" | "invalid" | "rate_limited", "error"?}]}`.

Il tipo completo di un evento accettato è `<plugin>/<tipo>`. Arkimede non lo interpreta:
- avvia i flow accesi con il trigger **Evento di un plugin** di quel tipo (filtro facoltativo di uguaglianza su campi di
  `data`, e cooldown), dei proprietari che vedono il plugin; l'input dell'esecuzione è l'evento;
- lo consegna ai plugin iscritti (con approvazione), sul loro `handlers.events`, se il loro proprietario vede il
  plugin che lo emette;
- lo registra nella pagina del plugin (30 giorni).

Un evento non diventa mai da solo una notifica, un ricordo o una frase detta: per questo ci sono i servizi.

## 7. Servizi del nucleo

`POST $BACKEND_INTERNAL_URL/internal/plugins/services/<servizio>`, intestazione `x-plugin-token`, corpo JSON.

| Servizio | Corpo | Risposta |
|---|---|---|
| `notify` | `{ "to": "owner" \| { "id": "<id della persona>" }, "title", "body" }` | `{ ok }` — una notifica in Arkimede al proprietario o all'utente collegato a quella persona |
| `storage.get` | `{ "key" }` | `{ value }` (null se manca) |
| `storage.set` | `{ "key", "value": <qualsiasi JSON> }` | `{ ok, used, quota }` |
| `storage.delete` | `{ "key" }` | `{ ok }` |
| `storage.list` | `{ "prefix"?, "limit"? }` | `{ keys }` |
| `agent.ask` | `{ "from": { "id", "name"? }, "conversation", "text" }` | `{ reply, chatId }` |
| `perceive` | `{ "text", "sensor": "camera" \| "microphone" \| "sensor" \| "photo", "place"?, "at"?, "people"?: [{ "id", "confidence"? }], "keepDays"?, "private"? }` | `{ ok, duplicate, expiresAt }` |
| `presence.report` | `{ "place"?, "people"?: [{ "id", "confidence"? }], "someone"?, "left"?, "busy"?, "ttlSeconds"? }` | `{ ok }` |
| `say` | `{ "text", "place" }` oppure `{ "text", "to": { "id" } }` | `{ ok, point }` |
| `services` | — | `{ services: [{ name, available }] }` |
| `memory.search` | — | riservato: `unavailable` (in v1 nessun plugin legge la memoria di qualcuno) |

Gli errori sono stati HTTP con `{ "error", "message" }`: `denied` (403, non approvato), `unavailable` (503), `invalid`
(400), `unknown_recipient` (400), `quota` (507), `too_large` (413), `rate_limited` (429).

**agent.ask** serve ai plugin che portano una conversazione da fuori (un canale di messaggistica, un citofono):
- l'agente è quello scelto per il plugin (dall'admin per un plugin condiviso, dal proprietario tra i suoi agenti per
  uno personale; default: l'agente principale), mai una scelta del plugin;
- un `from.id` collegato a un utente (vedi Persone) gira **come quell'utente**; chiunque altro è un **ospite** del
  proprietario del plugin: solo parole, niente tool, salvo che l'admin abbia segnato quell'id *autorizzato*;
- una chat per plugin e `conversation`, conservata come le altre chat esterne; dopo 7 giorni di silenzio ne comincia
  una nuova; un turno alla volta per conversazione;
- la risposta è testo.

Tutto ciò che un plugin manda è dato, mai istruzioni: non arriva mai in un prompt di sistema.

### Memoria e voce

`perceive`, `presence.report` e `say` raggiungono la memoria dell'agente (Recordare, se l'istanza ce l'ha) e i suoi
punti voce (i satelliti, oggi attraverso Home Assistant). Il plugin non parla mai con la memoria: dice cosa ha notato,
Arkimede decide dove va.

- **Quale memoria**: sempre quella del proprietario. Scrive in una memoria solo un plugin `personal` (una memoria è
  sempre di qualcuno): uno `shared` riceve `denied` da `perceive` e `presence.report`. `say` parla solo sui punti voce
  assegnati al proprietario (l'account predefinito dei satelliti e la memoria di Home Assistant anche sui non
  assegnati).
- **Persone**: `people[].id` sono identificativi del plugin (un volto, un badge). Un id collegato in *Persone* a una
  persona di Home Assistant — quella dell'utente collegato, altrimenti quella che un admin ha collegato all'id — si manda
  come quella persona (lo stesso contatto della presenza di Home Assistant), e `say` con `to: { id }` raggiunge la sua stanza;
  ogni altro id come `{ channel: <nome del plugin>, externalId: id }`, che l'admin della memoria lega a una persona una
  volta nella console di Recordare. Non mandare mai un nome di cui non sei sicuro: uno sconosciuto è `someone`
  (presenza) o "qualcuno" nel testo (percezione), e `confidence` è il punteggio del tuo modello.
- **`perceive`**: qualcosa che i sensi del plugin hanno notato, a parole (≤ 2.000 caratteri, come lo racconterebbe
  l'agente — mai un'immagine, un suono o un volto). Si ricorda come visto, una volta (lo stesso testo, sensore e luogo
  entro dieci minuti è `duplicate`), e svanisce dopo `keepDays` (default: l'impostazione della memoria, di solito 14;
  fino a 3650 per un evento grave). Manda eventi, non uno stream. Avvisare subito è `notify` o `say`, non la memoria.
- **`presence.report`**: chi c'è adesso in un luogo, riconosciuto dal plugin (`someone` = quanti non sa nominare). Con
  `place` è una presenza in una stanza (`camera`), senza è "in casa". Rinnovala finché restano (`ttlSeconds`, 30–3600,
  default 600); `left: true` quando se ne vanno; `busy` quando il plugin lo sa. Ciò che la memoria risponde (qualcosa
  che voleva dire a quella persona) viene detto in quella stanza se ha un punto voce.
- **`say`**: una frase (≤ 300 caratteri) sul punto voce di un `place`, o della stanza dove si trova una persona
  collegata; al massimo una al minuto per luogo.
- **Luoghi** sono i nomi delle stanze di casa (nome, id o alias di un'area di Home Assistant). Un luogo senza punto
  voce si ricorda comunque; `say` lì risponde `unavailable`.
- `services` dice cosa è disponibile adesso: `perceive` e `presence.report` richiedono la memoria, `say` un canale
  voce.

## 8. Ciclo di vita, ambito e persone

1. **Installa** (chiunque, la sua copia — o un admin per conto di un utente): sceglilo dal registro o carica uno ZIP
   firmato da una chiave fidata; uno ZIP non firmato lo installa solo un admin (con *Consenti plugin non firmati*).
   Ogni utente ha la sua copia, con impostazioni, segreti, daemon, dati, persone ed eventi suoi.
2. **Rivedi e approva**: un plugin che non chiede niente che tocchi rete, backend o risorse si attiva subito;
   altrimenti resta in attesa (senza creare niente) finché l'admin vede cosa porta e cosa chiede (servizi, iscrizioni,
   rete dalle sue skill e dagli URL MCP, daemon, rotte, pagine, spazio dati) e lo approva — scegliendo, per un plugin
   `shared`, l'**ambito** e, per `agent.ask`, l'**agente**.
3. **Configura**: le impostazioni (segreti cifrati). Un cambio aggiorna i server MCP e riavvia i daemon.
   Finché il plugin è attivo, gli host dei suoi URL MCP (con le impostazioni, anche un indirizzo della LAN) sono aperti
   nel proxy di uscita, così i suoi daemon li raggiungono; nient'altro.
4. **Aggiorna**: ogni proprietario aggiorna la sua copia (uno ZIP più nuovo con lo stesso nome). Se non chiede niente di nuovo sostituisce subito la
   versione precedente (i flow restano accesi o spenti come erano, le sue skill tengono la rete data dall'admin);
   altrimenti il plugin si ferma finché non è riapprovato. Impostazioni e persone restano sempre. La pagina del plugin
   ha **Aggiorna o reinstalla**: uno ZIP dello stesso plugin (la stessa versione lo reinstalla) applicato a quella
   copia, di chiunque sia — così un admin aggiorna una copia installata per conto di un utente
   (`POST /api/plugin-installs/:id/upload`).
5. **Disattiva / riattiva**: i daemon si fermano, skill e server MCP si spengono, il token è revocato; dati e
   impostazioni restano.
6. **Disinstalla**: si tolgono contribuzioni, file, impostazioni, dati, eventi e collegamenti delle persone. I flow
   duplicati restano.

**Ambito**, come per skill e tool: `personal` (il proprietario), `team` (i suoi membri) o `org` (tutti) — `team` e `org`
solo per un plugin `shared`, decisi da un admin. Decide chi vede
skill, server MCP, flow, rotte e pagine del plugin, di chi sono i flow che i suoi eventi possono avviare, e chi può
essere collegato come persona o ricevere `notify`.

**Persone**: un plugin parla delle persone con identificativi suoi. In *Impostazioni → Plugin → Persone* il proprietario
(o un admin) collega un identificativo a un utente che vede il plugin, oppure segna *autorizzato* un identificativo non collegato,
per `agent.ask`; un admin può anche collegarlo a una persona di Home Assistant (chi non ha un account: un bambino, un
nonno). Arkimede non chiede mai a un plugin chi è chi.

**Elencare le sue persone** (facoltativo, campo `people` del manifest): uno script task del plugin che stampa
`{"people": [{"id", "name"?, "lastSeen"?}]}` — `id` come lo usano i servizi, `name` da mostrare, `lastSeen` (ISO) per
l'ordine. Arkimede lo esegue come proprietario del plugin quando si apre la scheda Persone (al massimo 20 secondi, tenuto
un minuto), così il proprietario sceglie un id invece di scriverlo; se manca o fallisce, gli id si scrivono a mano. Elenca
le persone, non dice chi è chi.

**Il token del plugin** è revocato quando il plugin viene disattivato, aggiornato o tolto; gli script ricevono sempre
quello valido in `_config`. Vale solo su `/internal/plugins/*` e non dà accesso a file, collezioni o dati di nessun
utente.

## 9. Firme e fiducia

Una firma è ed25519 sul digest SHA-256 (32 byte grezzi) dello ZIP, in base64:

```bash
openssl genpkey -algorithm ed25519 -out plugin-key.pem                              # una volta
openssl pkey -in plugin-key.pem -pubout -outform DER | tail -c 32 | base64           # la chiave pubblica da fidare
openssl dgst -sha256 -binary notes-demo.zip > digest.bin
openssl pkeyutl -sign -inkey plugin-key.pem -rawin -in digest.bin | base64           # la firma
```

Chiavi fidate: quelle `official` dall'ambiente (`PLUGIN_TRUSTED_KEYS='[{"id":"…","publicKey":"…"}]'`), quelle
`verified` e `community` aggiunte dall'admin in *Impostazioni → Plugin*. Il livello di un plugin è quello della chiave
che ne verifica la firma; senza firma valida è `unsigned`, e si installa solo con *Consenti plugin non firmati* acceso
(spento di default). Una firma dice chi ha pubblicato il pacchetto, non che è innocuo: l'isolamento resta quello dei
container.

## 10. Registro

`PLUGIN_REGISTRY_URL` (default: `https://raw.githubusercontent.com/arkimedehq/arkimede-plugins/main/registry.json`):

```json
{ "version": 1, "plugins": [
  { "name": "notes-demo", "version": "1.0.0", "label": "Note", "description": "…", "author": "…",
    "url": "https://…/notes-demo-1.0.0.zip", "sha256": "<hex>", "signature": "<base64>", "keyId": "…" }
] }
```

`url` dev'essere HTTPS e `sha256` è obbligatorio: un pacchetto che non corrisponde è rifiutato.

## 11. Limiti

| | |
|---|---|
| Pacchetto | 50 MB (200 MB scompattato) |
| Rotta | corpo 1 MB, 30 s, 120 richieste al minuto per utente e plugin |
| Eventi | 100 per chiamata, 600 al minuto per plugin |
| Servizi | 600 chiamate al minuto per plugin |
| Spazio dati | la quota approvata (≤ 10 MB); un valore ≤ 1 MB; una chiave ≤ 256 caratteri |
| agent.ask | testo ≤ 8.000 caratteri |

## 12. Versioni del contratto

`contract: 1` in `plugin.yaml`; `GET /api/plugins/contract` elenca le versioni che un Arkimede supporta. Le aggiunte (un
punto di contribuzione, un servizio, un campo facoltativo) restano `contract: 1`; una modifica incompatibile sarà
`contract: 2`, con un periodo in cui le due versioni convivono.

Previsti, quando servono ad almeno due plugin: `tools` (custom tool HTTP), `llm`, `stt`/`tts`, `vector-db`, `channel`,
`flow-node`, `hooks`, daemon binari, e componenti dentro la pagina di Arkimede (solo per plugin con firma ufficiale).
