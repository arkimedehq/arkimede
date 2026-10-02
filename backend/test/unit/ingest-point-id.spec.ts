// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** Internal vector ingest: deterministic point ids make re-ingests idempotent. */
import { describe, it, expect } from 'vitest';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { ingestPointId } from '../../src/vector-db/point-id';

describe('ingestPointId', () => {
  it('is a valid UUID (accepted by every vector store as point id)', () => {
    const id = ingestPointId('catalogue', 'P-001');
    expect(isUuid(id)).toBe(true);
    expect(uuidVersion(id)).toBe(5);
  });

  it('is stable: the same item in the same collection always gets the same id', () => {
    expect(ingestPointId('catalogue', 'P-001')).toBe(ingestPointId('catalogue', 'P-001'));
  });

  it('differs across items and across collections', () => {
    expect(ingestPointId('catalogue', 'P-001')).not.toBe(ingestPointId('catalogue', 'P-002'));
    expect(ingestPointId('catalogue', 'P-001')).not.toBe(ingestPointId('other', 'P-001'));
  });

  it('cannot be confused by separators inside names', () => {
    expect(ingestPointId('a', 'b:c')).not.toBe(ingestPointId('a:b', 'c'));
  });
});
