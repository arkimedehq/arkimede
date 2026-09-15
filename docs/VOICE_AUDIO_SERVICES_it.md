# Servizi audio voce: Piper TTS + route audio OpenAI-compatible

Stato: IMPLEMENTATO (2026-08-31) — `piper-service/`, `backend/src/tts/`,
route audio in `openai-compat`, migration 082. Copia inglese
(canonica): `VOICE_AUDIO_SERVICES.md`.

Obiettivo: rendere Arkimede un **provider OpenAI-compatible completo
(chat + audio)** in modo che qualsiasi client a dialetto OpenAI — primo
consumatore: il bridge del satellite vocale quacksat (vedi
`docs/agent-backend-plan.md` nel repo quacksat) — possa usare il Whisper
di Arkimede per lo STT e un nuovo servizio Piper per il TTS tramite
route standard:

- `POST /api/openai/v1/audio/transcriptions` (esiste internamente, serve
  una route pubblica autenticata)
- `POST /api/openai/v1/audio/speech` (completamente nuova: servizio +
  route)

Regola di design: rispecchiare ciò che già esiste. Il nuovo
`piper-service` copia la forma di `whisper-service`; le nuove route
vivono accanto a
`backend/src/openai-compat/openai-compat.controller.ts` (prefisso
`api/openai/v1`, `JwtAuthGuard` che già accetta API key `ak_…`); la
nuova configurazione TTS rispecchia il pattern provider `transcription*`
in `backend/src/app-config/`.

## Stato attuale (verificato 2026-08-31)

- `whisper-service/main.py` parla già il dialetto OpenAI internamente:
  `POST /v1/audio/transcriptions` (multipart `file`, `model`,
  `language`, `response_format`), `GET /v1/models`, `GET /health`;
  FastAPI + faster-whisper; porta 9000, **non esposta sull'host in
  prod** (`docker-compose.yml:77-93`), env
  `WHISPER_MODEL`/`WHISPER_DEVICE`/`WHISPER_COMPUTE_TYPE`
  (`.env.example:147-153`).
- `backend/src/transcription/` lo proxya per il frontend con una forma
  *non standard* (`POST /api/transcription`, campo multipart `audio`,
  limite 25 MB, memory storage) tramite `TranscriptionService`, che
  incapsula l'SDK npm `openai` contro una base URL configurabile
  (provider `internal | openai | groq | openai-compatible`,
  `TRANSCRIPTION_BASE_URL`, default `http://whisper:9000/v1`, override
  Docker a `docker-compose.yml:175`). Lasciare questa route intatta.
- **Nessun TTS da nessuna parte**: nessun servizio, nessuna route,
  nessun enum provider, niente nel compose. `app-config` ha solo
  `TranscriptionProvider` (`backend/src/app-config/app-config.entity.ts:54`).
- `openai-compat.controller.ts` serve `GET /api/openai/v1/models` e
  `POST /api/openai/v1/chat/completions` (streaming SSE), protetti da
  `JwtAuthGuard` (JWT **oppure** chiave `ak_` — la credenziale giusta
  per un satellite headless).

## Parte 1 — `piper-service/` (nuovo container)

Rispecchiare esattamente la forma di `whisper-service/`:

```
piper-service/
├── Dockerfile          # python slim, EXPOSE 9100, HEALTHCHECK /health
├── requirements.txt    # fastapi, uvicorn, piper-tts
└── main.py
```

`main.py` (FastAPI):

- `POST /v1/audio/speech` — body di richiesta OpenAI:
  `{ "model": "piper", "voice": "<piper voice id>", "input": "<text>",
  "response_format": "wav" }`.
  - `voice`: un id voce Piper (es. `it_IT-paola-medium`,
    `en_US-lessac-medium`). Default dall'env `PIPER_VOICE`
    (default `it_IT-paola-medium`).
  - Risposta: byte audio grezzi con `Content-Type` corretto
    (`audio/wav`). Supportare prima `wav`; `mp3` opzionale più avanti
    (richiede ffmpeg — saltarlo in v1, restituire 400 per i formati non
    supportati).
  - API python di Piper: caricare `PiperVoice` una volta per voce
    (cache LRU delle voci caricate), sintetizzare in un WAV in memoria.
