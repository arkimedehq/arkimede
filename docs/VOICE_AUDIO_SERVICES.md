# Voice audio services: Piper TTS + OpenAI-compatible audio routes

Status: IMPLEMENTED (2026-08-31) — `piper-service/`, `backend/src/tts/`,
audio routes in `openai-compat`, migration 082. Italian copy:
`VOICE_AUDIO_SERVICES_it.md`.

Goal: make Arkimede a **complete OpenAI-compatible provider (chat +
audio)** so that any OpenAI-dialect client — first consumer: the
quacksat voice-satellite bridge (see `docs/agent-backend-plan.md` in the
quacksat repo) — can use Arkimede's Whisper for STT and a new Piper
service for TTS through standard routes:

- `POST /api/openai/v1/audio/transcriptions` (exists internally, needs a
  public authenticated route)
- `POST /api/openai/v1/audio/speech` (fully new: service + route)

Design rule: mirror what already exists. The new `piper-service` copies
`whisper-service`'s shape; the new routes live beside
`backend/src/openai-compat/openai-compat.controller.ts` (prefix
`api/openai/v1`, `JwtAuthGuard` which already accepts `ak_…` API keys);
the new TTS config mirrors the `transcription*` provider pattern in
`backend/src/app-config/`.

## Current state (verified 2026-08-31)

- `whisper-service/main.py` already speaks the OpenAI dialect
  internally: `POST /v1/audio/transcriptions` (multipart `file`,
  `model`, `language`, `response_format`), `GET /v1/models`,
  `GET /health`; FastAPI + faster-whisper; port 9000, **not
  host-exposed in prod** (`docker-compose.yml:77-93`), env
  `WHISPER_MODEL`/`WHISPER_DEVICE`/`WHISPER_COMPUTE_TYPE`
  (`.env.example:147-153`).
- `backend/src/transcription/` proxies it for the frontend with a
  *non-standard* shape (`POST /api/transcription`, multipart field
  `audio`, 25 MB cap, memory storage) via `TranscriptionService`, which
  wraps the `openai` npm SDK against a configurable base URL
  (providers `internal | openai | groq | openai-compatible`,
  `TRANSCRIPTION_BASE_URL`, default `http://whisper:9000/v1`, Docker
  override at `docker-compose.yml:175`). Keep this route untouched.
- **No TTS anywhere**: no service, no route, no provider enum, nothing
  in compose. `app-config` has only `TranscriptionProvider`
  (`backend/src/app-config/app-config.entity.ts:54`).
- `openai-compat.controller.ts` serves `GET /api/openai/v1/models` and
  `POST /api/openai/v1/chat/completions` (SSE streaming), guarded by
  `JwtAuthGuard` (JWT **or** `ak_` key — the right credential for a
  headless satellite).

## Part 1 — `piper-service/` (new container)

Mirror `whisper-service/` exactly in shape:

```
piper-service/
├── Dockerfile          # python slim, EXPOSE 9100, HEALTHCHECK /health
├── requirements.txt    # fastapi, uvicorn, piper-tts
└── main.py
```

`main.py` (FastAPI):

- `POST /v1/audio/speech` — OpenAI request body:
  `{ "model": "piper", "voice": "<piper voice id>", "input": "<text>",
  "response_format": "wav" }`.
  - `voice`: a Piper voice id (e.g. `it_IT-paola-medium`,
    `en_US-lessac-medium`). Default from env `PIPER_VOICE`
    (default `it_IT-paola-medium`).
  - Response: raw audio bytes with correct `Content-Type`
    (`audio/wav`). Support `wav` first; `mp3` optional later (needs
    ffmpeg — skip in v1, return 400 for unsupported formats).
  - Piper python API: load `PiperVoice` once per voice (LRU cache of
    loaded voices), synthesize to an in-memory WAV.
- `GET /v1/models` — list the downloaded voices (scan the models dir),
  same envelope style as `whisper-service/main.py:81`.
