# Arkimede CLI — Terminal Client

`arkimede` is the official terminal client: log in and chat with your agents
straight from the shell, against any running Arkimede backend. It replicates
the login and chat experience of the web frontend — same REST + SSE API, same
JWT auth, zero server-side changes — plus a settings panel for day-to-day
administration. Linux and macOS, Node ≥ 18.17.

It ships in the `cli/` workspace of the monorepo.

## Install

From npm (recommended — works with any install method, including the
pull-based [arkimede-deploy](https://github.com/arkimedehq/arkimede-deploy)):

```bash
npm install -g arkimede-cli
# or run without installing:
npx arkimede-cli login --url http://localhost:3000
```

From source:

```bash
cd cli
npm install
npm run build
npm link        # optional: makes the `arkimede` command available globally
```

Without `npm link`, run it as `node dist/index.js <command>`.

## Commands

```bash
arkimede login --url http://localhost:3000   # prompts for email + password
arkimede chats                               # list your chats
arkimede chat                                # full-screen TUI (default)
arkimede chat --new "My topic"               # start a fresh chat
arkimede chat --chat <id>                    # open a specific chat
arkimede chat --last                         # most recent chat
arkimede chat --plain                        # line-based REPL instead of the TUI
arkimede whoami                              # check the stored session
arkimede logout
```

`arkimede` with no arguments opens the TUI on your most recent chat (`chat`
is the default command).

## The TUI

Full-screen terminal UI (Ink/React): a chat sidebar, a scrollable message
pane, an input bar and a status line.

| Key | Effect |
|---|---|
| `Enter` | send the message |
| `Esc` | stop the assistant while it is responding |
| `Tab` | toggle focus between input and the chat sidebar |
| `↑`/`↓` | input: scroll messages · sidebar: move selection |
| `PgUp`/`PgDn` | scroll messages |
| `n` (sidebar) | new chat |
| `s` (sidebar) | settings panel |
| `q` (sidebar) / `Ctrl+C` | quit |

The assistant reply streams live; tool invocations show up as compact
`⚙ tool` / `✓ tool` status lines, files produced by skills are listed with
their download URL, and multi-agent chats render per-agent `◆` blocks with
`agent_step` events. Stopping generation simply aborts the HTTP connection —
the backend cancels the run when the client disconnects.

## The settings panel

Open with `s` from the sidebar. Organized in tabs — switch with `←`/`→`,
`Tab` or the digit keys, close with `Esc`. In list tabs `↑`/`↓` selects a
row and `Space`/`Enter` triggers the row action.

| Tab | Content | Actions |
|---|---|---|
| 1 Profile | name, email, role, language, memory/history prefs, session (backend URL, token expiry) | — |
| 2 LLM | LLM configurations with `default`★/`summarizer`/`vision` roles (admin-only) | set default · add/edit/delete |
| 3 Tools | custom tools: enabled state, executor type, scope | toggle · add/edit/delete |
| 4 Skills | installed skills: enabled state, version, typed/descriptive, scope | toggle enabled |
| 5 Data | data sources: engine and scope | — |
| 6 MCP | MCP servers: transport, endpoint/command, enabled state | toggle · add/edit/delete |
| 7 Usage | token totals, by model and (admin) by user with costs | — |

Create/edit forms share one pattern: navigate fields with `↑`/`↓`/`Tab`,
cycle enum values with `←`/`→`, submit from the `[Save]` row, cancel with
`Esc`. Deleting asks for confirmation (`y`).

Per-tab notes:

- **LLM**: the API key field is masked and write-only — leave it empty when
  editing to keep the stored key. The last remaining configuration cannot be
  deleted (also enforced server-side; deleting the default promotes the
  oldest remaining config).
- **Tools**: the TUI creates the self-contained executor types — `http`
  (URL + method) and `prompt` (sub-agent prompts). `sql`/`rag` tools need
  data-source/collection pickers and are created from the web UI; their
  description stays editable here. Editing merges into the existing executor
  config, so advanced fields set on the web (headers, timeouts, parameters…)
  are preserved. Tool names are immutable after creation.
- **MCP**: url for `http`/`sse`/`remote` transports, command+args for
  `local` (admin-only). Headers, env vars and secrets are managed from the
  web UI.

All actions call the same backend endpoints as the web UI, so scoping,
ownership and admin rules apply unchanged (a 403 is rendered as "not
allowed"; admin-only tabs show an explanatory note to regular users). API
keys never travel back to the client — the backend only exposes a has-key
flag.

## The plain REPL (`--plain`)

A line-based fallback, selected automatically when stdin/stdout are not a
terminal — which makes the client scriptable:

```bash
printf 'summarize the last meeting\n/quit\n' | arkimede chat --last
```

| Command | Effect |
|---|---|
| `/chats` | list chats and switch |
| `/new [title]` | create a new chat and switch to it |
| `/history [n]` | show the last *n* messages (default 20) |
| `/title <text>` | rename the current chat |
| `/quit`, `/exit` | leave |

Anything else is sent as a message; Ctrl+C during a response stops the
generation, at the prompt it exits.

## Session & security

- The JWT and user profile are stored in `~/.config/arkimede/config.json`
  with mode `0600` (`ARKIMEDE_CONFIG_DIR` relocates it). No refresh token
  exists: when the token expires (backend `JWT_EXPIRES_IN`, default 7 days)
  just `arkimede login` again.
- The model/LLM is resolved server-side (the admin's default LLM config);
  the CLI never selects a model.
- Error messages honor the shell locale via `Accept-Language` (`it` → Italian).

## Implementation notes

- Streaming uses the exact protocol of the web frontend: `POST
  /api/chats/:id/messages/stream` consumed as an SSE body over `fetch` (the
  endpoint is a POST, so `EventSource` is not applicable). Events are
  `data: {json}` lines keyed by `type` (`chunk`, `tool_call`, `tool_result`,
  `file`, `agent_step`, `memory_proposal`, `error`, `done`).
- Long tool runs can be silent between events; the client keeps the
  connection open without a read timeout (the backend sends no heartbeat
  after the initial `connected` event).
- Set `ARKIMEDE_DEBUG=/path/to/log` to append TUI diagnostics to a file.

Planned evolutions (authenticated file downloads, single-binary packaging,
more settings tabs) are tracked internally.
