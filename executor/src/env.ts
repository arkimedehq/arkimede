/**
 * env.ts — loading of the executor's environment variables (CONVENTION).
 *
 * It must be imported FIRST in main.ts, before any module that reads
 * process.env at the top level (e.g. the runners).
 *
 * Single source: `.env.executor` at the repo ROOT (next to the backend's
 * `.env`). All the env vars live "in a single place", with distinct names per file:
 *   .env            → backend
 *   .env.executor   → executor (this one)
 *   frontend/.env   → frontend (Vite convention, stays in its own folder)
 *
 * The executor does NOT read the backend's `.env`: it would contain backend-only
 * secrets (RUN_TOKEN_SECRET, TOOL_SECRETS_KEY, DB_*). Here there is only what the
 * executor needs; `SERVICE_API_KEY` is duplicated and MUST match the backend's
 * one (auth mesh, fail-closed).
 *
 * In Docker this file does not exist in the container: the executor receives the
 * variables from the compose `environment:` block (dotenv does not override
 * process.env that is already set), so the import here is a harmless no-op.
 */
import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(__dirname, '..', '..', '.env.executor') });
