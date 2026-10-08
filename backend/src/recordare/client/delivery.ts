// GENERATED from recordare packages/client/src/delivery.ts @ 4bd90f7 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Delivery policy for a host's outbox: the host stores what it must send (with its own transaction, so a chat is never
 * slowed or failed by Recordare) and asks here what to do after each attempt. Exponential back-off with full jitter,
 * capped; `Retry-After` from Recordare wins when it asks for longer; requests Recordare will never accept are parked.
 */
import { isPermanent, RecordareHttpError } from './errors.js';

export interface DeliveryPolicy {
  /** Attempts before parking; default 12 (≈ 2.5 days with the default delays). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_DELIVERY: DeliveryPolicy = { maxAttempts: 12, baseDelayMs: 5_000, maxDelayMs: 60 * 60 * 1_000 };

/** Upper bound of the wait before attempt n+1 (n = attempts made so far). */
export function backoffMs(attempts: number, policy: DeliveryPolicy = DEFAULT_DELIVERY): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempts - 1), policy.maxDelayMs);
}

export type Next = { action: 'retry'; delayMs: number } | { action: 'park'; reason: string };

/**
 * After a failed attempt: retry (and when) or park. `attempts` counts the attempt that just failed. `random` is
 * injectable for tests.
 */
export function afterFailure(err: unknown, attempts: number, policy: DeliveryPolicy = DEFAULT_DELIVERY, random = Math.random): Next {
  if (isPermanent(err)) return { action: 'park', reason: 'rejected' };
  if (attempts >= policy.maxAttempts) return { action: 'park', reason: 'max_attempts' };
  // Full jitter (spreads retries after an outage), never below the base delay.
  const jittered = Math.max(policy.baseDelayMs, Math.round(backoffMs(attempts, policy) * random()));
  const asked = err instanceof RecordareHttpError ? err.retryAfterMs : undefined;
  return { action: 'retry', delayMs: Math.min(policy.maxDelayMs, Math.max(jittered, asked ?? 0)) };
}
