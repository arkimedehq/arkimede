# Third-Party Notices

Questo prodotto (**Arkimede**) include software di terze parti.
Di seguito le attribuzioni e le note di licenza richieste.

> Generato il 2026-06-14. Copre le dipendenze di runtime/build dei componenti
> Node (`backend`, `frontend`, `bridge`, `executor`), i servizi Python
> (`embedding-service`, `whisper-service`) e i modelli ML scaricati a runtime.
> Per rigenerare l'elenco Node: `npx license-checker --production` in ciascun workspace.

## Riepilogo licenze

Tutte le dipendenze distribuite sono sotto licenze **permissive** (MIT, ISC, BSD-2/3-Clause,
Apache-2.0 e simili). **Nessun copyleft (GPL/AGPL/LGPL/MPL)** è incluso nella
distribuzione. Le componenti dual-license (es. `jszip`, `oracledb`) sono utilizzate
sotto l'opzione permissiva (rispettivamente MIT e Apache-2.0).

| Famiglia licenza | Obbligo principale |
|---|---|
| MIT, ISC, 0BSD, Unlicense, CC0 | Mantenere copyright e testo licenza |
| BSD-2-Clause / BSD-3-Clause | Mantenere copyright; BSD-3 vieta endorsement |
| Apache-2.0 | Mantenere copyright, NOTICE e changelog dei file modificati; grant brevettuale |

---

## Note di licenza specifiche

### Apache License 2.0 — componenti rilevanti

I seguenti pacchetti diretti sono sotto Apache-2.0. Apache-2.0 richiede di conservare
gli avvisi di copyright e gli eventuali file `NOTICE` originali in caso di
ridistribuzione, e concede un grant brevettuale esplicito:

- `openai` — https://github.com/openai/openai-node
- `mongodb` — https://github.com/mongodb/node-mongodb-native
- `@qdrant/js-client-rest` — https://github.com/qdrant/qdrant-js
- `puppeteer` — https://github.com/puppeteer/puppeteer
- `rxjs` — https://github.com/ReactiveX/rxjs
- `reflect-metadata` — https://github.com/rbuckton/reflect-metadata
- `xlsx` (SheetJS Community Edition) — https://github.com/SheetJS/sheetjs
- `ssh2-sftp-client` — https://github.com/theophilusx/ssh2-sftp-client
- `oracledb` — `Apache-2.0 OR UPL-1.0`, usato sotto Apache-2.0 — https://github.com/oracle/node-oracledb

Copia integrale della licenza: https://www.apache.org/licenses/LICENSE-2.0

### Dual-license — selezione effettuata

- `jszip` — `MIT OR GPL-3.0-or-later` → utilizzato sotto **MIT**.
- `oracledb` — `Apache-2.0 OR UPL-1.0` → utilizzato sotto **Apache-2.0**.

---

## Servizi Python

### embedding-service (`requirements.txt`)

| Pacchetto | Licenza |
|---|---|
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| sentence-transformers | Apache-2.0 |
| torch (PyTorch) | BSD-3-Clause |
| pydantic | MIT |

### whisper-service (`requirements.txt`)

| Pacchetto | Licenza |
|---|---|
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| faster-whisper | MIT |
| python-multipart | Apache-2.0 |

(CTranslate2, backend di `faster-whisper`, è distribuito sotto MIT.)

---

## Modelli di Machine Learning

I modelli sono **scaricati a runtime** dalle rispettive fonti e non sono ridistribuiti
con questo software. Gli unici modelli utilizzati sono:

| Modello | Uso | Licenza |
|---|---|---|
| `mixedbread-ai/mxbai-embed-large-v1` | Embedding testo (embedding-service) | **Apache-2.0** |
| OpenAI **Whisper** (via faster-whisper / CTranslate2) | Trascrizione audio (whisper-service) | **MIT** |

- mxbai-embed-large-v1: https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1 — Apache-2.0
- Whisper: https://github.com/openai/whisper — MIT (pesi e codice rilasciati da OpenAI sotto MIT)

Entrambe le licenze sono permissive e consentono uso commerciale.

---

## Elenco completo dei pacchetti Node (per licenza)

Pacchetti deduplicati per `nome@versione` sui workspace `backend`, `frontend`,
`bridge`, `executor`. I pacchetti `applescript` e `pause` riportano la licenza MIT
verificata dal file LICENSE / dalla prassi dell'autore (campo `license` assente nel
loro `package.json`).

### MIT (761)

