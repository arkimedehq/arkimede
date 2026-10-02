# Embedding model migration (→ BAAI/bge-m3) — plan

Status: **P1 + P2 implemented** (branch `feat/embedding-reembed`: d79886c, 7028107, 3fd1416; 356 unit tests + real-Qdrant integration test). P3 (model identity per collection) not started. Applies to any deploy; the two current
targets are a home box (8 GB RAM, i3) and a small cloud VM (2 vCPU, 4 GB RAM + swap),
both on `intfloat/multilingual-e5-small` (384 dims) with Qdrant.

Constraint: the model runs inside Arkimede's own `embedding-service` (sentence-transformers),
never on an external runtime.

## Why

Retrieval-only benchmark on an Italian personal-memory dataset (18 questions; "noise" =
×13 messages with lexical traps), measured with sentence-transformers and the same
query/document prompt logic as `embedding-service` (recall@8, vector-only):

| Model | Base | With noise | Process RSS | CPU throughput (M4) |
|---|---|---|---|---|
| `intfloat/multilingual-e5-small` (current) | 85% | **59%** | 0.98 GB | 389 emb/s |
| `mixedbread-ai/mxbai-embed-large-v1` (repo default) | 84% | 60% | 0.77 GB | 8 emb/s |
| **`BAAI/bge-m3`** | **96%** | **76%** | 1.41 GB | 26 emb/s |

bge-m3: +17 points under noise, 8192-token context, 100+ languages, no query prompt
(the `embedding-service` applies none — correct for this model). Cost: ~+0.45 GB RSS,
~15× slower than e5-small on CPU (relevant for bulk re-index time, not for single queries).
Small sample → indicative, but the gap is large and consistent.

## What the code does today (inventory)

| # | Writer | Collection | Text embedded (side) | Where the source text lives |
|---|---|---|---|---|
| A | `user-memory.service.ts` `indexNote` | `user_memory` | content + context + keywords (**query** side) | DB `user_memory` (confirmed notes) |
| A' | `memory-evolution.service.ts:309` | `user_memory` | same | same — **bug: payload lacks `scope`/`teamId`** |
| B | `feedback.service.ts` `syncVector` | `feedback_memory` | question ‖ answer ‖ comment (**query** side) | DB `message_feedback` |
| C | `embed.service.ts` `ingestFile` | default / named collections | file chunks (document side) | payload `text` (+ file on disk) |
| D | `embed.service.ts` `ingestDatasourceFile` | default / named | datasource file chunks (document) | payload `text` only (no DB list of indexed paths) |
| E | `custom-tool.factory.ts` rag `index` | tool's collection | LLM-supplied text chunks (document) | payload `text` only |
| F | `internal-vector.controller.ts` `/internal/vector/ingest` | skill-owned collections | `item.text` (document) | **only if the skill put `text` in the payload** |
| G | `tool-selection.service.ts` | in-memory map | tool descriptions (query) | tool definitions (cache keyed by text, not model) |

Hazards found:
1. **Silent data loss on dimension change.** Every adapter's `ensureCollection` drops and
   recreates a collection whose vector size differs (`qdrant.adapter.ts:34`,
   `pgvector.adapter.ts:70`, `astradb.adapter.ts:69`). Switching 384 → 1024 and writing once
   would wipe each collection (e.g. a skill catalogue) with no error.
2. **Silent garbage on same-dimension change.** No collection records which model produced
   it; mixing models of equal size returns wrong neighbours without any error.
3. **Stale caches.** The backend caches the probed embedding identity until config save /
   restart; the tool-selection embedding cache is never invalidated.
4. Existing re-index paths are partial: `/user-memory/reindex` is per-user; per-file
   re-index duplicates chunks (no delete first); nothing for B, D, E, F.

## Code changes (platform, generic)

Branch `feat/embedding-reembed`; additive, each with tests; no change to behaviour when the
model does not change.

1. **No silent drop.** `ensureCollection` throws `VectorSizeMismatchError` (collection, expected,
   actual) instead of recreating. Recreation only through explicit paths
   (`recreateCollection`, the re-embed job). Enumerate all call sites first; admin "change
   vector size" flows must go through the explicit path.
2. **Model identity per collection.** Record `{model, dims, indexedAt}` per physical
   collection (Postgres table `vector_collection_index`, works for every adapter). On startup /
   probe: if the live model ≠ recorded model → admin warning card ("re-embed required"),
   writes to that collection blocked with a clear error (prevents mixing).
