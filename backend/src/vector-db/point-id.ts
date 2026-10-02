// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { v5 as uuidv5 } from 'uuid';

/** Fixed namespace for ingest point ids (never change: ids of existing points depend on it). */
const INGEST_POINT_NAMESPACE = '4f6c7a1e-2b3d-5e8f-9a0b-1c2d3e4f5a6b';

/**
 * Deterministic vector point id for an ingested item: the same (collection, item id) always
 * maps to the same UUID, so re-ingesting an item overwrites its point instead of adding a
 * duplicate (idempotent staged / partial re-ingests).
 */
export function ingestPointId(collection: string, itemId: string): string {
  return uuidv5(`${collection}\u0000${itemId}`, INGEST_POINT_NAMESPACE);
}
