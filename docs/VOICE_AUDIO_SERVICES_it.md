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
  (`.env.example:147-153`); dal 2026-11-02 anche `WHISPER_BEAM_SIZE`
  (predefinito 1, ricerca greedy: su turni vocali brevi lo stesso testo
  del beam 5, un po' più veloce) e `WHISPER_CPU_THREADS` (0 = i 4 di
  CTranslate2; i core dell'host li usano tutti: su un Core i3-1215U 6
  thread portano un turno di 4 s da 2,6 a 1,9 s).
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
    (default `it_IT-serena-medium`; era `it_IT-paola-medium` fino a
    2026-10 — un'installazione che ha impostato `PIPER_VOICE` o una voce
    nel pannello admin la mantiene, una che si affidava al default passa a
    serena alla prossima ricostruzione dell'immagine: impostare
    `PIPER_VOICE=it_IT-paola-medium` per tenere paola. Con
    `PIPER_OFFLINE=1` e serena non presente su disco il servizio ripiega su
    una voce già presente nel volume dei modelli).
  - Risposta: byte audio grezzi con `Content-Type` corretto
    (`audio/wav`). Supportare prima `wav`; `mp3` opzionale più avanti
    (richiede ffmpeg — saltarlo in v1, restituire 400 per i formati non
    supportati).
  - API python di Piper: caricare `PiperVoice` una volta per voce
    (cache LRU delle voci caricate), sintetizzare in un WAV in memoria.
    Un testo lungo è sintetizzato a pezzi di al massimo `PIPER_CHUNK_CHARS`
    (default 400) tagliati a fine frase, con l'audio unito in un solo WAV:
    la memoria resta limitata dal pezzo (un messaggio di ~5000 caratteri
    faceva morire il container al limite di 512 MB). Una riga che finisce
    senza punteggiatura conta come fine frase.
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
`PIPER_VOICE=it_IT-serena-medium`, `TTS_PROVIDER=internal`,
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

## Parte 2b — Cambio modello Whisper a runtime (2026-09-15)

`whisper-service` rispecchia le voci di Piper: il campo `model` di
`/v1/audio/transcriptions` può indicare una qualsiasi taglia di
`ALLOWED_MODELS` (tiny, base, small, medium, large-v3, large-v3-turbo); una
taglia diversa viene caricata sotto lock — scaricata alla prima richiesta in
`/models`, volume nominato inizializzato con il default dell'immagine
(`WHISPER_MODEL`) — e sostituisce la precedente (un solo modello in RAM).
`/v1/models` elenca per primo il modello corrente con i flag
`current`/`downloaded`. `TranscriptionService` invia il `transcriptionModel`
scelto dall'admin per il provider interno (vuoto = modello corrente del
servizio); la card mostra le taglie come chip con la guida RAM e "Testa" avvia
il download.

## Parte 2b-bis — Motore Parakeet (2026-11-02)

`whisper-service` ha un secondo motore, NVIDIA Parakeet. Si carica un solo motore
alla volta e l'API non cambia (`POST /v1/audio/transcriptions`, `GET /v1/models`,
`GET /health`, che ora riporta anche `engine`): backend, server Wyoming, Home Assistant
e satelliti vocali non richiedono nulla.

L'admin sceglie il modello in **Impostazioni → Voce e audio**, accanto alle taglie
Whisper (`parakeet-tdt-0.6b-v3`): il backend lo invia nel campo `model` e il servizio
cambia motore al volo, come già faceva con le taglie Whisper. `STT_ENGINE` (`whisper`,
il default, oppure `parakeet`) è il motore caricato all'avvio e quello che usa "auto"
finché una richiesta non ne indica un altro. Il modello Whisper di default resta
nell'immagine, quindi tornare a Whisper non richiede mai un download.

- **Modello**: NVIDIA Parakeet TDT 0.6B v3, export ONNX int8 di sherpa-onnx
  (`PARAKEET_MODEL`, default `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`), eseguito
  con `sherpa-onnx`. Scaricato al primo uso (archivio ~490 MB, ~640 MB estratto) nel
  volume `whisper_models` in `parakeet/<modello>/`; con `PARAKEET_OFFLINE=1` non viene
  mai scaricato (deve essere già lì). Thread: `PARAKEET_THREADS`, altrimenti
  `WHISPER_CPU_THREADS`, altrimenti 4.
