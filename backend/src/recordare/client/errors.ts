// GENERATED from recordare packages/client/src/errors.ts @ 4bd90f7 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** Typed errors. Recordare answers errors as RFC 9457 problem details (`application/problem+json`). */

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  /** Recordare's machine-readable code, e.g. `memory_not_empty`, `cannot_link`. */
  code?: string;
  detail?: string;
}

/** Recordare answered with an error status. */
export class RecordareHttpError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
    /** From `Retry-After` (RFC 9110), when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    // The problem's title and code only: never request or response content in messages (they end up in logs).
    super(`Recordare ${status}${problem.code ? ` ${problem.code}` : ''}${problem.title ? ` (${problem.title})` : ''}`);
    this.name = 'RecordareHttpError';
  }
}

/** Recordare could not be reached, or did not answer in time. */
export class RecordareUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'RecordareUnavailableError';
  }
}

/** The memory kind can change only while the memory is empty (`PATCH /me {kind}` → 409). */
export class MemoryNotEmptyError extends Error {
  constructor() {
    super('The memory kind can change only while the memory is empty');
    this.name = 'MemoryNotEmptyError';
  }
}

/**
 * Requests Recordare will answer the same way however often they are repeated: a sender parks them instead of
 * retrying (bad request, too large, unprocessable).
 */
export function isPermanent(err: unknown): boolean {
  return err instanceof RecordareHttpError && [400, 413, 422].includes(err.status);
}