3. **`embedding-service`: `EMBEDDING_MAX_SEQ_LENGTH`** (default unchanged = model's own) to
   bound RAM/latency on small hosts; chunks are ~500 chars (~150 tokens), so 512 is safe.
4. **Re-embed job** (admin-only, BullMQ, resumable, with progress):
   - `POST /api/admin/vector-db/reembed` `{dryRun, collections?}` + status endpoint + admin UI.
   - Per collection: scroll all points (id + payload) → resolve text:
     `user_memory` / `feedback_memory` from DB (same text and **same side** as the writer),
     every other collection from `payload.text` (document side).
   - Write into a shadow collection `<name>__reembed` (new dims), same ids and payloads.
   - Verify: point count, id set, payload hash equal to the source → swap (recreate original
     with new size, copy points from shadow with vectors, drop shadow) → record identity.
   - Points with no resolvable text (skill collections without `text`) → collection left
     untouched and **reported** ("needs re-ingest by the owning skill"); never dropped.
   - Before anything: JSONL export of every collection's ids + payloads (restore aid and list
     of indexed datasource paths).
5. **Cache invalidation** on embedding identity change: clear the provider cache and
   `ToolSelectionService.invalidateEmbeddingCache()`.
6. **Fix A'**: `memory-evolution.service.ts` upsert must carry `scope` and `teamId` (today
   team/org notes re-indexed by evolution disappear from team/org vector search).

## Implemented API (admin: JWT or `ak_` API key with admin role)

| Call | Purpose |
|---|---|
| `GET /api/admin/vector-db/reembed/plan[?collections=a,b]` | Dry run with the model the embedding service runs NOW: per collection `action` (`reembed`, `recreate-empty`, `needs-reingest`, `empty`), resolvable / blank / stale / missing-text counts |
| `POST /api/admin/vector-db/reembed` `{collections?}` | Starts the job in the background (one at a time); audit `vectordb.reembed` |
| `GET /api/admin/vector-db/reembed/status` | Running / last report (`exportDir`, per-collection `written`, errors) |
| `GET /api/admin/vector-db/reembed/selfcheck?sample=30` | Each sampled point must retrieve itself (top-1 / top-3) |

Exports: `${UPLOAD_DIR}/reembed-exports/<timestamp>/<collection>.jsonl` (ids + payloads,
written before any change) + `report.json`. On a failed final verification the verified
shadow `<name>__reembed` is kept for recovery (never touched by later runs).

## Verification ("no data lost")

Automated, produced by the job and kept as a report:
- Per collection: points before = after; identical id sets; identical payload hashes
  (vectors excluded).
- DB cross-checks: confirmed `user_memory` rows = points in `user_memory`; feedback rows with
  `vectorId` = points in `feedback_memory`; `files.vectorized` files still have chunks.
- Vector sanity: every vector has the new dimension, norm ≈ 1, no duplicates.

Functional, before and after (golden set captured **before** the switch):
- 10-20 queries per collection with their current top-5 ids → after: the expected document
  still in top-5 (quality may improve, never disappear entirely).
- E2E in chat: a RAG question on an indexed document, a memory recall (`search_memory`), a
  top_k_rag tool selection, each skill search (e.g. product search), a datasource search.

## Rollout per deploy

Order: **home box first** (reference instance, own data), then the **cloud VM** (customer),
only after the home run is clean. Customer run out of office hours, announced.

| Step | Home box (8 GB) | Cloud VM (4 GB) |
|---|---|---|
| 0. Inventory (read-only) | collections, point counts, payload `text` presence per collection, `free -h`, `docker stats` | same + skill collections (catalogue) |
| 1. Backup | `pg_dump` + Qdrant snapshot + `.env` copy | same, under the deploy's backup dir |
| 2. Deploy code | rsync of the merged branch | publish → `scripts/update.sh` |
| 3. RAM headroom | raise embedding memory limit (1.5 GB → ~2.5 GB) | check headroom (OCR resident ~1.4 GB); if tight: `OCR_STRUCTURED=0` during the job, or temporary bigger instance |
| 4. Switch model | `.env`: `EMBEDDING_MODEL=BAAI/bge-m3`, `EMBEDDING_MAX_SEQ_LENGTH=512`; rebuild `embedding` image | same; build one image at a time + `docker builder prune` |
| 5. Clear query prefix | Settings → Embedding: prefix empty | same |
| 6. Re-embed | dry-run → run → report | same; skill collections without `text`: re-run the skill ingest |
| 7. Verify | automated report + golden set + E2E | same, plus customer smoke test |
| 8. Monitor 24 h | RAM, latency, error logs | same |

Rollback: rebuild the previous embedding image (old `EMBEDDING_MODEL`), restore the Qdrant
snapshot, restart backend — the identity table makes the state explicit.

## Open points

- Chunks count per deploy → re-index time estimate (bge-m3 on a 2-vCPU CPU ≈ 5-10 emb/s:
  10k points ≈ 20-35 min).
- Whether skill-owned collections store `text` (decides re-embed vs skill re-ingest).
- bge-m3 RSS under real batch load on each host (measure during the home run).