- **Audio**: decodificato come per Whisper (av/ffmpeg: wav, webm, ogg, mp3 → 16 kHz mono).
- **Lingue**: 25 lingue europee (italiano e inglese inclusi), riconosciute dal modello.
  Il `language` della richiesta è accettato e ignorato; una lingua fuori da quelle 25
  non viene trascritta bene: per quella resta Whisper.
- **Campo `model`**: una taglia Whisper o l'id di Parakeet caricano quel modello (vuoto
  o `whisper-1` tengono quello caricato; un nome sconosciuto è un 400). Tra taglie
  Whisper il vecchio modello risponde mentre si carica il nuovo; tra motori diversi
  quello caricato viene liberato prima, così due modelli non condividono mai la memoria
  del container, e viene ricaricato se il nuovo fallisce (la richiesta riceve un 503).
  `/v1/models` elenca per primo il modello caricato (la sonda del backend legge
  `data[0]`), poi le taglie Whisper e Parakeet, ciascuno con `engine` e `downloaded`.
  Un cambio richiede ~0,3–2 s quando il modello è già su disco.
- **Misure sul Kinox** (Core i3-1215U, 6 thread, sei frasi italiane sintetizzate con
  Piper): Whisper small int8 1,75–2,06 s per frase, anche per un "Che ore sono?" di
  0,9 s (finestra fissa di 30 s); Parakeet 0,18–0,80 s, proporzionale alla frase;
  qualità pari (un errore a testa); Parakeet scrive i numeri in cifre ("2019"). Picco
  RSS 849 MB contro 992 MB; caricamento del modello 2,7 s. Da confermare con una voce
  vera in una stanza vera. Thread: su questa CPU ibrida (2 core performance + 4
  efficienti) **4 thread** sono i più veloci e stabili, 0,15–0,47 s per frase, contro
  0,25–0,61 s con 6 e fino a 1,2 s con 8: imposta `PARAKEET_THREADS` ai thread dei core
  performance.
- **Audio lunghi**: un solo passaggio su tutto il file; va bene per turni vocali e
  dettature di qualche minuto, non per registrazioni di ore.

## Parte 2c — Toggle TTS e rilevamento servizi interni (2026-09-29)

- `app_config.ttsEnabled` (migration 086, default true) abilita la sintesi
  vocale come `transcriptionEnabled` abilita il microfono: pulsante di lettura
  in chat (`GET /api/tts/status`), rotta speech (503 `tts.disabled`) e
  programma TTS di Wyoming. Il "Testa" admin funziona anche da disabilitata.
- I container whisper/piper interni possono essere esclusi dal deployment
  (`docker-compose.novoice.yml`). Il backend sonda `<origin base-url>/health`
  (qualsiasi risposta HTTP = installato, cache 30 s) e restituisce
  `internalAvailable` da `GET /api/admin/config/{transcription,tts}`: le card
  admin disattivano l'opzione "Interno" e avvisano se è ancora selezionata. Gli
  endpoint di stato e l'`info` Wyoming trattano un provider interno non
  installato come disabilitato, quindi microfono/lettura restano nascosti.

## Parte 2d — Lettura di un messaggio a pezzi (2026-11-17)