- `GET /health` — `{"status": "ok"}` once the default voice is loaded
  (mirror whisper's readiness semantics).
- Voice files: downloaded at build or first start into a volume.
  Env `PIPER_MODELS_DIR=/models`, `PIPER_VOICE` as above; download from
  the official rhasspy/piper voices repository (HuggingFace
  `rhasspy/piper-voices`), fetching `<voice>.onnx` + `<voice>.onnx.json`
  on demand when a requested voice is missing (log + 404 if the
  download is disabled via `PIPER_OFFLINE=1`).
- No auth (Docker-network isolation, exactly like whisper-service).

`docker-compose.yml`: add a `piper` service next to `whisper`
(:77-93 as the template): build context `./piper-service`, no host
ports, `healthcheck` on `/health`, volume `piper-models:/models`,
`mem_limit` similar to whisper's if one is set. Add the volume to the
volumes section. In `docker-compose.override.yml`, map `9100:9100` for
dev (mirroring whisper's `9000:9000` at :33-35). Add
`TTS_BASE_URL=http://piper:9100/v1` to the backend service env
(mirroring `TRANSCRIPTION_BASE_URL` at :175).

`.env.example`: new block next to the whisper one (:147-153):
`PIPER_VOICE=it_IT-paola-medium`, `TTS_PROVIDER=internal`,
`TTS_BASE_URL=http://localhost:9100/v1` (dev default), `TTS_API_KEY=`
(empty for internal).

## Part 2 — backend: `TtsService` + OpenAI-compat audio routes

### 2a. `backend/src/tts/` (new module, mirror `transcription/`)

- `tts.service.ts`: provider-abstracted like
  `transcription.service.ts` (:34-45): providers
  `internal | openai | openai-compatible`; `openai` npm SDK client
  against the configured base URL (`client.audio.speech.create`),
  cached and invalidated on admin config save (mirror :60-62);
  `synthesize(text, voice?, format?) -> Buffer` plus a
  `testConnection()` that synthesizes a short string (mirror :168-178).
- `tts.module.ts`, wire into `app.module.ts` beside
  `TranscriptionModule`.
- `app-config`: add `TtsProvider` enum + `ttsProvider`, `ttsBaseUrl`,
  `ttsApiKey`, `ttsModel`, `ttsVoice` columns beside the
  `transcription*` fields (`app-config.entity.ts:54` area) + migration.
  Admin UI card can follow later; env-only config is acceptable for v1.

### 2b. Routes in `openai-compat.controller.ts`

Add two handlers beside `completions()` (same guard, same `ak_`
support):

- `POST audio/transcriptions` — accept the **standard** multipart
  (field `file`, optional `model`, `language`, `response_format`).
  Use a `FileInterceptor('file')` with memory storage and the same
  25 MB cap as `transcription.controller.ts:13`. Delegate to the
  existing `TranscriptionService.transcribe(buffer, filename,
  language)`. Return OpenAI-shaped `{ "text": ... }` (json) or plain
  text (`response_format=text`). Do **not** touch
  `/api/transcription` (frontend keeps its `audio` field).
- `POST audio/speech` — JSON body `{ model?, voice?, input,
  response_format? }`, validated with a DTO (`input` required,
  length-capped, e.g. 4096 chars like OpenAI). Delegate to
  `TtsService.synthesize`; stream the Buffer with `Content-Type:
  audio/wav`. Tag usage/costs with `origin: 'voice'` like completions
  does (`openai-compat.controller.ts:185` pattern) if TTS accounting is
  wanted (optional in v1).

### 2c. Non-goals (keep out of this change)

- No streaming/chunked STT (whole-file only, as today).
- No sentence-streaming TTS (whole utterance in, whole audio out); the
  voice bridge chunks text on its side if needed.
- No change to `/api/transcription` or the frontend.
- No `/voice` WebSocket gateway — that is a separate, later project
  (native satellite support; see quacksat's plan, "phase 2").

## Acceptance checks

```sh
# STT (standard dialect, ak_ key):
curl -s http://localhost:3000/api/openai/v1/audio/transcriptions \
  -H "Authorization: Bearer ak_..." \
  -F file=@sample-16k-mono.wav -F language=it
# → {"text":"..."}

# TTS:
curl -s http://localhost:3000/api/openai/v1/audio/speech \
  -H "Authorization: Bearer ak_..." -H "Content-Type: application/json" \
  -d '{"input":"Ciao, sono Arkimede","voice":"it_IT-paola-medium"}' \
  -o out.wav && afplay out.wav   # (or aplay)
```

- Both routes refuse without a valid JWT/`ak_` key.
- `piper` container: healthcheck green, no host port in prod compose.
- Existing suites stay green (`/api/transcription` untouched;
  openai-mapper tests unaffected — audio routes don't touch the
  mapper).
- Unit tests: `TtsService` provider selection + client caching
  (mirror the transcription service tests if present); controller DTO
  validation (empty `input` → 400).

## Part 2b — Whisper model switch at runtime (2026-09-15)

`whisper-service` mirrors the Piper voices: the `model` field of
`/v1/audio/transcriptions` may name any size of `ALLOWED_MODELS` (tiny, base,
small, medium, large-v3, large-v3-turbo); a different size is loaded under a
lock — downloaded on first use into `/models`, a named volume seeded with the
image's default (`WHISPER_MODEL`) — and replaces the previous one (one model
in RAM). `/v1/models` lists the current model first with `current`/`downloaded`
flags. `TranscriptionService` sends the admin-chosen `transcriptionModel` for
the internal provider (empty = the service's current model); the admin card
shows the sizes as chips with the RAM guide, and "Test" triggers the download.

## Part 3 — Wyoming voice server (Home Assistant & co.)

Status: IMPLEMENTED (2026-09-15) — `backend/src/wyoming/`, migration 084,
admin card "Wyoming voice server" (Settings → Voice & audio).

Voice hubs such as Home Assistant speak the [Wyoming protocol](https://github.com/rhasspy/wyoming)
to their speech-to-text and text-to-speech providers (the official Whisper/Piper
add-ons are Wyoming servers). Arkimede exposes **the STT/TTS providers configured
in the admin panel** — internal Whisper + Piper, or any cloud/OpenAI-compatible
endpoint — as a Wyoming server, so a hub can use Arkimede as a native
STT/TTS provider with zero extra components (no HACS, no API keys on the hub).

Design (mirrors the rest of the platform: one feature, admin-configured):

- `WyomingService` opens a TCP listener (`net.createServer`) **only when
  `app_config.wyomingEnabled` is true**; the admin toggle (re)starts it at
  runtime through `applyConfig()` — no container restart.
- Port = deployment-level `WYOMING_PORT` (default 10300), published by
  `docker-compose.yml` on the backend service. When disabled nothing listens
  → connection refused. The admin card shows the port read-only + live status.
- The protocol has **no authentication**: access is gated by the optional
  client allowlist `wyomingAllowedCidrs` (IPs / IPv4 CIDRs, checked on every
  connection with the same matcher as the SSRF policies). Default off.
- `wyoming.protocol.ts` — pure framing (`encodeEvent` / `WyomingDecoder`) and
  PCM ⇄ WAV helpers, unit-tested in `test/unit/wyoming-protocol.spec.ts`.
- Events handled per connection (Home Assistant opens one per request):
  `describe → info` (capabilities built from `TranscriptionService.describe()`
  and `TtsService.describe()`: real model/voice names, voice language derived
  from ids like `it_IT-paola-medium`), `transcribe` + `audio-start/chunk/stop
  → transcript` (PCM buffered, wrapped as WAV, sent to the configured STT),
  `synthesize → audio-start/chunk*/stop` (TTS output WAV parsed and streamed as
  PCM in its native format), `ping → pong`. Unknown events are ignored.
- Guards: 16 MB max frame, ~5 min max audio per transcription, 120 s idle
  timeout per socket, provider failures reported as a Wyoming `error` event.
- **Conversation agent** ("handle" program, migration 085): when the admin picks
  a user (`wyomingHandleUserId`) and optionally one of their agents
  (`wyomingHandleAgentId`), the `info` also advertises a `handle` program and
  the hub can use Arkimede as its *conversation agent* — the whole Assist
  pipeline (STT → conversation → TTS) then runs on this single Wyoming
  endpoint, with no HACS component and no API key on the hub. The hub sends a
  `transcript` event (`text`, `language`, `context.conversation_id`); the
  server runs `AgentService.streamResponse` as that user with the agent's
  overrides (`agentRunOptions`, shared with the OpenAI shim), keeps a
  per-`conversation_id` window (20 messages, 10 min TTL) for multi-turn
  context — the hub only sends the current text — and answers `handled`
  (or `not-handled` with the error text). Every turn is logged in
  `agent_invocations` (origin `voice`, model `wyoming:<agent-slug>`).
  A deleted/disabled user or a vanished agent disables the handle program
  (logged) without affecting STT/TTS; the PATCH validates both.
- Not in scope: streaming `synthesize-*`, wake-word, intent recognition.

Home Assistant setup: Settings → Devices & services → Add integration →
*Wyoming Protocol* → host = Arkimede's IP, port = 10300 → the STT, TTS (and,
with a conversation user configured, the conversation agent) entities appear;
select them in the Assist pipeline. Satellites (Voice PE, Companion app) then
use Arkimede end-to-end through the hub.