- `@anthropic-ai/sdk@0.95.2` — github:anthropics/anthropic-sdk-typescript
- `@anthropic-ai/sdk@0.98.0` — github:anthropics/anthropic-sdk-typescript
- `@azure-rest/core-client@2.6.1` — https://github.com/Azure/azure-sdk-for-js
- `@azure/abort-controller@2.1.2` — github:Azure/azure-sdk-for-js
- `@azure/core-auth@1.10.1` — github:Azure/azure-sdk-for-js
- `@azure/core-client@1.10.2` — https://github.com/Azure/azure-sdk-for-js
- `@azure/core-lro@2.7.2` — github:Azure/azure-sdk-for-js
- `@azure/core-paging@1.6.2` — github:Azure/azure-sdk-for-js
- `@azure/core-rest-pipeline@1.24.0` — https://github.com/Azure/azure-sdk-for-js
- `@azure/core-tracing@1.3.1` — github:Azure/azure-sdk-for-js
- `@azure/core-util@1.13.1` — github:Azure/azure-sdk-for-js
- `@azure/identity@4.13.1` — github:Azure/azure-sdk-for-js
- `@azure/keyvault-common@2.1.0` — github:Azure/azure-sdk-for-js
- `@azure/keyvault-keys@4.10.2` — https://github.com/Azure/azure-sdk-for-js
- `@azure/logger@1.3.0` — github:Azure/azure-sdk-for-js
- `@azure/msal-browser@5.13.0` — https://github.com/AzureAD/microsoft-authentication-library-for-js
- `@azure/msal-common@16.8.0` — https://github.com/AzureAD/microsoft-authentication-library-for-js
- `@azure/msal-node@5.2.4` — https://github.com/AzureAD/microsoft-authentication-library-for-js
- `@babel/code-frame@7.29.0` — https://github.com/babel/babel
- `@babel/helper-validator-identifier@7.29.7` — https://github.com/babel/babel
- `@babel/runtime@7.29.2` — https://github.com/babel/babel
- `@babel/runtime@7.29.7` — https://github.com/babel/babel
- `@borewit/text-codec@0.2.2` — https://github.com/Borewit/text-codec
- `@buttercup/fetch@0.2.1` — https://github.com/buttercup/fetch
- `@cfworker/json-schema@4.1.1` — https://github.com/cfworker/cfworker
- `@cspotcode/source-map-support@0.8.1` — https://github.com/cspotcode/node-source-map-support
- `@fastify/ajv-compiler@3.6.0` — https://github.com/fastify/ajv-compiler
- `@fastify/error@3.4.1` — https://github.com/fastify/fastify-error
- `@fastify/fast-json-stringify-compiler@4.3.0` — https://github.com/fastify/fast-json-stringify-compiler
- `@fastify/merge-json-schemas@0.1.1` — https://github.com/fastify/merge-json-schemas
- `@ioredis/commands@1.10.0` — https://github.com/ioredis/commands
- `@ioredis/commands@1.5.1` — https://github.com/ioredis/commands
- `@jridgewell/resolve-uri@3.1.2` — https://github.com/jridgewell/resolve-uri
- `@jridgewell/sourcemap-codec@1.5.5` — https://github.com/jridgewell/sourcemaps
- `@jridgewell/trace-mapping@0.3.9` — https://github.com/jridgewell/trace-mapping
- `@langchain/anthropic@1.4.0` — git@github.com:langchain-ai/langchainjs
- `@langchain/classic@1.0.34` — ssh://git@github.com/langchain-ai/langchainjs
- `@langchain/community@1.1.28` — git@github.com:langchain-ai/langchainjs-community
- `@langchain/core@1.1.48` — git@github.com:langchain-ai/langchainjs
- `@langchain/google-genai@2.1.31` — git@github.com:langchain-ai/langchainjs
- `@langchain/langgraph-checkpoint@1.0.2` — ssh://git@github.com/langchain-ai/langgraphjs
- `@langchain/langgraph-sdk@1.9.6` — ssh://git@github.com/langchain-ai/langgraphjs
- `@langchain/langgraph@1.3.2` — ssh://git@github.com/langchain-ai/langgraphjs
- `@langchain/ollama@1.2.7` — git@github.com:langchain-ai/langchainjs
- `@langchain/openai@1.4.7` — git@github.com:langchain-ai/langchainjs
- `@langchain/protocol@0.0.15`
- `@langchain/textsplitters@1.0.1` — git@github.com:langchain-ai/langchainjs
- `@lukeed/csprng@1.1.0` — lukeed/csprng
- `@marsaud/smb2@0.18.0` — https://github.com/marsaud/node-smb2
- `@microsoft/tsdoc@0.15.1` — https://github.com/microsoft/tsdoc
- `@mongodb-js/saslprep@1.4.11` — https://github.com/mongodb-js/devtools-shared
- `@msgpackr-extract/msgpackr-extract-darwin-arm64@3.0.4` — http://github.com/kriszyp/msgpackr-extract
- `@nestjs/common@10.4.22` — https://github.com/nestjs/nest
- `@nestjs/config@3.3.0` — https://github.com/nestjs/config
- `@nestjs/core@10.4.22` — https://github.com/nestjs/nest
- `@nestjs/jwt@10.2.0` — https://github.com/nestjs/jwt
- `@nestjs/mapped-types@2.0.5` — https://github.com/nestjs/mapped-types
- `@nestjs/passport@10.0.3` — https://github.com/nestjs/passport
- `@nestjs/platform-express@10.4.22` — https://github.com/nestjs/nest
- `@nestjs/platform-socket.io@10.4.22` — https://github.com/nestjs/nest
- `@nestjs/serve-static@4.0.2` — https://github.com/nestjs/serve-static
- `@nestjs/swagger@7.4.2` — https://github.com/nestjs/swagger
- `@nestjs/typeorm@10.0.2` — https://github.com/nestjs/typeorm
- `@nestjs/websockets@10.4.22` — https://github.com/nestjs/nest
- `@nodable/entities@2.2.0` — https://github.com/nodable/val-parsers
- `@nuxtjs/opencollective@0.3.2` — nuxt-contrib/opencollective
- `@pinojs/redact@0.4.0` — https://github.com/pinojs/redact
- `@pkgjs/parseargs@0.11.0` — git@github.com:pkgjs/parseargs
- `@qdrant/openapi-typescript-fetch@1.2.6` — https://github.com/qdrant/openapi-typescript-fetch
- `@reactflow/background@11.3.14` — https://github.com/xyflow/xyflow
- `@reactflow/controls@11.2.14` — https://github.com/xyflow/xyflow
- `@reactflow/core@11.11.4` — https://github.com/xyflow/xyflow
- `@reactflow/minimap@11.7.14` — https://github.com/xyflow/xyflow
- `@reactflow/node-resizer@2.2.14` — https://github.com/xyflow/xyflow
- `@reactflow/node-toolbar@1.3.14` — https://github.com/xyflow/xyflow
- `@remix-run/router@1.23.2` — https://github.com/remix-run/react-router
- `@socket.io/component-emitter@3.1.2` — https://github.com/socketio/emitter
- `@sqltools/formatter@1.2.5` — https://github.com/mtxr/vscode-sqltools
- `@stablelib/base64@1.0.1` — https://github.com/StableLib/stablelib
- `@standard-schema/spec@1.1.0` — https://github.com/standard-schema/standard-schema
- `@tanstack/query-core@5.100.10` — https://github.com/TanStack/query
- `@tanstack/react-query@5.100.10` — https://github.com/TanStack/query
- `@tediousjs/connection-string@1.1.0` — https://github.com/tediousjs/connection-string
- `@tokenizer/inflate@0.2.7` — https://github.com/Borewit/tokenizer-inflate
- `@tokenizer/token@0.3.0` — https://github.com/Borewit/tokenizer-token
- `@tootallnate/quickjs-emscripten@0.23.0` — https://github.com/justjake/quickjs-emscripten
- `@tsconfig/node10@1.0.12` — https://github.com/tsconfig/bases
- `@tsconfig/node12@1.0.11` — https://github.com/tsconfig/bases
- `@tsconfig/node14@1.0.3` — https://github.com/tsconfig/bases
- `@tsconfig/node16@1.0.4` — https://github.com/tsconfig/bases
- `@types/cors@2.8.19` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-array@3.2.2` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-axis@3.0.6` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-brush@3.0.6` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-chord@3.0.6` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-color@3.1.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-contour@3.0.6` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-delaunay@6.0.4` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-dispatch@3.0.7` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-drag@3.0.7` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-dsv@3.0.7` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-ease@3.0.2` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-fetch@3.0.7` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-force@3.0.10` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-format@3.0.4` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-geo@3.1.0` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-hierarchy@3.1.7` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-interpolate@3.0.4` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-path@3.1.1` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-polygon@3.0.2` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-quadtree@3.0.6` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-random@3.0.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-scale-chromatic@3.1.0` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-scale@4.0.9` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-selection@3.0.11` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-shape@3.1.8` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-time-format@4.0.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-time@3.0.4` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-timer@3.0.2` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-transition@3.0.9` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3-zoom@3.0.8` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/d3@7.4.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/debug@4.1.13` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/estree-jsx@1.0.5` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/estree@1.0.9` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/geojson@7946.0.16` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/hast@3.0.4` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/json-schema@7.0.15` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/jsonwebtoken@9.0.5` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/mdast@4.0.4` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/ms@2.1.0` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/node@20.19.41` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/node@25.9.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/prop-types@15.7.15` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/react@18.3.28` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/readable-stream@4.0.23` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/unist@2.0.11` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/unist@3.0.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/validator@13.15.10` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/webidl-conversions@7.0.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/whatwg-url@13.0.0` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/ws@8.18.1` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/yauzl@2.10.3` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@typespec/ts-http-runtime@0.3.6` — https://github.com/Azure/azure-sdk-for-js
- `@xmldom/xmldom@0.8.13` — https://github.com/xmldom/xmldom
- `abort-controller@3.0.0` — https://github.com/mysticatea/abort-controller
- `abstract-logging@2.0.1` — https://github.com/jsumners/abstract-logging
- `accept-language-parser@1.5.0` — https://github.com/opentable/accept-language-parser
- `accepts@1.3.8` — jshttp/accepts
- `acorn-walk@8.3.5` — https://github.com/acornjs/acorn
- `acorn@8.16.0` — https://github.com/acornjs/acorn
- `adm-zip@0.5.17` — https://github.com/cthackers/adm-zip
- `agent-base@6.0.2` — https://github.com/TooTallNate/node-agent-base
- `agent-base@7.1.4` — https://github.com/TooTallNate/proxy-agents
- `ajv-formats@2.1.1` — https://github.com/ajv-validator/ajv-formats
- `ajv-formats@3.0.1` — https://github.com/ajv-validator/ajv-formats
- `ajv@8.20.0` — ajv-validator/ajv
- `ansi-regex@5.0.1` — chalk/ansi-regex
- `ansi-regex@6.2.2` — chalk/ansi-regex
- `ansi-styles@4.3.0` — chalk/ansi-styles
- `ansi-styles@6.2.3` — chalk/ansi-styles
- `anynum@1.0.0` — https://github.com/NaturalIntelligence/anynum
- `app-root-path@3.1.0` — https://github.com/inxilpro/node-app-root-path
- `append-field@1.0.0` — http://github.com/LinusU/node-append-field
- `applescript@1.0.0`
- `arg@4.1.3` — zeit/arg
- `argparse@1.0.10` — nodeca/argparse
- `array-flatten@1.1.1` — https://github.com/blakeembrey/array-flatten
- `asn1@0.2.6` — https://github.com/joyent/node-asn1
- `ast-types@0.13.4` — https://github.com/benjamn/ast-types
- `asynckit@0.4.0` — https://github.com/alexindigo/asynckit
- `atomic-sleep@1.0.0` — https://github.com/davidmarkclements/atomic-sleep
- `atomically@1.7.0` — https://github.com/fabiospampinato/atomically
- `attr-accept@2.2.5` — https://github.com/react-dropzone/attr-accept
- `auto-launch@5.0.6` — https://github.com/4ver/node-auto-launch
- `available-typed-arrays@1.0.7` — https://github.com/inspect-js/available-typed-arrays
- `avvio@8.4.0` — https://github.com/fastify/avvio
- `aws-ssl-profiles@1.1.2` — https://github.com/mysqljs/aws-ssl-profiles
- `axios@1.16.1` — https://github.com/axios/axios
- `bail@2.0.2` — wooorm/bail
- `balanced-match@1.0.2` — https://github.com/juliangruber/balanced-match
- `base-64@1.0.0` — https://github.com/mathiasbynens/base64
- `base64-js@1.5.1` — https://github.com/beatgammit/base64-js
- `base64id@2.0.0` — https://github.com/faeldt/base64id
- `basic-ftp@5.3.1` — https://github.com/patrickjuchli/basic-ftp
- `bcrypt@5.1.1` — https://github.com/kelektiv/node.bcrypt.js
- `better-sqlite3@12.10.1` — https://github.com/WiseLibs/better-sqlite3
- `binary-extensions@2.3.0` — sindresorhus/binary-extensions
- `bindings@1.5.0` — https://github.com/TooTallNate/node-bindings
- `bl@4.1.0` — https://github.com/rvagg/bl
- `bl@6.1.6` — https://github.com/rvagg/bl
- `bluebird@3.4.7` — https://github.com/petkaantonov/bluebird
- `body-parser@1.20.4` — expressjs/body-parser
- `brace-expansion@1.1.14` — https://github.com/juliangruber/brace-expansion
- `brace-expansion@2.1.0` — https://github.com/juliangruber/brace-expansion
- `brace-expansion@2.1.1` — https://github.com/juliangruber/brace-expansion
- `braces@3.0.3` — micromatch/braces
- `buffer-crc32@0.2.13` — https://github.com/brianloveswords/buffer-crc32
- `buffer-from@1.1.2` — LinusU/buffer-from
- `buffer@5.7.1` — https://github.com/feross/buffer
- `buffer@6.0.3` — https://github.com/feross/buffer
- `buildcheck@0.0.7` — http://github.com/mscdex/buildcheck
- `bullmq@5.78.0` — https://github.com/taskforcesh/bullmq
- `bundle-name@4.1.0` — sindresorhus/bundle-name
- `busboy@1.6.0` — http://github.com/mscdex/busboy
- `byte-length@1.0.2` — https://github.com/DylanPiercey/byte-length
- `bytes@3.1.2` — visionmedia/bytes.js
- `call-bind-apply-helpers@1.0.2` — https://github.com/ljharb/call-bind-apply-helpers
- `call-bind@1.0.9` — https://github.com/ljharb/call-bind
- `call-bound@1.0.4` — https://github.com/ljharb/call-bound
- `callsites@3.1.0` — sindresorhus/callsites
- `ccount@2.0.1` — wooorm/ccount
- `chalk@4.1.2` — chalk/chalk
- `character-entities-html4@2.1.0` — wooorm/character-entities-html4
- `character-entities-legacy@3.0.0` — wooorm/character-entities-legacy
- `character-entities@2.0.2` — wooorm/character-entities
- `character-reference-invalid@2.0.1` — wooorm/character-reference-invalid
- `chokidar@3.6.0` — https://github.com/paulmillr/chokidar
- `class-transformer@0.5.1` — https://github.com/typestack/class-transformer
- `class-validator@0.14.4` — https://github.com/typestack/class-validator
- `classcat@5.0.5` — jorgebucaran/classcat
- `clsx@2.1.1` — lukeed/clsx
- `color-convert@2.0.1` — Qix-/color-convert
- `color-name@1.1.4` — git@github.com:colorjs/color-name
- `colorette@2.0.20` — jorgebucaran/colorette
- `combined-stream@1.0.8` — https://github.com/felixge/node-combined-stream
- `comma-separated-tokens@2.0.3` — wooorm/comma-separated-tokens
- `commander@11.1.0` — https://github.com/tj/commander.js
- `concat-map@0.0.1` — https://github.com/substack/node-concat-map
- `concat-stream@1.6.2` — http://github.com/maxogden/concat-stream
- `concat-stream@2.0.0` — http://github.com/maxogden/concat-stream
- `conf@10.2.0` — sindresorhus/conf
- `consola@2.15.3` — nuxt/consola
- `content-disposition@0.5.4` — jshttp/content-disposition
- `content-type@1.0.5` — jshttp/content-type
- `cookie-signature@1.0.7` — https://github.com/visionmedia/node-cookie-signature
- `cookie@0.7.2` — jshttp/cookie
- `core-util-is@1.0.3` — https://github.com/isaacs/core-util-is
- `cors@2.8.5` — expressjs/cors
- `cosmiconfig@9.0.1` — https://github.com/cosmiconfig/cosmiconfig
- `cpu-features@0.0.10` — https://github.com/mscdex/cpu-features
- `create-require@1.1.1` — nuxt-contrib/create-require
- `cron-parser@4.9.0` — https://github.com/harrisiirak/cron-parser
- `cross-spawn@7.0.6` — git@github.com:moxystudio/node-cross-spawn
- `csstype@3.2.3` — https://github.com/frenic/csstype
- `data-uri-to-buffer@4.0.1` — https://github.com/TooTallNate/proxy-agents
- `data-uri-to-buffer@6.0.2` — https://github.com/TooTallNate/proxy-agents
- `date-fns@3.6.0` — https://github.com/date-fns/date-fns
- `dateformat@4.6.3` — https://github.com/felixge/node-dateformat
- `dayjs@1.11.20` — https://github.com/iamkun/dayjs
- `debounce-fn@4.0.0` — sindresorhus/debounce-fn
- `debug@2.6.9` — https://github.com/visionmedia/debug
- `debug@3.2.7` — https://github.com/visionmedia/debug
- `debug@4.3.7` — https://github.com/debug-js/debug
- `debug@4.4.3` — https://github.com/debug-js/debug
- `decode-named-character-reference@1.3.0` — wooorm/decode-named-character-reference
- `decompress-response@6.0.0` — sindresorhus/decompress-response
- `dedent@1.7.2` — https://github.com/dmnd/dedent
- `deep-extend@0.6.0` — https://github.com/unclechu/node-deep-extend
- `default-browser-id@5.0.1` — sindresorhus/default-browser-id
- `default-browser@5.5.0` — sindresorhus/default-browser
- `define-data-property@1.1.4` — https://github.com/ljharb/define-data-property
- `define-lazy-prop@3.0.0` — sindresorhus/define-lazy-prop
- `degenerator@5.0.1` — https://github.com/TooTallNate/proxy-agents
- `delayed-stream@1.0.0` — https://github.com/felixge/node-delayed-stream
- `delegates@1.0.0` — visionmedia/node-delegates
- `depd@2.0.0` — dougwilson/nodejs-depd
- `dequal@2.0.3` — lukeed/dequal
- `destroy@1.2.0` — stream-utils/destroy
- `devlop@1.1.0` — wooorm/devlop
- `docx@9.7.1` — https://github.com/dolanmiu/docx
- `dot-prop@6.0.1` — sindresorhus/dot-prop
- `dunder-proto@1.0.1` — https://github.com/es-shims/dunder-proto
- `eastasianwidth@0.2.0` — https://github.com/komagata/eastasianwidth
- `ee-first@1.1.1` — jonathanong/ee-first
- `electron-store@8.2.0` — sindresorhus/electron-store
- `emoji-regex@8.0.0` — https://github.com/mathiasbynens/emoji-regex
- `emoji-regex@9.2.2` — https://github.com/mathiasbynens/emoji-regex
- `encodeurl@2.0.0` — pillarjs/encodeurl
- `end-of-stream@1.4.5` — https://github.com/mafintosh/end-of-stream
- `engine.io-client@6.6.5` — https://github.com/socketio/socket.io
- `engine.io-parser@5.2.3` — https://github.com/socketio/socket.io
- `engine.io@6.6.8` — https://github.com/socketio/socket.io
- `env-paths@2.2.1` — sindresorhus/env-paths
- `err-code@2.0.3` — https://github.com/IndigoUnited/js-err-code
- `error-ex@1.3.4` — qix-/node-error-ex
- `es-define-property@1.0.1` — https://github.com/ljharb/es-define-property
- `es-errors@1.3.0` — https://github.com/ljharb/es-errors
- `es-object-atoms@1.1.1` — https://github.com/ljharb/es-object-atoms
- `es-set-tostringtag@2.1.0` — https://github.com/es-shims/es-set-tostringtag
- `escalade@3.2.0` — lukeed/escalade
- `escape-html@1.0.3` — component/escape-html
- `escape-string-regexp@5.0.0` — sindresorhus/escape-string-regexp
- `estree-util-is-identifier-name@3.0.0` — syntax-tree/estree-util-is-identifier-name
- `etag@1.8.1` — jshttp/etag
- `event-target-shim@5.0.1` — https://github.com/mysticatea/event-target-shim
- `eventemitter3@4.0.7` — https://github.com/primus/eventemitter3
- `eventemitter3@5.0.4` — https://github.com/primus/eventemitter3
- `events@3.3.0` — https://github.com/Gozala/events
- `express@4.22.1` — expressjs/express
- `extend@3.0.2` — https://github.com/justmoon/node-extend
- `fast-content-type-parse@1.1.0` — https://github.com/fastify/fast-content-type-parse
- `fast-copy@4.0.3` — https://github.com/planttheidea/fast-copy
- `fast-decode-uri-component@1.0.1` — https://github.com/delvedor/fast-decode-uri-component
- `fast-deep-equal@3.1.3` — https://github.com/epoberezkin/fast-deep-equal
- `fast-fifo@1.3.2` — https://github.com/mafintosh/fast-fifo
- `fast-json-stringify@5.16.1` — https://github.com/fastify/fast-json-stringify
- `fast-querystring@1.1.2` — https://github.com/anonrig/fast-querystring
- `fast-safe-stringify@2.1.1` — https://github.com/davidmarkclements/fast-safe-stringify
- `fast-uri@2.4.0` — https://github.com/fastify/fast-uri
- `fast-xml-builder@1.2.0` — https://github.com/NaturalIntelligence/fast-xml-builder
- `fast-xml-parser@5.9.0` — https://github.com/NaturalIntelligence/fast-xml-parser
- `fastify@4.29.1` — https://github.com/fastify/fastify
- `fd-slicer@1.1.0` — https://github.com/andrewrk/node-fd-slicer
- `fetch-blob@3.2.0` — https://github.com/node-fetch/fetch-blob
- `fflate@0.8.2` — https://github.com/101arrowz/fflate
- `file-selector@2.1.2` — https://github.com/react-dropzone/file-selector
- `file-type@20.4.1` — sindresorhus/file-type
- `file-uri-to-path@1.0.0` — https://github.com/TooTallNate/file-uri-to-path
- `fill-range@7.1.1` — jonschlinkert/fill-range
- `finalhandler@1.3.2` — pillarjs/finalhandler
- `find-my-way@8.2.2` — https://github.com/delvedor/find-my-way
- `find-up@3.0.0` — sindresorhus/find-up
- `follow-redirects@1.16.0` — ssh://git@github.com/follow-redirects/follow-redirects
- `for-each@0.3.5` — https://github.com/Raynos/for-each
- `form-data@4.0.5` — https://github.com/form-data/form-data
- `formdata-polyfill@4.0.10` — https://jimmywarting@github.com/jimmywarting/FormData
- `forwarded@0.2.0` — jshttp/forwarded
- `fresh@0.5.2` — jshttp/fresh
- `fs-constants@1.0.0` — https://github.com/mafintosh/fs-constants
- `fsevents@2.3.3` — https://github.com/fsevents/fsevents
- `function-bind@1.1.2` — https://github.com/Raynos/function-bind
- `generate-function@2.3.1` — https://github.com/mafintosh/generate-function
- `get-intrinsic@1.3.0` — https://github.com/ljharb/get-intrinsic
- `get-proto@1.0.1` — https://github.com/ljharb/get-proto
- `get-stream@5.2.0` — sindresorhus/get-stream
- `get-uri@6.0.5` — https://github.com/TooTallNate/proxy-agents
- `github-from-package@0.0.0` — https://github.com/substack/github-from-package
- `gopd@1.2.0` — https://github.com/ljharb/gopd
- `handlebars@4.7.9` — https://github.com/handlebars-lang/handlebars.js
- `has-flag@4.0.0` — sindresorhus/has-flag
- `has-property-descriptors@1.0.2` — https://github.com/inspect-js/has-property-descriptors
- `has-symbols@1.1.0` — https://github.com/inspect-js/has-symbols
- `has-tostringtag@1.0.2` — https://github.com/inspect-js/has-tostringtag
- `hash.js@1.1.7` — git@github.com:indutny/hash.js
- `hasown@2.0.3` — https://github.com/inspect-js/hasOwn
- `hast-util-is-element@3.0.0` — syntax-tree/hast-util-is-element
- `hast-util-to-jsx-runtime@2.3.6` — syntax-tree/hast-util-to-jsx-runtime
- `hast-util-to-text@4.0.2` — syntax-tree/hast-util-to-text
- `hast-util-whitespace@3.0.0` — syntax-tree/hast-util-whitespace
- `help-me@5.0.0` — https://github.com/mcollina/help-me
- `hot-patcher@2.0.1` — https://github.com/perry-mitchell/hot-patcher
- `html-parse-stringify@3.0.1` — https://github.com/henrikjoreteg/html-parse-stringify
- `html-url-attributes@3.0.1` — https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes
- `http-errors@2.0.1` — jshttp/http-errors
- `http-proxy-agent@7.0.2` — https://github.com/TooTallNate/proxy-agents
- `https-proxy-agent@5.0.1` — https://github.com/TooTallNate/node-https-proxy-agent
- `https-proxy-agent@7.0.6` — https://github.com/TooTallNate/proxy-agents
- `i18next-browser-languagedetector@8.2.1` — https://github.com/i18next/i18next-browser-languageDetector
- `i18next@26.3.1` — https://github.com/i18next/i18next
- `iconv-lite@0.4.24` — https://github.com/ashtuchkin/iconv-lite
- `iconv-lite@0.7.2` — https://github.com/pillarjs/iconv-lite
- `immediate@3.0.6` — https://github.com/calvinmetcalf/immediate
- `import-fresh@3.3.1` — sindresorhus/import-fresh
- `inline-style-parser@0.2.7` — https://github.com/remarkablemark/inline-style-parser
- `ioredis@5.10.1` — https://github.com/luin/ioredis
- `ioredis@5.11.1` — https://github.com/luin/ioredis
- `ip-address@10.2.0` — https://github.com/beaugunderson/ip-address
- `ipaddr.js@1.9.1` — https://github.com/whitequark/ipaddr.js
- `is-alphabetical@2.0.1` — wooorm/is-alphabetical
- `is-alphanumerical@2.0.1` — wooorm/is-alphanumerical
- `is-arrayish@0.2.1` — https://github.com/qix-/node-is-arrayish
- `is-binary-path@2.1.0` — sindresorhus/is-binary-path
- `is-buffer@1.1.6` — git://github.com/feross/is-buffer
- `is-callable@1.2.7` — https://github.com/inspect-js/is-callable
- `is-decimal@2.0.1` — wooorm/is-decimal
- `is-docker@3.0.0` — sindresorhus/is-docker
- `is-extglob@2.1.1` — jonschlinkert/is-extglob
- `is-fullwidth-code-point@3.0.0` — sindresorhus/is-fullwidth-code-point
- `is-glob@4.0.3` — micromatch/is-glob
- `is-hexadecimal@2.0.1` — wooorm/is-hexadecimal
- `is-inside-container@1.0.0` — sindresorhus/is-inside-container
- `is-network-error@1.3.2` — sindresorhus/is-network-error
- `is-number@7.0.0` — jonschlinkert/is-number
- `is-obj@2.0.0` — sindresorhus/is-obj
- `is-plain-obj@4.1.0` — sindresorhus/is-plain-obj
- `is-property@1.0.2` — https://github.com/mikolalysenko/is-property
- `is-typed-array@1.1.15` — https://github.com/inspect-js/is-typed-array
- `is-unsafe@1.0.1` — https://github.com/NaturalIntelligence/is-unsafe
- `is-wsl@3.1.1` — sindresorhus/is-wsl
- `isarray@1.0.0` — https://github.com/juliangruber/isarray
- `isarray@2.0.5` — https://github.com/juliangruber/isarray
- `joycon@3.1.1` — egoist/joycon
- `js-md4@0.3.2` — https://github.com/emn178/js-md4
- `js-tiktoken@1.0.21` — https://github.com/dqbd/tiktoken
- `js-tokens@4.0.0` — lydell/js-tokens
- `js-yaml@4.1.0` — nodeca/js-yaml
- `js-yaml@4.1.1` — nodeca/js-yaml
- `json-parse-even-better-errors@2.3.1` — https://github.com/npm/json-parse-even-better-errors
- `json-schema-ref-resolver@1.0.1` — https://github.com/fastify/json-schema-ref-resolver
- `json-schema-to-ts@3.1.1` — https://github.com/ThomasAribart/json-schema-to-ts
- `json-schema-traverse@1.0.0` — https://github.com/epoberezkin/json-schema-traverse
- `jsonpointer@5.0.1` — https://github.com/janl/node-jsonpointer
- `jsonwebtoken@9.0.2` — https://github.com/auth0/node-jsonwebtoken
- `jwa@1.4.2` — https://github.com/brianloveswords/node-jwa
- `jws@3.2.3` — https://github.com/brianloveswords/node-jws
- `langchain@1.4.2` — ssh://git@github.com/langchain-ai/langchainjs
- `langsmith@0.7.2` — https://github.com/langchain-ai/langsmith-sdk
- `layerr@3.0.0` — https://github.com/perry-mitchell/layerr
- `libphonenumber-js@1.13.2` — https://gitlab.com/catamphetamine/libphonenumber-js
- `lie@3.3.0` — https://github.com/calvinmetcalf/lie
- `lines-and-columns@1.2.4` — https://github.com/eventualbuddha/lines-and-columns
- `locate-path@3.0.0` — sindresorhus/locate-path
- `lodash.defaults@4.2.0` — lodash/lodash
- `lodash.includes@4.3.0` — lodash/lodash
- `lodash.isarguments@3.1.0` — lodash/lodash
- `lodash.isboolean@3.0.3` — lodash/lodash
- `lodash.isinteger@4.0.4` — lodash/lodash
- `lodash.isnumber@3.0.3` — lodash/lodash
- `lodash.isplainobject@4.0.6` — lodash/lodash
- `lodash.isstring@4.0.1` — lodash/lodash
- `lodash.once@4.1.1` — lodash/lodash
- `lodash@4.17.21` — lodash/lodash
- `longest-streak@3.1.0` — wooorm/longest-streak
- `loose-envify@1.4.0` — https://github.com/zertosh/loose-envify
- `lowlight@3.3.0` — wooorm/lowlight
- `lru.min@1.1.4` — https://github.com/wellwelwel/lru.min
- `luxon@3.5.0` — https://github.com/moment/luxon
- `make-dir@3.1.0` — sindresorhus/make-dir
- `markdown-table@3.0.4` — wooorm/markdown-table
- `math-expression-evaluator@2.0.7` — https://github.com/redhivesoftware/math-expression-evaluator
- `math-intrinsics@1.1.0` — https://github.com/es-shims/math-intrinsics
- `mdast-util-find-and-replace@3.0.2` — syntax-tree/mdast-util-find-and-replace
- `mdast-util-from-markdown@2.0.3` — syntax-tree/mdast-util-from-markdown
- `mdast-util-gfm-autolink-literal@2.0.1` — syntax-tree/mdast-util-gfm-autolink-literal
- `mdast-util-gfm-footnote@2.1.0` — syntax-tree/mdast-util-gfm-footnote
- `mdast-util-gfm-strikethrough@2.0.0` — syntax-tree/mdast-util-gfm-strikethrough
- `mdast-util-gfm-table@2.0.0` — syntax-tree/mdast-util-gfm-table
- `mdast-util-gfm-task-list-item@2.0.0` — syntax-tree/mdast-util-gfm-task-list-item
- `mdast-util-gfm@3.1.0` — syntax-tree/mdast-util-gfm
- `mdast-util-mdx-expression@2.0.1` — syntax-tree/mdast-util-mdx-expression
- `mdast-util-mdx-jsx@3.2.0` — syntax-tree/mdast-util-mdx-jsx
- `mdast-util-mdxjs-esm@2.0.1` — syntax-tree/mdast-util-mdxjs-esm
- `mdast-util-phrasing@4.1.0` — syntax-tree/mdast-util-phrasing
- `mdast-util-to-hast@13.2.1` — syntax-tree/mdast-util-to-hast
- `mdast-util-to-markdown@2.1.2` — syntax-tree/mdast-util-to-markdown
- `mdast-util-to-string@4.0.0` — syntax-tree/mdast-util-to-string
- `media-typer@0.3.0` — jshttp/media-typer
- `memory-pager@1.5.0` — https://github.com/mafintosh/memory-pager
- `merge-descriptors@1.0.3` — sindresorhus/merge-descriptors
- `methods@1.1.2` — jshttp/methods
- `micromark-core-commonmark@2.0.3` — https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark
- `micromark-extension-gfm-autolink-literal@2.1.0` — micromark/micromark-extension-gfm-autolink-literal
- `micromark-extension-gfm-footnote@2.1.0` — micromark/micromark-extension-gfm-footnote
- `micromark-extension-gfm-strikethrough@2.1.0` — micromark/micromark-extension-gfm-strikethrough
- `micromark-extension-gfm-table@2.1.1` — micromark/micromark-extension-gfm-table
- `micromark-extension-gfm-tagfilter@2.0.0` — micromark/micromark-extension-gfm-tagfilter
- `micromark-extension-gfm-task-list-item@2.1.0` — micromark/micromark-extension-gfm-task-list-item
- `micromark-extension-gfm@3.0.0` — micromark/micromark-extension-gfm
- `micromark-factory-destination@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination
- `micromark-factory-label@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label
- `micromark-factory-space@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space
- `micromark-factory-title@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title
- `micromark-factory-whitespace@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace
- `micromark-util-character@2.1.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-character
- `micromark-util-chunked@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked
- `micromark-util-classify-character@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character
- `micromark-util-combine-extensions@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions
- `micromark-util-decode-numeric-character-reference@2.0.2` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference
- `micromark-util-decode-string@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string
- `micromark-util-encode@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode
- `micromark-util-html-tag-name@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name
- `micromark-util-normalize-identifier@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier
- `micromark-util-resolve-all@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all
- `micromark-util-sanitize-uri@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri
- `micromark-util-subtokenize@2.1.0` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize
- `micromark-util-symbol@2.0.1` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol
- `micromark-util-types@2.0.2` — https://github.com/micromark/micromark/tree/main/packages/micromark-util-types
- `micromark@4.0.2` — https://github.com/micromark/micromark/tree/main/packages/micromark
- `mime-db@1.52.0` — jshttp/mime-db
- `mime-types@2.1.35` — jshttp/mime-types
- `mime@1.6.0` — https://github.com/broofa/node-mime
- `mimic-fn@2.1.0` — sindresorhus/mimic-fn
- `mimic-fn@3.1.0` — sindresorhus/mimic-fn
- `mimic-response@3.1.0` — sindresorhus/mimic-response
- `minimist@1.2.8` — https://github.com/minimistjs/minimist
- `minizlib@2.1.2` — https://github.com/isaacs/minizlib
- `mitt@3.0.1` — developit/mitt
- `mkdirp-classic@0.5.3` — https://github.com/mafintosh/mkdirp-classic
- `mkdirp@0.5.6` — https://github.com/substack/node-mkdirp
- `mkdirp@1.0.4` — https://github.com/isaacs/node-mkdirp
- `ms@2.0.0` — zeit/ms
- `ms@2.1.3` — vercel/ms
- `msgpackr-extract@3.0.4` — http://github.com/kriszyp/msgpackr-extract
- `msgpackr@2.0.2` — http://github.com/kriszyp/msgpackr
- `mssql@12.5.5` — https://github.com/tediousjs/node-mssql
- `multer@1.4.5-lts.2` — expressjs/multer
- `multer@2.0.2` — expressjs/multer
- `mustache@4.2.0` — https://github.com/janl/mustache.js
- `mysql2@3.22.3` — https://github.com/sidorares/node-mysql2
- `named-placeholders@1.1.6` — https://github.com/mysqljs/named-placeholders
- `nan@2.27.0` — https://github.com/nodejs/nan
- `nanoid@5.1.11` — ai/nanoid
- `napi-build-utils@2.0.0` — https://github.com/inspiredware/napi-build-utils
- `native-duplexpair@1.0.0` — https://github.com/tediousjs/native-duplexpair
- `negotiator@0.6.3` — jshttp/negotiator
- `neo-async@2.6.2` — git@github.com:suguru03/neo-async
- `nested-property@4.0.0` — git@github.com:cosmosio/nested-property
- `nestjs-i18n@10.6.1` — https://github.com/ToonvanStrijp/nestjs-i18n
- `netmask@2.1.1` — https://github.com/rs/node-netmask
- `node-abi@3.92.0` — https://github.com/electron/node-abi
- `node-abort-controller@3.1.1` — https://github.com/southpolesteve/node-abort-controller
- `node-addon-api@5.1.0` — https://github.com/nodejs/node-addon-api
- `node-domexception@1.0.0` — https://github.com/jimmywarting/node-domexception
- `node-ensure@0.0.0` — https://github.com/bauerca/node-ensure
- `node-fetch@2.7.0` — https://github.com/bitinn/node-fetch
- `node-fetch@3.3.2` — https://github.com/bitinn/node-fetch
- `node-gyp-build-optional-packages@5.2.2` — https://github.com/prebuild/node-gyp-build
- `normalize-path@3.0.0` — jonschlinkert/normalize-path
- `object-assign@4.1.1` — sindresorhus/object-assign
- `object-hash@3.0.0` — https://github.com/puleos/object-hash
- `object-inspect@1.13.4` — https://github.com/inspect-js/object-inspect
- `ollama@0.6.3` — https://github.com/ollama/ollama-js
- `on-exit-leak-free@2.1.2` — https://github.com/mcollina/on-exit-or-gc
- `on-finished@2.4.1` — jshttp/on-finished
- `onetime@5.1.2` — sindresorhus/onetime
- `open@10.2.0` — sindresorhus/open
- `openapi-types@12.1.3` — https://github.com/kogosoftwarellc/open-api/tree/master/packages/openapi-types
- `p-finally@1.0.0` — sindresorhus/p-finally
- `p-limit@2.3.0` — sindresorhus/p-limit
- `p-locate@3.0.0` — sindresorhus/p-locate
- `p-queue@6.6.2` — sindresorhus/p-queue
- `p-queue@9.3.0` — sindresorhus/p-queue
- `p-retry@7.1.1` — sindresorhus/p-retry
- `p-timeout@3.2.0` — sindresorhus/p-timeout
- `p-timeout@7.0.1` — sindresorhus/p-timeout
- `p-try@2.2.0` — sindresorhus/p-try
- `pac-proxy-agent@7.2.0` — https://github.com/TooTallNate/proxy-agents
- `pac-resolver@7.0.1` — https://github.com/TooTallNate/proxy-agents
- `parent-module@1.0.1` — sindresorhus/parent-module
- `parse-entities@4.0.2` — wooorm/parse-entities
- `parse-json@5.2.0` — sindresorhus/parse-json
- `parseurl@1.3.3` — pillarjs/parseurl
- `passport-jwt@4.0.1` — https://github.com/mikenicholson/passport-jwt
- `passport-local@1.0.0` — https://github.com/jaredhanson/passport-local
- `passport-strategy@1.0.0` — https://github.com/jaredhanson/passport-strategy
- `passport@0.7.0` — https://github.com/jaredhanson/passport
- `path-exists@3.0.0` — sindresorhus/path-exists
- `path-expression-matcher@1.5.0` — https://github.com/NaturalIntelligence/path-expression-matcher
- `path-is-absolute@1.0.1` — sindresorhus/path-is-absolute
- `path-key@3.1.1` — sindresorhus/path-key
- `path-to-regexp@0.1.13` — https://github.com/pillarjs/path-to-regexp
- `path-to-regexp@0.2.5` — https://github.com/component/path-to-regexp
- `path-to-regexp@3.3.0` — https://github.com/pillarjs/path-to-regexp
- `pause@0.0.1`
- `pdf-parse@1.1.1` — https://gitlab.com/autokent/pdf-parse
- `pend@1.2.0` — https://github.com/andrewrk/node-pend
- `pg-cloudflare@1.3.0` — https://github.com/brianc/node-postgres
- `pg-connection-string@2.12.0` — https://github.com/brianc/node-postgres
- `pg-pool@3.13.0` — https://github.com/brianc/node-postgres
- `pg-protocol@1.13.0` — https://github.com/brianc/node-postgres
- `pg-types@2.2.0` — https://github.com/brianc/node-pg-types
- `pg@8.20.0` — https://github.com/brianc/node-postgres
- `pgpass@1.0.5` — https://github.com/hoegaarden/pgpass
- `picomatch@2.3.2` — micromatch/picomatch
- `pino-abstract-transport@2.0.0` — https://github.com/pinojs/pino-abstract-transport
- `pino-abstract-transport@3.0.0` — https://github.com/pinojs/pino-abstract-transport
- `pino-pretty@13.1.3` — ssh://git@github.com/pinojs/pino-pretty
- `pino-std-serializers@7.1.0` — ssh://git@github.com/pinojs/pino-std-serializers
- `pino@9.14.0` — https://github.com/pinojs/pino
- `pkg-up@3.1.0` — sindresorhus/pkg-up
- `possible-typed-array-names@1.1.0` — https://github.com/ljharb/possible-typed-array-names
- `postgres-array@2.0.0` — bendrucker/postgres-array
- `postgres-bytea@1.0.1` — bendrucker/postgres-bytea
- `postgres-date@1.0.7` — bendrucker/postgres-date
- `postgres-interval@1.2.0` — bendrucker/postgres-interval
- `prebuild-install@7.1.3` — https://github.com/prebuild/prebuild-install
- `process-nextick-args@2.0.1` — https://github.com/calvinmetcalf/process-nextick-args
- `process-warning@3.0.0` — https://github.com/fastify/process-warning
- `process-warning@5.0.0` — https://github.com/fastify/process-warning
- `process@0.11.10` — https://github.com/shtylman/node-process
- `progress@2.0.3` — https://github.com/visionmedia/node-progress
- `promise-retry@2.0.1` — https://github.com/IndigoUnited/node-promise-retry
- `prop-types@15.8.1` — facebook/prop-types
- `property-information@7.1.0` — wooorm/property-information
- `proxy-addr@2.0.7` — jshttp/proxy-addr
- `proxy-agent@6.5.0` — https://github.com/TooTallNate/proxy-agents
- `proxy-from-env@1.1.0` — https://github.com/Rob--W/proxy-from-env
- `proxy-from-env@2.1.0` — https://github.com/Rob--W/proxy-from-env
- `pump@3.0.4` — https://github.com/mafintosh/pump
- `punycode@2.3.1` — https://github.com/mathiasbynens/punycode.js
- `querystringify@2.2.0` — https://github.com/unshiftio/querystringify
- `quick-format-unescaped@4.0.4` — https://github.com/davidmarkclements/quick-format
- `range-parser@1.2.1` — jshttp/range-parser
- `raw-body@2.5.3` — stream-utils/raw-body
- `react-dom@18.3.1` — https://github.com/facebook/react
- `react-dropzone@14.4.1` — https://github.com/react-dropzone/react-dropzone
- `react-i18next@17.0.8` — https://github.com/i18next/react-i18next
- `react-is@16.13.1` — https://github.com/facebook/react
- `react-markdown@9.1.0` — remarkjs/react-markdown
- `react-router-dom@6.30.3` — https://github.com/remix-run/react-router
- `react-router@6.30.3` — https://github.com/remix-run/react-router
- `react@18.3.1` — https://github.com/facebook/react
- `reactflow@11.11.4` — https://github.com/xyflow/xyflow
- `readable-stream@2.3.8` — https://github.com/nodejs/readable-stream
- `readable-stream@3.6.2` — https://github.com/nodejs/readable-stream
- `readable-stream@4.7.0` — https://github.com/nodejs/readable-stream
- `readdirp@3.6.0` — https://github.com/paulmillr/readdirp
- `real-require@0.2.0` — https://github.com/pinojs/real-require
- `redis-errors@1.2.0` — https://github.com/NodeRedis/redis-errors
- `redis-parser@3.0.0` — https://github.com/NodeRedis/node-redis-parser
- `rehype-highlight@7.0.2` — rehypejs/rehype-highlight
- `remark-gfm@4.0.1` — remarkjs/remark-gfm
- `remark-parse@11.0.0` — https://github.com/remarkjs/remark/tree/main/packages/remark-parse
- `remark-rehype@11.1.2` — remarkjs/remark-rehype
- `remark-stringify@11.0.0` — https://github.com/remarkjs/remark/tree/main/packages/remark-stringify
- `require-directory@2.1.1` — https://github.com/troygoode/node-require-directory
- `require-from-string@2.0.2` — floatdrop/require-from-string
- `requires-port@1.0.0` — https://github.com/unshiftio/requires-port
- `resolve-from@4.0.0` — sindresorhus/resolve-from
- `ret@0.4.3` — https://github.com/fent/ret.js
- `retry@0.12.0` — https://github.com/tim-kos/node-retry
- `reusify@1.1.0` — https://github.com/mcollina/reusify
- `rfdc@1.4.1` — https://github.com/davidmarkclements/rfdc
- `run-applescript@7.1.0` — sindresorhus/run-applescript
- `safe-buffer@5.1.2` — https://github.com/feross/safe-buffer
- `safe-buffer@5.2.1` — https://github.com/feross/safe-buffer
- `safe-regex2@3.1.0` — https://github.com/fastify/safe-regex
- `safe-stable-stringify@2.5.0` — https://github.com/BridgeAR/safe-stable-stringify
- `safer-buffer@2.1.2` — https://github.com/ChALkeR/safer-buffer
- `scheduler@0.23.2` — https://github.com/facebook/react
- `send@0.19.2` — pillarjs/send
- `serve-static@1.16.3` — expressjs/serve-static
- `set-cookie-parser@2.7.2` — nfriedly/set-cookie-parser
- `set-function-length@1.2.2` — https://github.com/ljharb/set-function-length
- `setimmediate@1.0.5` — YuzuJS/setImmediate
- `shebang-command@2.0.0` — kevva/shebang-command
- `shebang-regex@3.0.0` — sindresorhus/shebang-regex
- `side-channel-list@1.0.1` — https://github.com/ljharb/side-channel-list
- `side-channel-map@1.0.1` — https://github.com/ljharb/side-channel-map
- `side-channel-weakmap@1.0.2` — https://github.com/ljharb/side-channel-weakmap
- `side-channel@1.1.0` — https://github.com/ljharb/side-channel
- `simple-concat@1.0.1` — https://github.com/feross/simple-concat
- `simple-get@4.0.1` — https://github.com/feross/simple-get
- `smart-buffer@4.2.0` — https://github.com/JoshGlazebrook/smart-buffer
- `socket.io-adapter@2.5.7` — https://github.com/socketio/socket.io
- `socket.io-client@4.8.3` — https://github.com/socketio/socket.io
- `socket.io-parser@4.2.6` — https://github.com/socketio/socket.io
- `socket.io@4.8.1` — https://github.com/socketio/socket.io
- `socket.io@4.8.3` — https://github.com/socketio/socket.io
- `socks-proxy-agent@8.0.5` — https://github.com/TooTallNate/proxy-agents
- `socks@2.8.9` — https://github.com/JoshGlazebrook/socks
- `sonic-boom@4.2.1` — https://github.com/pinojs/sonic-boom
- `space-separated-tokens@2.0.2` — wooorm/space-separated-tokens
- `sparse-bitfield@3.0.3` — https://github.com/mafintosh/sparse-bitfield
- `sql-escaper@1.3.3` — https://github.com/mysqljs/sql-escaper
- `sql-highlight@6.1.0` — git@github.com:scriptcoded/sql-highlight
- `ssh2@1.17.0` — http://github.com/mscdex/ssh2
- `standard-as-callback@2.1.0` — https://github.com/luin/asCallback
- `standardwebhooks@1.0.0` — https://github.com/standard-webhooks/standard-webhooks
- `statuses@2.0.2` — jshttp/statuses
- `streamsearch@1.1.0` — http://github.com/mscdex/streamsearch
- `streamx@2.25.0` — https://github.com/mafintosh/streamx
- `string-width@4.2.3` — sindresorhus/string-width
- `string-width@5.1.2` — sindresorhus/string-width
- `string_decoder@1.1.1` — https://github.com/nodejs/string_decoder
- `string_decoder@1.3.0` — https://github.com/nodejs/string_decoder
- `stringify-entities@4.0.4` — wooorm/stringify-entities
- `strip-ansi@6.0.1` — chalk/strip-ansi
- `strip-ansi@7.2.0` — chalk/strip-ansi
- `strip-json-comments@2.0.1` — sindresorhus/strip-json-comments
- `strip-json-comments@5.0.3` — sindresorhus/strip-json-comments
- `strnum@2.4.0` — https://github.com/NaturalIntelligence/strnum
- `strtok3@10.3.5` — https://github.com/Borewit/strtok3
- `style-to-js@1.1.21` — https://github.com/remarkablemark/style-to-js
- `style-to-object@1.0.14` — https://github.com/remarkablemark/style-to-object
- `supports-color@7.2.0` — chalk/supports-color
- `swagger-ui-express@5.0.1` — git@github.com:scottie1984/swagger-ui-express
- `tailwind-merge@2.6.1` — https://github.com/dcastil/tailwind-merge
- `tar-fs@2.1.4` — https://github.com/mafintosh/tar-fs
- `tar-fs@3.1.2` — https://github.com/mafintosh/tar-fs
- `tar-stream@2.2.0` — https://github.com/mafintosh/tar-stream
- `tar-stream@3.2.0` — https://github.com/mafintosh/tar-stream
- `tarn@3.0.2` — https://github.com/vincit/tarn.js
- `tedious@19.2.1` — https://github.com/tediousjs/tedious
- `teex@1.0.1` — https://github.com/mafintosh/teex
- `thread-stream@3.1.0` — https://github.com/mcollina/thread-stream
- `through@2.3.8` — https://github.com/dominictarr/through
- `to-buffer@1.2.2` — https://github.com/browserify/to-buffer
- `to-regex-range@5.0.1` — micromatch/to-regex-range
- `toad-cache@3.7.1` — https://github.com/kibertoad/toad-cache
- `toidentifier@1.0.1` — component/toidentifier
- `token-types@6.1.2` — https://github.com/Borewit/token-types
- `tr46@0.0.3` — https://github.com/Sebmaster/tr46.js
- `tr46@5.1.1` — https://github.com/jsdom/tr46
- `trim-lines@3.0.1` — wooorm/trim-lines
- `trough@2.2.0` — wooorm/trough
- `ts-algebra@2.0.0` — https://github.com/ThomasAribart/ts-algebra
- `ts-node@10.9.2` — https://github.com/TypeStrong/ts-node
- `type-is@1.6.18` — jshttp/type-is
- `typed-array-buffer@1.0.3` — https://github.com/inspect-js/typed-array-buffer
- `typedarray@0.0.6` — https://github.com/substack/typedarray
- `typeorm@0.3.29` — https://github.com/typeorm/typeorm
- `uid@2.0.2` — lukeed/uid
- `uint8array-extras@1.5.0` — sindresorhus/uint8array-extras
- `unbzip2-stream@1.4.3` — https://github.com/regular/unbzip2-stream
- `underscore@1.13.8` — https://github.com/jashkenas/underscore
- `undici-types@6.21.0` — https://github.com/nodejs/undici
- `undici-types@7.24.6` — https://github.com/nodejs/undici
- `undici@6.25.0` — https://github.com/nodejs/undici
- `unified@11.0.5` — unifiedjs/unified
- `unist-util-find-after@5.0.0` — syntax-tree/unist-util-find-after
- `unist-util-is@6.0.1` — syntax-tree/unist-util-is
- `unist-util-position@5.0.0` — syntax-tree/unist-util-position
- `unist-util-stringify-position@4.0.0` — syntax-tree/unist-util-stringify-position
- `unist-util-visit-parents@6.0.2` — syntax-tree/unist-util-visit-parents
- `unist-util-visit@5.1.0` — syntax-tree/unist-util-visit
- `unpipe@1.0.0` — stream-utils/unpipe
- `untildify@3.0.3` — sindresorhus/untildify
- `url-join@5.0.0` — git://github.com/jfromaniello/url-join
- `url-parse@1.5.10` — https://github.com/unshiftio/url-parse
- `urlpattern-polyfill@10.0.0` — https://github.com/kenchris/urlpattern-polyfill
- `use-sync-external-store@1.6.0` — https://github.com/facebook/react
- `util-deprecate@1.0.2` — https://github.com/TooTallNate/util-deprecate
- `utils-merge@1.0.1` — https://github.com/jaredhanson/utils-merge
- `uuid@10.0.0` — https://github.com/uuidjs/uuid
- `uuid@11.1.1` — https://github.com/uuidjs/uuid
- `uuid@13.0.2` — https://github.com/uuidjs/uuid
- `uuid@14.0.0` — https://github.com/uuidjs/uuid
- `uuid@9.0.1` — https://github.com/uuidjs/uuid
- `v8-compile-cache-lib@3.0.1` — https://github.com/cspotcode/v8-compile-cache-lib
- `validator@13.15.35` — https://github.com/validatorjs/validator.js
- `vary@1.1.2` — jshttp/vary
- `vfile-message@4.0.3` — vfile/vfile-message
- `vfile@6.0.3` — vfile/vfile
- `void-elements@3.1.0` — pugjs/void-elements
- `voyageai@0.2.1` — https://github.com/voyage-ai/typescript-sdk
- `web-streams-polyfill@3.3.3` — https://github.com/MattiasBuelens/web-streams-polyfill
- `webdav@5.10.0` — https://github.com/perry-mitchell/webdav-client
- `whatwg-fetch@3.6.20` — github/fetch
- `whatwg-url@14.2.0` — jsdom/whatwg-url
- `whatwg-url@5.0.0` — jsdom/whatwg-url
- `which-typed-array@1.1.20` — https://github.com/inspect-js/which-typed-array
- `wordwrap@1.0.0` — https://github.com/substack/node-wordwrap
- `wrap-ansi@7.0.0` — chalk/wrap-ansi
- `wrap-ansi@8.1.0` — chalk/wrap-ansi
- `ws@8.20.1` — https://github.com/websockets/ws
- `wsl-utils@0.1.0` — sindresorhus/wsl-utils
- `xml-js@1.6.11` — https://github.com/nashwaan/xml-js
- `xml-naming@0.1.0` — https://github.com/NaturalIntelligence/xml-naming
- `xml@1.0.1` — http://github.com/dylang/node-xml
- `xmlbuilder@10.1.1` — https://github.com/oozcitak/xmlbuilder-js
- `xmlhttprequest-ssl@2.1.2` — https://github.com/mjwwit/node-XMLHttpRequest
- `xtend@4.0.2` — https://github.com/Raynos/xtend
- `yargs@17.7.2` — https://github.com/yargs/yargs
- `yauzl@2.10.0` — https://github.com/thejoshwolfe/yauzl
- `yn@3.1.1` — sindresorhus/yn
- `zod@3.23.8` — https://github.com/colinhacks/zod
- `zod@3.25.76` — https://github.com/colinhacks/zod
- `zustand@4.5.7` — https://github.com/pmndrs/zustand
- `zwitch@2.0.4` — wooorm/zwitch

### ISC (68)

- `@isaacs/cliui@8.0.2` — yargs/cliui
- `@ungap/structured-clone@1.3.1` — https://github.com/ungap/structured-clone
- `abbrev@1.1.1` — http://github.com/isaacs/abbrev-js
- `ansis@4.3.0` — webdiscus/ansis
- `anymatch@3.1.3` — https://github.com/micromatch/anymatch
- `aproba@2.1.0` — https://github.com/iarna/aproba
- `are-we-there-yet@2.0.0` — https://github.com/npm/are-we-there-yet
- `chownr@1.1.4` — https://github.com/isaacs/chownr
- `chownr@2.0.0` — https://github.com/isaacs/chownr
- `cliui@8.0.1` — yargs/cliui
- `color-support@1.1.3` — https://github.com/isaacs/color-support
- `console-control-strings@1.1.0` — https://github.com/iarna/console-control-strings
- `d3-color@3.1.0` — https://github.com/d3/d3-color
- `d3-dispatch@3.0.1` — https://github.com/d3/d3-dispatch
- `d3-drag@3.0.0` — https://github.com/d3/d3-drag
- `d3-interpolate@3.0.1` — https://github.com/d3/d3-interpolate
- `d3-selection@3.0.0` — https://github.com/d3/d3-selection
- `d3-timer@3.0.1` — https://github.com/d3/d3-timer
- `d3-transition@3.0.1` — https://github.com/d3/d3-transition
- `d3-zoom@3.0.0` — https://github.com/d3/d3-zoom
- `fastq@1.20.1` — https://github.com/mcollina/fastq
- `foreground-child@3.3.1` — https://github.com/tapjs/foreground-child
- `fs-minipass@2.1.0` — https://github.com/npm/fs-minipass
- `fs.realpath@1.0.0` — https://github.com/isaacs/fs.realpath
- `gauge@3.0.2` — https://github.com/iarna/gauge
- `get-caller-file@2.0.5` — https://github.com/stefanpenner/get-caller-file
- `glob-parent@5.1.2` — gulpjs/glob-parent
- `glob@10.5.0` — https://github.com/isaacs/node-glob
- `glob@7.2.3` — https://github.com/isaacs/node-glob
- `has-unicode@2.0.1` — https://github.com/iarna/has-unicode
- `inflight@1.0.6` — https://github.com/npm/inflight
- `inherits@2.0.4` — https://github.com/isaacs/inherits
- `ini@1.3.8` — https://github.com/isaacs/ini
- `isexe@2.0.0` — https://github.com/isaacs/isexe
- `isolated-vm@4.7.2` — https://github.com/laverdet/isolated-vm
- `iterare@1.2.1` — https://github.com/felixfbecker/iterare
- `lru-cache@10.4.3` — https://github.com/isaacs/node-lru-cache
- `lru-cache@7.18.3` — https://github.com/isaacs/node-lru-cache
- `lucide-react@0.368.0` — https://github.com/lucide-icons/lucide
- `make-error@1.3.6` — https://github.com/JsCommunity/make-error
- `minimalistic-assert@1.0.1` — https://github.com/calvinmetcalf/minimalistic-assert
- `minimatch@3.1.5` — https://github.com/isaacs/minimatch
- `minimatch@9.0.9` — https://github.com/isaacs/minimatch
- `minipass@3.3.6` — https://github.com/isaacs/minipass
- `minipass@5.0.0` — https://github.com/isaacs/minipass
- `nopt@5.0.0` — https://github.com/npm/nopt
- `npmlog@5.0.1` — https://github.com/npm/npmlog
- `once@1.4.0` — https://github.com/isaacs/once
- `path-posix@1.0.0` — git@github.com:jden/node-path-posix
- `pg-int8@1.0.1` — https://github.com/charmander/pg-int8
- `picocolors@1.1.1` — alexeyraspopov/picocolors
- `rimraf@3.0.2` — https://github.com/isaacs/rimraf
- `semver@6.3.1` — https://github.com/npm/node-semver
- `semver@7.8.0` — https://github.com/npm/node-semver
- `semver@7.8.1` — https://github.com/npm/node-semver
- `set-blocking@2.0.0` — https://github.com/yargs/set-blocking
- `setprototypeof@1.2.0` — https://github.com/wesleytodd/setprototypeof
- `signal-exit@3.0.7` — https://github.com/tapjs/signal-exit
- `signal-exit@4.1.0` — https://github.com/tapjs/signal-exit
- `split2@4.2.0` — https://github.com/mcollina/split2
- `tar@6.2.1` — https://github.com/isaacs/node-tar
- `which@2.0.2` — https://github.com/isaacs/node-which
- `wide-align@1.1.5` — https://github.com/iarna/wide-align
- `wrappy@1.0.2` — https://github.com/npm/wrappy
- `y18n@5.0.8` — yargs/y18n
- `yallist@4.0.0` — https://github.com/isaacs/yallist
- `yaml@2.9.0` — github:eemeli/yaml
- `yargs-parser@21.1.1` — https://github.com/yargs/yargs-parser

### Apache-2.0 (42)

- `@google/generative-ai@0.24.1` — https://github.com/google/generative-ai-js
- `@puppeteer/browsers@2.3.0` — https://github.com/puppeteer/puppeteer/tree/main/packages/browsers
- `@qdrant/js-client-rest@1.18.0` — https://github.com/qdrant/qdrant-js
- `@swc/core@1.15.33` — https://github.com/swc-project/swc
- `@swc/counter@0.1.3` — https://github.com/swc-project/pkgs
- `@swc/types@0.1.26` — https://github.com/swc-project/swc
- `adler-32@1.3.1` — https://github.com/SheetJS/js-adler32
- `b4a@1.8.1` — https://github.com/holepunchto/b4a
- `bare-events@2.8.3` — https://github.com/holepunchto/bare-events
- `bare-fs@4.7.1` — https://github.com/holepunchto/bare-fs
- `bare-os@3.9.1` — https://github.com/holepunchto/bare-os
- `bare-path@3.0.0` — https://github.com/holepunchto/bare-path
- `bare-stream@2.13.1` — https://github.com/holepunchto/bare-stream
- `bare-url@2.4.3` — https://github.com/holepunchto/bare-url
- `bson@7.2.0` — mongodb/js-bson
- `cfb@1.2.2` — https://github.com/SheetJS/js-cfb
- `chromium-bidi@0.6.3` — https://github.com/GoogleChromeLabs/chromium-bidi
- `cluster-key-slot@1.1.1` — https://github.com/Salakar/cluster-key-slot
- `codepage@1.15.0` — https://github.com/SheetJS/js-codepage
- `crc-32@1.2.2` — https://github.com/SheetJS/js-crc32
- `denque@2.1.0` — https://github.com/invertase/denque
- `detect-libc@2.1.2` — https://github.com/lovell/detect-libc
- `ecdsa-sig-formatter@1.0.11` — ssh://git@github.com/Brightspace/node-ecdsa-sig-formatter
- `events-universal@1.0.1` — https://github.com/holepunchto/events-universal
- `frac@1.1.2` — https://github.com/SheetJS/frac
- `long@5.3.2` — https://github.com/dcodeIO/long.js
- `mongodb-connection-string-url@7.0.1` — https://github.com/mongodb-js/mongodb-connection-string-url
- `mongodb@7.3.0` — git@github.com:mongodb/node-mongodb-native
- `openai@6.39.0` — github:openai/openai-node
- `puppeteer-core@22.15.0` — https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core
- `puppeteer@22.15.0` — https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer
- `reflect-metadata@0.2.2` — https://github.com/rbuckton/reflect-metadata
- `rxjs@7.8.2` — https://github.com/reactivex/rxjs
- `ssf@0.11.2` — https://github.com/SheetJS/ssf
- `ssh2-sftp-client@11.0.0` — https://github.com/theophilusx/ssh2-sftp-client
- `swagger-ui-dist@5.17.14` — git@github.com:swagger-api/swagger-ui
- `text-decoder@1.2.7` — https://github.com/holepunchto/text-decoder
- `tunnel-agent@0.6.0` — https://github.com/mikeal/tunnel-agent
- `typescript@5.9.3` — https://github.com/microsoft/TypeScript
- `wmf@1.0.2` — https://github.com/SheetJS/js-wmf
- `word@0.3.0` — https://github.com/SheetJS/js-word
- `xlsx@0.18.5` — https://github.com/SheetJS/sheetjs

### BSD-3-Clause (21)

- `@js-joda/core@5.7.0` — https://github.com/js-joda/js-joda
- `@mapbox/node-pre-gyp@1.0.11` — https://github.com/mapbox/node-pre-gyp
- `bcrypt-pbkdf@1.0.2` — https://github.com/joyent/node-bcrypt-pbkdf
- `buffer-equal-constant-time@1.0.1` — git@github.com:goinstant/buffer-equal-constant-time
- `charenc@0.0.2` — git://github.com/pvorb/node-charenc
- `crypt@0.0.2` — git://github.com/pvorb/node-crypt
- `d3-ease@3.0.1` — https://github.com/d3/d3-ease
- `devtools-protocol@0.0.1312386` — https://github.com/ChromeDevTools/devtools-protocol
- `diff@4.0.4` — https://github.com/kpdecker/jsdiff
- `fast-uri@3.1.2` — https://github.com/fastify/fast-uri
- `flat@5.0.2` — https://github.com/hughsk/flat
- `highlight.js@11.11.1` — https://github.com/highlightjs/highlight.js
- `ieee754@1.2.1` — https://github.com/feross/ieee754
- `light-my-request@5.14.0` — https://github.com/fastify/light-my-request
- `md5@2.3.0` — git://github.com/pvorb/node-md5
- `qs@6.14.2` — https://github.com/ljharb/qs
- `secure-json-parse@2.7.0` — https://github.com/fastify/secure-json-parse
- `secure-json-parse@4.1.0` — https://github.com/fastify/secure-json-parse
- `source-map@0.6.1` — http://github.com/mozilla/source-map
- `sprintf-js@1.0.3` — https://github.com/alexei/sprintf.js
- `sprintf-js@1.1.3` — https://github.com/alexei/sprintf.js

### BSD-2-Clause (18)

- `dingbat-to-unicode@1.0.1` — https://github.com/mwilliamson/dingbat-to-unicode
- `dotenv-expand@10.0.0` — https://github.com/motdotla/dotenv-expand
- `dotenv@16.4.5` — https://github.com/motdotla/dotenv
- `dotenv@16.6.1` — https://github.com/motdotla/dotenv
- `entities@6.0.1` — git://github.com/fb55/entities
- `escodegen@2.1.0` — http://github.com/estools/escodegen
- `esprima@4.0.1` — https://github.com/jquery/esprima
- `estraverse@5.3.0` — http://github.com/estools/estraverse
- `esutils@2.0.3` — http://github.com/estools/esutils
- `extract-zip@2.0.1` — maxogden/extract-zip
- `json-schema-typed@7.0.3` — https://github.com/typeslick/json-schema-typed
- `lop@0.4.2` — https://github.com/mwilliamson/lop
- `mammoth@1.12.0` — https://github.com/mwilliamson/mammoth.js
- `option@0.2.4` — https://github.com/mwilliamson/node-options
- `uglify-js@3.19.3` — mishoo/UglifyJS
- `webidl-conversions@3.0.1` — jsdom/webidl-conversions
- `webidl-conversions@7.0.0` — jsdom/webidl-conversions
- `winreg@1.2.4` — https://github.com/fresc81/node-winreg

### BlueOak-1.0.0 (5)

- `jackspeak@3.4.3` — https://github.com/isaacs/jackspeak
- `minipass@7.1.3` — https://github.com/isaacs/minipass
- `package-json-from-dist@1.0.1` — https://github.com/isaacs/package-json-from-dist
- `path-scurry@1.11.1` — https://github.com/isaacs/path-scurry
- `sax@1.6.0` — ssh://git@github.com/isaacs/sax-js

### Unlicense (2)

- `fast-sha256@1.3.0` — https://github.com/dchest/fast-sha256-js
- `tweetnacl@0.14.5` — https://github.com/dchest/tweetnacl-js

### (MIT OR CC0-1.0) (1)

- `type-fest@2.19.0` — sindresorhus/type-fest

### Apache-2.0 AND MIT (1)

- `@swc/core-darwin-arm64@1.15.33` — https://github.com/swc-project/swc

### Python-2.0 (1)

- `argparse@2.0.1` — nodeca/argparse

### BSD (1)

- `duck@0.1.12` — https://github.com/mwilliamson/duck.js

### (MIT OR WTFPL) (1)

- `expand-template@2.0.3` — https://github.com/ralphtheninja/expand-template

### (MIT OR GPL-3.0-or-later) (1)

- `jszip@3.10.1` — https://github.com/Stuk/jszip

### MIT-0 (1)

- `nodemailer@6.10.1` — https://github.com/nodemailer/nodemailer

### (Apache-2.0 OR UPL-1.0) (1)

- `oracledb@7.0.0` — https://github.com/oracle/node-oracledb

### (MIT AND Zlib) (1)

- `pako@1.0.11` — nodeca/pako

### (BSD-2-Clause OR MIT OR Apache-2.0) (1)

- `rc@1.2.8` — https://github.com/dominictarr/rc

### (MIT AND BSD-3-Clause) (1)

- `sha.js@2.4.12` — https://github.com/crypto-browserify/sha.js

### WTFPL OR MIT (1)

- `string-format@2.0.0` — https://github.com/davidchambers/string-format

### 0BSD (1)

- `tslib@2.8.1` — https://github.com/Microsoft/tslib
