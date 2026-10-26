// GENERATED from recordare packages/client/src/index.ts @ 42a6729 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** @arkimedehq/recordare-client — the one client library every Recordare client uses (WORK_PLAN 6.7). */
export * from './contract.js';
export * from './errors.js';
export { type ClientOptions, type FetchLike, parseRetryAfter } from './http.js';
export { RecordareClient } from './client.js';
export { RecordareMcp, type McpOptions, type Tool, type ToolResult } from './mcp.js';
export { PersonDirectory, type Person, type PersonDirectoryOptions } from './people.js';
export { TOOLS } from './tools.js';
export { isLinkCode, LINK_CODE, LINK_CODE_INSTRUCTION } from './links.js';
export { afterFailure, backoffMs, DEFAULT_DELIVERY, type DeliveryPolicy, type Next } from './delivery.js';