Il pulsante di lettura in chat (`SpeakButton` in `MessageBubble.tsx`, helper in
`frontend/src/utils/ttsText.ts`) non sintetizza più tutto il messaggio in una
volta (su un messaggio lungo aspettava ~9 s prima di sentire qualcosa, e
tagliava a 4096 caratteri). Il markdown diventa testo semplice (un titolo o una
voce di elenco prendono il punto finale, così la voce fa la pausa), poi viene
tagliato a fine frase: un primo pezzo di al massimo 200 caratteri, i successivi
di al massimo 600. Il primo pezzo suona in molto meno di un secondo; ogni pezzo
successivo è chiesto mentre suona il precedente. Un clic durante il caricamento
o la lettura la ferma. Funziona con qualsiasi provider TTS (usa solo la rotta
speech).

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
- **Agente di conversazione** (programma "handle", migration 085 e 114): se
  l'admin lo accende (`wyomingConversationEnabled`), l'`info` pubblica anche un
  programma `handle` (il modello: l'agente per la voce dell'account predefinito) e
  l'hub può usare Arkimede come *agente di conversazione* — l'intera pipeline
  Assist (STT → conversazione → TTS) gira su questo unico endpoint Wyoming,
  senza componenti HACS né API key sull'hub. L'hub manda un evento `transcript`
  (`text`, `language`, `context.conversation_id`); il server esegue
  `AgentService.streamResponse` come l'account del turno — dal satellite
  (`context.satellite_id` / `device_id` → il punto voce di Home Assistant →
  `haSatelliteUsers`, altrimenti `haDefaultVoiceUserId`, altrimenti il primo admin
  attivo; specs/VOICE_SATELLITES.md) — con gli override del suo agente per la voce
  (`users.voiceAgentId`)
  (`agentRunOptions`, condiviso con lo shim OpenAI), mantiene una finestra per
  `conversation_id` (20 messaggi, TTL 10 min) per il contesto multi-turno —
  l'hub manda solo il testo corrente — e risponde `handled` (o `not-handled`
  con una frase per le persone nella lingua del turno, `spokenFailure`: il
  satellite la legge ad alta voce, quindi mai il testo dell'errore, che va nel
  log). Ogni turno è loggato in `agent_invocations`
  (origin `voice`, model `wyoming:<slug-agente>`). Un utente eliminato/disabilitato
  o un agente scomparso disattivano il programma handle (loggato) senza toccare
  STT/TTS; il PATCH valida entrambi.
- **Conversazione continua** (2026-10-28): `handled` porta anche
  `continue_conversation: true` quando la risposta finisce con una domanda
  (`expectsReply`), così il satellite torna in ascolto senza la wake word. Non
  ancora nel protocollo Wyoming né nell'integrazione Wyoming di Home Assistant:
  proposto a monte (un campo facoltativo su `handled` / `handled-stop`, passato a
  `ConversationResult.continue_conversation`). Finché non arriva, l'Home
  Assistant di casa usa quella modifica come copia dell'integrazione `wyoming` in
  `custom_components/`, da togliere quando il rilascio ufficiale la contiene. Gli
  hub che non conoscono il campo lo ignorano.
- **I turni lunghi si staccano** (2026-11-13): un turno ancora in corso dopo
  `WYOMING_DETACH_MS` (25 s; 0 = mai) risponde subito all'hub ("Ci sto
  lavorando: te lo dico appena ho finito.") e prosegue senza di lui: l'hub può
  chiudere, il lavoro non viene più annullato. Alla fine il turno viene salvato
  nella sua chat (anche con la persistenza spenta), la risposta viene detta dove
  si trova l'utente (l'unico canale voce, `VoiceDeliveryService`: il turno ha
  messo la presenza nella stanza del satellite) e una notifica `voice_work_done`
  apre quella chat. Un errore viene detto allo stesso modo (`spokenFailure`). La risposta aspetta finché è in corso
  uno scambio vocale (audio in arrivo, un turno che aspetta la sua risposta, una frase in riproduzione: quanto dura
  la sua sintesi), al massimo 2 min: un annuncio su un satellite interrompe la pipeline in corso su di esso. Intanto
  il lavoro è l'esecuzione della chat (creata al distacco): passo e strumenti visibili,
  `POST /api/chats/:id/run/cancel` lo ferma ("Ho fermato il lavoro"), anche quello di un agente delegato.
  Per il lavoro che dura minuti: un'app scritta file per file,
  una ricerca lunga.
- **Comandi più lunghi di quanto l'hub permette** (2026-11-13): la pipeline di Home Assistant smette di
  ascoltare dopo 15 s (`VoiceCommandSegmenter.timeout_seconds`, non configurabile), qualunque cosa si stia dicendo.
  Una trascrizione così lunga (`WYOMING_DICTATION_CUT_S`, 14,8 s; 0 = spento) è presa come tagliata: il suo turno
  non parte, il satellite dice "Continua, ti ascolto." e torna in ascolto (`continue_conversation`), e il pezzo
  successivo di quella conversazione le viene unito — fino a 6 pezzi, ognuno entro 60 s — prima che l'agente esegua
  la richiesta intera. Il riconoscimento della voce usa l'impronta dell'ultimo pezzo.
- Fuori scope: `synthesize-*` in streaming, wake-word, riconoscimento intent.