- `GET /v1/models` — elencare le voci scaricate (scansione della
  directory dei modelli), stesso stile di envelope di
  `whisper-service/main.py:81`.
- `GET /health` — `{"status": "ok"}` una volta caricata la voce di
  default (rispecchiare la semantica di readiness di whisper).
- File delle voci: scaricati in build o al primo avvio in un volume.
  Env `PIPER_MODELS_DIR=/models`, `PIPER_VOICE` come sopra; download dal
  repository ufficiale delle voci rhasspy/piper (HuggingFace
  `rhasspy/piper-voices`), scaricando `<voice>.onnx` +
  `<voice>.onnx.json` on demand quando una voce richiesta manca (log +
  404 se il download è disabilitato via `PIPER_OFFLINE=1`).
- Nessuna auth (isolamento sulla rete Docker, esattamente come
  whisper-service).

`docker-compose.yml`: aggiungere un servizio `piper` accanto a `whisper`
(:77-93 come template): build context `./piper-service`, nessuna porta
host, `healthcheck` su `/health`, volume `piper-models:/models`,
`mem_limit` simile a quello di whisper se ne è impostato uno. Aggiungere
il volume alla sezione volumes. In `docker-compose.override.yml`,
mappare `9100:9100` per il dev (rispecchiando il `9000:9000` di whisper
a :33-35). Aggiungere `TTS_BASE_URL=http://piper:9100/v1` all'env del
servizio backend (rispecchiando `TRANSCRIPTION_BASE_URL` a :175).

`.env.example`: nuovo blocco accanto a quello di whisper (:147-153):
`PIPER_VOICE=it_IT-paola-medium`, `TTS_PROVIDER=internal`,
`TTS_BASE_URL=http://localhost:9100/v1` (default per il dev),
`TTS_API_KEY=` (vuota per internal).

## Parte 2 — backend: `TtsService` + route audio OpenAI-compat

### 2a. `backend/src/tts/` (nuovo modulo, rispecchia `transcription/`)

- `tts.service.ts`: astrazione a provider come
  `transcription.service.ts` (:34-45): provider
  `internal | openai | openai-compatible`; client SDK npm `openai`
  contro la base URL configurata (`client.audio.speech.create`), con
  cache e invalidazione al salvataggio della config admin (rispecchiare
  :60-62); `synthesize(text, voice?, format?) -> Buffer` più un
  `testConnection()` che sintetizza una stringa breve (rispecchiare
  :168-178).
- `tts.module.ts`, collegarlo in `app.module.ts` accanto a
  `TranscriptionModule`.
- `app-config`: aggiungere l'enum `TtsProvider` + le colonne
  `ttsProvider`, `ttsBaseUrl`, `ttsApiKey`, `ttsModel`, `ttsVoice`
  accanto ai campi `transcription*` (zona `app-config.entity.ts:54`) +
  migrazione. La card nella UI admin può arrivare dopo; per la v1 è
  accettabile la configurazione solo via env.

### 2b. Route in `openai-compat.controller.ts`

Aggiungere due handler accanto a `completions()` (stessa guard, stesso
supporto `ak_`):

