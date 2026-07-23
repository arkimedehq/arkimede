# Arkimede CLI

Terminal client for [Arkimede](../README.md): log in and chat with your agents straight from the shell, against any running Arkimede backend. Linux and macOS, Node ≥ 18.17.

## Install & build

```bash
cd cli
npm install
npm run build
npm link        # optional: makes the `arkimede` command available globally
```

Without `npm link`, run it as `node dist/index.js <command>`.

## Usage

```bash
arkimede login --url http://localhost:3000   # prompts for email + password
arkimede chats                               # list your chats
arkimede chat                                # full-screen TUI (default)
arkimede chat --new "My topic"               # start a fresh chat
arkimede chat --chat <id>                    # open a specific chat
arkimede chat --plain                        # line-based REPL instead of the TUI
arkimede whoami                              # check the stored session
arkimede logout
```

`arkimede` with no arguments opens the TUI on your most recent chat (`chat` is
the default command).

### The TUI

Full-screen terminal UI with a chat sidebar, a scrollable message pane, an
input bar and a status line:

| Key | Effect |
|---|---|
| `Enter` | send the message |
| `Esc` | stop the assistant while it is responding |
| `Tab` | toggle focus between input and the chat sidebar |
| `↑`/`↓` | input: scroll messages · sidebar: move selection |
| `PgUp`/`PgDn` | scroll messages |
| `n` (sidebar) | new chat |
| `s` (sidebar) | settings panel (profile, session, LLM configuration) |
| `q` (sidebar) / `Ctrl+C` | quit |

The assistant reply streams live; tool invocations show up as compact
`⚙ tool` / `✓ tool` status lines, files produced by skills are listed with
their download URL, and multi-agent chats render per-agent `◆` blocks.
Set `ARKIMEDE_DEBUG=/path/to/log` to append TUI diagnostics to a file.

The settings panel is organized in tabs — switch with `←`/`→`, `Tab` or the
digit keys, close with `Esc`. In list tabs, `↑`/`↓` selects a row and
`Space`/`Enter` triggers the row action:

| Tab | Content | Action |
|---|---|---|
| 1 Profile | name, email, role, language, memory/history prefs, session (backend, token expiry) | — |
| 2 LLM | LLM configurations with `default`★/`summarizer`/`vision` roles (admin-only) | `Enter` set default · `a` add · `e` edit · `d` delete |
| 3 Tools | custom tools visible to you: enabled state, executor type, scope | `Space` toggle · `a` add · `e` edit · `d` delete |
| 4 Skills | installed skills: enabled state, version, typed/descriptive, scope | toggle enabled |
| 5 Data | data sources: engine and scope | — |
| 6 MCP | MCP servers: transport, endpoint/command, enabled state | `Space` toggle · `a` add · `e` edit · `d` delete |
| 7 Usage | token totals, by model and (admin) by user with costs | — |

The LLM, Tools and MCP tabs share the same create/edit form pattern:
navigate fields with `↑`/`↓`/`Tab`, cycle enum values with `←`/`→`, submit
from the `[Save]` row, cancel with `Esc`. Deleting asks for confirmation
(`y`); the last remaining LLM configuration cannot be deleted (also enforced
server-side; deleting the default promotes the oldest remaining config).

Per-tab form notes:
- **LLM**: the API key field is masked and write-only — leave it empty when
  editing to keep the stored key.
- **Tools**: the TUI creates the self-contained executor types — `http`
  (URL + method) and `prompt` (sub-agent prompts). `sql`/`rag` tools need
  data-source/collection pickers and are created from the web UI; their
  description stays editable here. Editing merges into the existing
  executor config, so advanced fields set on the web (headers, timeouts,
  parameters…) are preserved. Tool names are immutable after creation.
- **MCP**: url for `http`/`sse`/`remote`, command+args for `local`
  (admin-only). Headers, env vars and secrets are managed from the web UI.

Actions call the same backend endpoints as the web UI, so ownership and
admin rules apply unchanged (a 403 is shown as "not allowed"). API keys are
never transmitted back — the backend only exposes a has-key flag; admin-only
tabs show an explanatory note to regular users.

### The plain REPL (`--plain`)

Used automatically when stdin/stdout are not a terminal (pipes, scripts).

| Command | Effect |
|---|---|
| `/chats` | list chats and switch |
| `/new [title]` | create a new chat and switch to it |
| `/history [n]` | show the last *n* messages (default 20) |
| `/title <text>` | rename the current chat |
| `/quit`, `/exit` | leave |

Anything else is sent as a message. **Ctrl+C while the assistant is responding
stops the generation** (the server aborts the run when the connection drops);
at the prompt, Ctrl+C exits.

## Session storage

The JWT and user profile are stored in `~/.config/arkimede/config.json`
(mode `0600`). Tokens expire after the backend's `JWT_EXPIRES_IN` (default 7
days) — just `arkimede login` again. Set `ARKIMEDE_CONFIG_DIR` to relocate the
config file.

## Notes

- The model/LLM is resolved server-side (the admin's default LLM config); the
  CLI never selects a model.
- Streaming uses the same protocol as the web frontend: `POST
  /api/chats/:id/messages/stream` consumed as an SSE body. Long tool runs can
  be silent between events; the CLI keeps the connection open without a read
  timeout.
- Chats attached to a multi-agent team stream `agent_step` blocks instead of
  token-by-token text; both are supported.