Configurazione in Home Assistant: Impostazioni → Dispositivi e servizi →
Aggiungi integrazione → *Wyoming Protocol* → host = IP di Arkimede, porta =
10300 → compaiono le entità STT, TTS (e, con la conversazione accesa
configurato, l'agente di conversazione); selezionale nella pipeline di Assist.
I satelliti (Voice PE, app Companion) usano così Arkimede end-to-end
attraverso l'hub.

## Parte 4 — Satelliti e conversazione di destinazione (2026-10-26)

Un client che mostra la conversazione (per esempio uno schermo a parete
accanto a un satellite vocale) può scegliere la chat in cui parla un satellite.
Generico: Arkimede non sa nulla del client, solo di satelliti e chat.

- **Quale satellite**: l'agente di conversazione Wyoming legge
  `context.satellite_id` (l'entità satellite dell'hub, per esempio
  `assist_satellite.soggiorno`; Home Assistant lo manda con `conversation_id`
  e `device_id`, e in mancanza vale `device_id`); la rotta compatibile OpenAI
  legge il campo standard `user` delle chat completions. Una nuova chat esterna
  lo conserva (`chats.externalSatellite`, migration 097), così una lista può
  mostrare da dove è nata.
- **Destinazione** (`chats/conversation-focus.service.ts`), per utente
  (l'utente con cui gira il punto d'ingresso):

  ```bash
  PUT    /api/external-chats/focus          # {satellite, chatId, ttlSeconds?} → {satellite, chatId, expiresAt}
  DELETE /api/external-chats/focus?satellite=…
  GET    /api/external-chats/focus          # le destinazioni del chiamante
  ```

  La chat deve essere del chiamante. Finché la destinazione c'è, i turni del
  satellite girano con gli ultimi 40 messaggi di quella chat come storia (la
  finestra tenuta da Wyoming e la storia rimandata da un client OpenAI si
  ignorano) e vi vengono aggiunti, con o senza persistenza delle conversazioni;
  una chat vuota (appena creata con `POST /api/chats`) prende il titolo dal
  primo turno.
- **Scadenza**: in memoria, 15 minuti di default (`ttlSeconds`, al massimo
  1 ora): il client la rinnova finché tiene la chat, così un client sparito o un
  riavvio del backend non lasciano mai un satellite a parlare in una chat
  vecchia.
- **Dopo una destinazione** (cancellata o scaduta) il turno successivo del
  satellite senza destinazione apre una conversazione nuova anche dentro la
  finestra di inattività: la finestra Wyoming si svuota e la persistenza apre
  una chat nuova.

## Parte 5 — Chi sta parlando: riconoscimento della voce (2026-11-09)

Opzionale (Impostazioni → Voce e audio → Voci riconosciute; `app_config.voiceIdEnabled`, migration 110). L'account
voce è uno a cui parlano molte persone: le persone di casa hanno **voci** (`voice_profiles`), non account — ognuna
facoltativamente collegata a una persona di Home Assistant e a un utente di Arkimede.

- **Impronta vocale**: whisper-service `POST /v1/speaker/embed` (sherpa-onnx, `SPEAKER_MODEL`, default CAM++
  `3dspeaker_speech_campplus_sv_en_voxceleb_16k`, ~30 MB, scaricato al primo uso nel volume dei modelli, caricato alla
  prima richiesta). Risponde `{embedding, model, seconds}`; `embedding` è null sotto `SPEAKER_MIN_SECONDS` (1 s).
- **A ogni turno** (`wyoming.service.ts`, `voice-id/`): su `audio-stop` l'impronta si calcola insieme alla trascrizione
  (nessuna attesa in più) e si tiene sotto il testo trascritto; quando l'hub passa quel testo alla conversazione, la
  voce viene imparata (una voce in registrazione su quel satellite: i suoi prossimi 5 turni, entro 10 minuti — una
  frase di meno di 3 parole, una che un'altra voce rivendicherebbe con la stessa sicurezza (o con forza, prima che la
  voce abbia un campione), o una diversa dai suoi campioni quando ne ha almeno 3 non viene imparata e non conta;
  l'agente chiede un'altra frase) o riconosciuta (coseno con il centroide di ogni voce: almeno 0,5 e 0,08 sopra la voce successiva; confidenza 0,8 da
  0,65, altrimenti 0,65 — mai 0,85, il livello di un messaggio privato).