- `POST audio/transcriptions` — accettare il multipart **standard**
  (campo `file`, opzionali `model`, `language`, `response_format`).
  Usare un `FileInterceptor('file')` con memory storage e lo stesso
  limite di 25 MB di `transcription.controller.ts:13`. Delegare
  all'esistente `TranscriptionService.transcribe(buffer, filename,
  language)`. Restituire `{ "text": ... }` in forma OpenAI (json)
  oppure testo semplice (`response_format=text`). **Non** toccare
  `/api/transcription` (il frontend mantiene il suo campo `audio`).
- `POST audio/speech` — body JSON `{ model?, voice?, input,
  response_format? }`, validato con un DTO (`input` obbligatorio, con
  limite di lunghezza, es. 4096 caratteri come OpenAI). Delegare a
  `TtsService.synthesize`; inviare il Buffer in streaming con
  `Content-Type: audio/wav`. Taggare usage/costi con
  `origin: 'voice'` come fa completions (pattern
  `openai-compat.controller.ts:185`) se si vuole la contabilità del TTS
  (opzionale in v1).

### 2c. Non-obiettivi (tenere fuori da questa modifica)

- Nessuno STT in streaming/chunked (solo file intero, come oggi).
- Nessun TTS a streaming di frasi (frase intera in ingresso, audio
  intero in uscita); il bridge vocale spezza il testo dalla sua parte se
  serve.
- Nessuna modifica a `/api/transcription` o al frontend.
- Nessun gateway WebSocket `/voice` — quello è un progetto separato e
  successivo (supporto satellite nativo; vedi il piano di quacksat,
  "phase 2").

## Verifiche di accettazione

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

- Entrambe le route rifiutano senza un JWT/chiave `ak_` validi.
- Container `piper`: healthcheck verde, nessuna porta host nel compose
  di prod.
- Le suite esistenti restano verdi (`/api/transcription` intatta; i
  test dell'openai-mapper non sono toccati — le route audio non passano
  dal mapper).
- Unit test: selezione del provider e caching del client in
  `TtsService` (rispecchiare i test del servizio di trascrizione se
  presenti); validazione del DTO nel controller (`input` vuoto → 400).

## Parte 3 — Server vocale Wyoming (Home Assistant & co.)

Stato: IMPLEMENTATO (2026-09-15) — `backend/src/wyoming/`, migration 084,
card admin "Server vocale Wyoming" (Impostazioni → Voce e audio).

Gli hub vocali come Home Assistant parlano il [protocollo Wyoming](https://github.com/rhasspy/wyoming)
con i loro provider di trascrizione e sintesi (gli add-on ufficiali
Whisper/Piper sono server Wyoming). Arkimede espone **i provider STT/TTS
configurati nel pannello admin** — Whisper + Piper interni, o qualsiasi
endpoint cloud/OpenAI-compatible — come server Wyoming: l'hub usa Arkimede
come provider STT/TTS nativo senza componenti aggiuntivi (niente HACS, niente
API key sull'hub).

Design (rispecchia il resto della piattaforma: una feature, configurata dall'admin):

- `WyomingService` apre un listener TCP (`net.createServer`) **solo se
  `app_config.wyomingEnabled` è true**; il toggle admin lo (ri)avvia a caldo
  tramite `applyConfig()` — nessun riavvio del container.
- Porta = livello deployment `WYOMING_PORT` (default 10300), pubblicata da
  `docker-compose.yml` sul servizio backend. Da spento nessuno ascolta →
  connessione rifiutata. La card mostra porta (sola lettura) e stato live.
- Il protocollo **non ha autenticazione**: l'accesso è filtrato dall'allowlist
  opzionale `wyomingAllowedCidrs` (IP / CIDR IPv4, verificata a ogni
  connessione con lo stesso matcher delle policy SSRF). Default spento.
- `wyoming.protocol.ts` — framing puro (`encodeEvent` / `WyomingDecoder`) e
  helper PCM ⇄ WAV, con unit test in `test/unit/wyoming-protocol.spec.ts`.
- Eventi gestiti per connessione (Home Assistant ne apre una per richiesta):
  `describe → info` (capacità costruite da `TranscriptionService.describe()` e
  `TtsService.describe()`: nomi reali di modello/voce, lingua della voce
  derivata da id come `it_IT-paola-medium`), `transcribe` +
  `audio-start/chunk/stop → transcript` (PCM bufferizzato, incapsulato in WAV,
  inviato allo STT configurato), `synthesize → audio-start/chunk*/stop` (WAV
  del TTS parsato e trasmesso come PCM nel formato nativo), `ping → pong`.
  Gli eventi sconosciuti vengono ignorati.
- Guardie: frame max 16 MB, audio max ~5 min per trascrizione, timeout idle
  120 s per socket, errori del provider riportati come evento Wyoming `error`.
- Fuori scope (per ora): eventi `handle` (agente di conversazione Wyoming →
  chiamerebbe direttamente `AgentService` con utente/agente scelti dall'admin),
  `synthesize-*` in streaming, wake-word.

Configurazione in Home Assistant: Impostazioni → Dispositivi e servizi →
Aggiungi integrazione → *Wyoming Protocol* → host = IP di Arkimede, porta =
10300 → compaiono le entità STT e TTS; selezionale nella pipeline di Assist.
I satelliti (Voice PE, app Companion) usano così i modelli di Arkimede
attraverso l'hub.
