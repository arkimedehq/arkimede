# Building a Plugin for Arkimede

A **plugin** is a ZIP package that extends Arkimede as a whole: it can bring skills, MCP servers, background daemons
and flows, answer HTTP routes, show its own pages, emit events that start flows or reach other plugins, and use a few
core services (notifications, a key-value store, the agent). Skills and tools extend what the model can call; a plugin
is the broader unit, installed, approved, configured, updated and removed as one.

This page is the public contract, **plugin-contract v1**. An example to start from is in
[`examples/plugins/notes-demo`](../examples/plugins/notes-demo).

---

## Table of Contents

1. [Principles](#1-principles)
2. [The package and plugin.yaml](#2-the-package-and-pluginyaml)
3. [Contributions](#3-contributions)
4. [Backend: routes and event handlers](#4-backend-routes-and-event-handlers)
5. [Pages](#5-pages)
6. [Events](#6-events)
7. [Core services](#7-core-services)
8. [Life cycle, scope and people](#8-life-cycle-scope-and-people)
9. [Signatures and trust](#9-signatures-and-trust)
10. [Registry](#10-registry)
11. [Limits](#11-limits)
12. [Versions of the contract](#12-versions-of-the-contract)

---

## 1. Principles

- **A plugin's code never runs inside Arkimede.** Its routes, event handlers and daemons are scripts of its skills,
  run by the skill executor in the same isolated containers as any skill (network, limits and sandbox included).
- **One way in, one way out.** A plugin reaches the core only through `/internal/plugins/*` with its token; users reach
  the plugin only through `/api/plugins/<name>/…`, where Arkimede authenticates them.
- **Default deny.** Services, subscriptions, network, daemons, routes and pages are declared in `plugin.yaml`; what
  touches the network, the backend (services, subscriptions, daemons, routes) or resources (storage) is approved by an
  admin. An update that asks for more stops until it is approved again.
- **Personal or shared.** A plugin declares its `audience`: `personal` when it uses one person's account, data or
  memory — anyone installs their own copy, never shared — or `shared` (the default) when it is generic and may serve a
  team or the organization, which only an admin decides (specs/EXTENSION_AUDIENCE.md).
- **The core knows no plugin.** Nothing in Arkimede depends on a particular plugin; events are delivered without being
  interpreted.

## 2. The package and plugin.yaml

A ZIP with `plugin.yaml` at its root:

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
contract: 1                       # plugin-contract version (required)
name: notes-demo                  # kebab-case, unique; also the namespace of its events
version: 1.0.0
label: Notes                      # shown in the UI (default: name)
audience: shared                  # personal (one person's account, data or memory: never shared) | shared (default)
description: Short notes kept by the plugin.
author: …
license: AGPL-3.0-or-later
homepage: https://…

settings:                         # shared by every part of the plugin
  - { key: API_URL, required: true, description: … }
  - { key: API_TOKEN, secret: true }
  - { key: NOTIFY_TITLE, default: New note }

contributes:
  skills: [skills/notes]          # folders with a SKILL.md (docs/SKILLS.md)
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
      - { id: notes, title: Notes, entry: ui/index.html }

events:                           # the types it emits
  - name: note.added
    schema: { type: object, required: [id], properties: { id: { type: string } } }   # JSON Schema
subscribes: [other-plugin/order.paid]   # other plugins' events it wants
handlers:
  events: { skill: notes, script: scripts/on_event.py }
people: { skill: notes, script: scripts/people.py }   # optional: the people it knows, for the People card

services: [notify, storage, agent.ask]
storage: { quotaKb: 1024 }        # at most 10240
```

Unknown fields are refused. Every path must be inside the package; every script named by `daemons`, `routes`,
`handlers` and `people` must be declared in its skill's `SKILL.md` (`mode: daemon` for daemons, a task script otherwise).

A plugin's skills go through the egress proxy unless an admin set their network otherwise: the proxy opens the hosts
of the plugin's MCP URLs (settings filled in) while the plugin is active, for its scripts and its daemons alike.

**What every script of the plugin receives** in `_config` (on stdin, as for any skill): the plugin's settings (secrets
in clear), `PLUGIN_TOKEN`, `PLUGIN_NAME`, `PLUGIN_VERSION`. The core's plugin API is at
`$BACKEND_INTERNAL_URL/internal/plugins` (an environment variable the executor gives every script).

## 3. Contributions

| Key | Becomes | Notes |
|---|---|---|
| `skills` | skills, installed by the normal skill installer | network, dependencies and sandbox as declared in each `SKILL.md` |
| `mcp` | MCP servers (`http` or `sse`) named `<plugin>-<name>` | `${KEY}` comes from the settings; a secret setting is stored as an MCP secret; a server whose settings are missing stays off |
| `daemons` | the daemon of that script | started once the skills are installed; restarted when the settings change |
| `flows` | flows, **switched off and read-only** | JSON with `name`, and optionally `description`, `trigger`, `definition` (`nodes`, `edges`), `inputSchema`, `exposeAsTool`. Users switch them on or **duplicate** them to change them; a copy is theirs and stays if the plugin goes |

The contributed primitives belong to the plugin's owner, have the plugin's scope, and cannot be changed or deleted by
hand: they go with the plugin. The Skills and MCP pages mark them with a *Plugin* badge and leave out those changes (a
skill can still be switched on and off).

## 4. Backend: routes and event handlers

### Routes

`/api/plugins/<name>/routes/<path>` (any method declared), with the user's JWT or `ak_` key. Arkimede checks that the
plugin is active and that the user sees it, finds the route (`:param` segments; a literal segment wins over a
parameter), and runs the script **as the user** with this input:

```json
{
  "route": { "method": "POST", "path": "notes/n-1/pin", "params": { "id": "n-1" }, "query": {}, "body": { } },
  "user": { "id": "…", "name": "…", "isAdmin": false },
  "_config": { "PLUGIN_TOKEN": "…", "…": "…" }
}
```

The script prints the answer on stdout: `{"status": 201, "body": …}` sets the status; any other JSON is answered with
200. A failing script is answered with 502 and no detail.

### Event handlers

`handlers.events` receives the events the plugin subscribed to: `{"event": {"plugin", "type", "id", "at", "subject",
"data"}}`. It runs as the plugin's owner.

## 5. Pages

A page is a static file of the package shown in an **isolated iframe**: `sandbox="allow-scripts allow-forms"` without
`allow-same-origin` (an opaque origin: no access to Arkimede's cookies, storage or token), served with
`Content-Security-Policy: default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'` — the page cannot call
any server. Files next to the entry (same folder) can be loaded with relative URLs.

The page talks to Arkimede through `postMessage`:

```js
let next = 1;
const waiting = new Map();
addEventListener('message', (e) => {
  const m = e.data;
  if (e.source === parent && m?.arkimede === 1 && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const ask = (msg) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); parent.postMessage({ arkimede: 1, id, ...msg }, '*'); });

await ask({ type: 'request', method: 'GET', path: 'notes', query: { limit: '10' } });
// → { arkimede: 1, id, ok: true, status: 200, body: { … } }   — a call to one of the plugin's routes, as the user
await ask({ type: 'context' });
// → { arkimede: 1, id, ok: true, body: { user: { name }, theme: 'dark' | 'light', lang: 'it' } }
```

Paths are plain segments (no `.`/`..`, no query: use `query`). Each page appears in the menu of the users who see the
plugin.

## 6. Events

`POST $BACKEND_INTERNAL_URL/internal/plugins/events`, header `x-plugin-token: <PLUGIN_TOKEN>`, up to 100 events:

```json
{ "events": [
  { "id": "8f1c…", "type": "note.added", "at": "2026-11-09T10:00:00Z", "data": { "id": "n-1" }, "subject": { "id": "n-1" } }
] }
```

- `id` (required, ≤ 128 characters) makes a resend harmless: the same id is `duplicate`.
- `type` must be declared in `events`; `data` must match its schema; `at` and `subject` are optional.
- Answer: `{"results": [{"id", "outcome": "accepted" | "duplicate" | "invalid" | "rate_limited", "error"?}]}`.

An accepted event's full type is `<plugin>/<type>`. Arkimede does not interpret it; it
- starts the enabled flows with the trigger **Plugin event** of that type (optional equality filter on `data` fields
  and cooldown), owned by users who see the plugin; the run's input is the event;
- hands it to the plugins that subscribed (approved), on their `handlers.events`, when their owner sees the emitting
  plugin;
- logs it on the plugin's page (30 days).

An event never becomes a notification, a memory or something said by itself: use the services.

## 7. Core services

`POST $BACKEND_INTERNAL_URL/internal/plugins/services/<service>`, header `x-plugin-token`, JSON body.

| Service | Body | Answer |
|---|---|---|
| `notify` | `{ "to": "owner" \| { "id": "<person id>" }, "title", "body" }` | `{ ok }` — an Arkimede notification to the owner or to the user that person is linked to |
| `storage.get` | `{ "key" }` | `{ value }` (null when missing) |
| `storage.set` | `{ "key", "value": <any JSON> }` | `{ ok, used, quota }` |
| `storage.delete` | `{ "key" }` | `{ ok }` |
| `storage.list` | `{ "prefix"?, "limit"? }` | `{ keys }` |
| `agent.ask` | `{ "from": { "id", "name"? }, "conversation", "text" }` | `{ reply, chatId }` |
| `perceive` | `{ "text", "sensor": "camera" \| "microphone" \| "sensor" \| "photo", "place"?, "at"?, "people"?: [{ "id", "confidence"? }], "keepDays"?, "private"? }` | `{ ok, duplicate, expiresAt }` |
| `presence.report` | `{ "place"?, "people"?: [{ "id", "confidence"? }], "someone"?, "left"?, "busy"?, "ttlSeconds"? }` | `{ ok }` |
| `say` | `{ "text", "place" }` or `{ "text", "to": { "id" } }` | `{ ok, point }` |
| `services` | — | `{ services: [{ name, available }] }` |
| `memory.search` | — | reserved: `unavailable` (no plugin reads anyone's memory in v1) |

Errors are HTTP statuses with `{ "error", "message" }`: `denied` (403, not approved), `unavailable` (503), `invalid`
(400), `unknown_recipient` (400), `quota` (507), `too_large` (413), `rate_limited` (429).

**agent.ask** is for plugins that carry a conversation from outside (a messaging channel, a door intercom):
- the agent is the one chosen for the plugin (by the admin for a shared plugin, by the owner among their agents for a
  personal one; default: the main agent) — never the plugin's choice;
- a `from.id` linked to a user (see People) runs **as that user**; anyone else is a **guest** of the plugin's owner:
  words only, no tools, unless the admin marked that id *authorized*;
- one chat per plugin and `conversation`, kept like other external chats; after 7 days of silence a new one starts;
  one turn at a time per conversation;
- the reply is text.

Everything a plugin sends is data, never instructions: it never reaches a system prompt.

### Memory and voice

`perceive`, `presence.report` and `say` reach the agent's memory (Recordare, when the instance has it) and its voice
points (the satellites, today through Home Assistant). The plugin never talks to the memory itself: it says what it
noticed, Arkimede decides where it goes.

- **Whose memory**: always its owner's. Only a `personal` plugin writes to a memory (a memory is always someone's):
  a `shared` one gets `denied` from `perceive` and `presence.report`. `say` speaks only on the voice points assigned
  to the owner (the default account of the satellites and Home Assistant's memory also on the unassigned ones).
- **People**: `people[].id` are the plugin's own ids (a face, a badge). An id linked in *People* to a Home Assistant
  person — the linked user's, else the one an admin linked to the id — is sent as that person (the same contact as
  Home Assistant's presence), and `say` with `to: { id }` reaches their room; any other id as
  `{ channel: <plugin name>, externalId: id }`, which the memory's admin binds to a person once in Recordare's console.
  Never send a name you are not sure of: an unknown person is `someone` (presence) or "someone" in the text
  (perception), and `confidence` is your model's score.
- **`perceive`**: something the plugin's senses noticed, in words (≤ 2,000 characters, as the agent would tell it —
  never an image, a sound or a face). It is remembered as seen, once (the same text, sensor and place within ten
  minutes is a `duplicate`), and fades after `keepDays` (default: the memory's setting, usually 14; up to 3650 for a
  serious event). Send events, not a stream. Telling someone at once is `notify` or `say`, not the memory.
- **`presence.report`**: who is at a place now, recognised by the plugin (`someone` = how many it cannot name). With a
  `place` it is a room presence (`camera`), without one "at home". Renew it while they stay (`ttlSeconds`, 30–3600,
  default 600); `left: true` when they go; `busy` when the plugin knows. What the memory answers (something it meant
  to tell that person) is said in that room when it has a voice point.
- **`say`**: a sentence (≤ 300 characters) on the voice point of a `place`, or of the room where a linked person is;
  at most one a minute per place.
- **Places** are the names of the home's rooms (a Home Assistant area's name, id or alias). A place with no voice point
  is still remembered; `say` there answers `unavailable`.
- `services` tells what is available now: `perceive` and `presence.report` need the memory, `say` a voice channel.

## 8. Life cycle, scope and people

1. **Install** (anyone, their own copy — or an admin for a user): pick it from the registry or upload a ZIP signed by a
   trusted key; an unsigned ZIP only an admin installs (with *Allow unsigned plugins* on). Each user has their own copy
   with its own settings, secrets, daemons, data, people and events.
2. **Review and approve**: a plugin that asks for nothing that touches the network, the backend or resources starts at
   once; otherwise it waits (creating nothing) until the admin sees what it contributes and what it asks (services,
   subscriptions, network from its skills and MCP URLs, daemons, routes, pages, storage) and approves it — choosing,
   for a `shared` plugin, the **scope** and, for `agent.ask`, the **agent**.
3. **Configure**: settings (secrets encrypted at rest). A change updates its MCP servers and restarts its daemons.
   While the plugin is active, the hosts of its MCP URLs (settings filled in, a LAN address too) are open in the egress
   proxy, so its daemons reach them; nothing else is.
4. **Update**: each owner updates their own copy (a newer ZIP with the same name). If it asks nothing new it replaces
   the old version at once
   (flows keep whether they were on, its skills keep the network the admin gave them); otherwise the plugin stops
   until approved again. Settings and people always stay. The plugin's page has **Update or reinstall**: a ZIP of the
   same plugin (the same version reinstalls it) applied to that copy, whoever its owner — the way an admin updates a
   copy installed on a user's behalf (`POST /api/plugin-installs/:id/upload`).
5. **Disable / enable**: daemons stop, skills and MCP servers switch off, the token is revoked; data and settings stay.
6. **Uninstall**: contributions, files, settings, data, events and people links are removed. Duplicated flows stay.

**Scope**, as for skills and tools: `personal` (the owner), `team` (its members) or `org` (everyone) — `team` and `org`
only for a `shared` plugin, set by an admin. It decides who
sees its skills, MCP servers, flows, routes and pages, whose flows its events can start, and who can be linked as a
person or receive `notify`.

**People**: a plugin speaks of people with ids of its own. In *Settings → Plugins → People* the owner (or an admin)
links an id to a user who sees the plugin, or marks an unlinked id *authorized* for `agent.ask`; an admin may also link
it to a Home Assistant person (someone without an account: a child, a grandparent). Arkimede never asks a plugin who is
who.

**Listing its people** (optional, manifest `people`): a task script of the plugin that prints
`{"people": [{"id", "name"?, "lastSeen"?}]}` — `id` as used in the services, `name` to show, `lastSeen` (ISO) for the
order. Arkimede runs it as the plugin's owner when the People card opens (a 20-second limit, kept a minute), so the
owner picks an id instead of typing it; when it is missing or fails, ids are typed by hand. It lists people, it does not
say who is who.

**The plugin token** is revoked when the plugin is disabled, updated or removed; scripts always get the current one in
`_config`. It is valid only on `/internal/plugins/*` and gives no access to any user's files, collections or data.

## 9. Signatures and trust

A signature is ed25519 over the SHA-256 digest (32 raw bytes) of the ZIP, base64-encoded:

```bash
openssl genpkey -algorithm ed25519 -out plugin-key.pem                              # once
openssl pkey -in plugin-key.pem -pubout -outform DER | tail -c 32 | base64           # the public key to trust
openssl dgst -sha256 -binary notes-demo.zip > digest.bin
openssl pkeyutl -sign -inkey plugin-key.pem -rawin -in digest.bin | base64           # the signature
```

Trusted keys: `official` ones from the environment (`PLUGIN_TRUSTED_KEYS='[{"id":"…","publicKey":"…"}]'`), `verified`
and `community` ones added by the admin in *Settings → Plugins*. A plugin's level is the level of the key that
verifies its signature; with no valid signature it is `unsigned`, and installs only if *Allow unsigned plugins* is on
(off by default). A signature tells who published the package, not that it is harmless: isolation stays that of the
containers.

## 10. Registry

`PLUGIN_REGISTRY_URL` (default: `https://raw.githubusercontent.com/arkimedehq/arkimede-plugins/main/registry.json`):

```json
{ "version": 1, "plugins": [
  { "name": "notes-demo", "version": "1.0.0", "label": "Notes", "description": "…", "author": "…",
    "url": "https://…/notes-demo-1.0.0.zip", "sha256": "<hex>", "signature": "<base64>", "keyId": "…" }
] }
```

`url` must be HTTPS and `sha256` is mandatory: a package that does not match is refused.

## 11. Limits

| | |
|---|---|
| Package | 50 MB (200 MB unpacked) |
| Route | body 1 MB, 30 s, 120 requests per minute per user and plugin |
| Events | 100 per call, 600 per minute per plugin |
| Services | 600 calls per minute per plugin |
| Storage | the approved quota (≤ 10 MB); a value ≤ 1 MB; a key ≤ 256 characters |
| agent.ask | text ≤ 8,000 characters |

## 12. Versions of the contract

`contract: 1` in `plugin.yaml`; `GET /api/plugins/contract` lists the versions an Arkimede runs. Additions (a
contribution point, a service, an optional field) keep `contract: 1`; an incompatible change will be `contract: 2`, with
a period in which both are supported.

Planned, when at least two plugins need them: `tools` (custom HTTP tools), `llm`, `stt`/`tts`, `vector-db`, `channel`,
`flow-node`, `hooks`, binary daemons, and components inside Arkimede's own page (only for officially signed plugins).