- **Cosa cambia una voce riconosciuta**: l'agente sa chi sta parlando (un blocco del turno, fuori dal prefisso in
  cache); il messaggio dell'utente si salva prima dell'esecuzione con il suo `speaker` (la memoria legge chi parla
  quando le si chiede il contesto — come chiede Recordare), come persona di Home Assistant della voce se collegata,
  altrimenti `voice/<id>` con il suo nome; in una memoria personale la voce del titolare (collegata all'utente
  dell'account stesso) è il titolare. La presenza del turno porta quell'identità e confidenza invece della deduzione
  per esclusione. L'`askWho` di Recordare (nessuno identificato, qualcosa aspetta qualcuno) si chiede sul satellite
  della stanza, senza nomi, al massimo ogni 30 minuti per stanza.
- **Privacy**: nessun audio conservato; campioni (al massimo 20 per voce) cifrati; togliere una voce la dimentica.
  L'admin vede gli ultimi riconoscimenti con i punteggi, per tarare le soglie, e i campioni di ogni voce con quanto
  somigliano agli altri suoi e alla voce più vicina: uno sospetto (un'altra voce, rumore) si toglie da solo
  (`GET`/`DELETE /api/admin/voice-id/voices/:id/samples[/:index]`).

## Parte 6 — Azioni sensibili solo a voci riconosciute (2026-11-17)

Opzionale (Impostazioni → Voce e audio → Voci riconosciute → *Azioni sensibili solo a voci riconosciute*;
`app_config.voiceClearance`, migration 117; `PUT /api/admin/voice-id/clearance`). Un turno vocale gira con l'account
del satellite, chiunque parli: con questo acceso, una chiamata **protetta** in un turno vocale parte solo se la voce è
stata riconosciuta con un punteggio di somiglianza almeno `minScore` (default 0,65, lo stesso punteggio dell'elenco dei
riconoscimenti) e, se è impostato un elenco di voci, è una di quelle (nessuna = qualunque voce riconosciuta).
Altrimenti lo strumento non fa nulla e risponde `{error: "voice_not_authorized", reason}` (`not_recognised` /
`low_confidence` / `not_allowed`): l'agente dice che non può farlo per una voce che non riconosce.

- **Cosa è protetto**: qualunque strumento per nome (`tools`, con `*`, es. `skill_gmail_*`); le entità su cui agisce
  una chiamata (`entities`: un id, un dominio come `lock`, o con `*`); e, con `sensitiveTargets` (acceso di default),
  ciò che l'integrazione stessa considera sensibile — serrature, allarmi, porte del garage e cancelli di Home
  Assistant, la stessa regola della conferma. `ha_call_service` dichiara le entità su cui agisce, risolte anche da un
  nome o una stanza, quindi un'entità protetta viene presa comunque il modello la chiami; `confirmed: true` non basta.
- **Dove vale** (`voice-id/voice-clearance.ts`): il permesso del turno (chi ha parlato, punteggio, satellite) viaggia
  in un AsyncLocalStorage impostato intorno al turno Wyoming; gli strumenti sono avvolti dove nasce l'agente
  (`AgentService`, `MultiAgentService`), quindi sono controllati anche gli agenti a cui il turno delega, le sequenze
  che avvia (`run_sequence` chiama gli strumenti avvolti) e il lavoro che prosegue dopo che il satellite ha smesso di
  aspettare. Un'automazione creata a voce tiene il permesso (`scheduled_tasks.voiceClearance`) e gira con quello;
  cambiare cosa fa dall'app lo toglie. Un turno sull'endpoint OpenAI-compatibile che nomina un satellite (`user`)
  vale come voce non riconosciuta; senza satellite è un client API (il titolare della chiave) e non è controllato.
- **Spento, o fuori dai turni vocali**: nessuno strumento viene avvolto, ogni turno va come prima. Acceso con il
  riconoscimento spento, nessuna azione protetta si può fare a voce.
- **Limiti**: copre solo i comandi che passano da Arkimede — una pipeline di Home Assistant che gestisce i comandi in
  locale agisce senza chiedere ad Arkimede, quindi togli da Assist le entità sensibili o spegni quell'opzione.
  L'impronta vocale non è un'autenticazione forte (una registrazione può ingannarla): per serrature e allarmi un codice
  di conferma a voce è un passo ulteriore.
