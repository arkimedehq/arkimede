// GENERATED from recordare packages/client/src/people.ts @ 42a6729 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Who each of the platform's users is in Recordare, cached: the memory (memoryId), its mode and the Atlas
 * address. Recordare has no consent flag (D50): the platform's own switch (`enabled`) decides whether it is contacted.
 * The synchronous readers never wait on Recordare: they answer from the cache (even if stale) and refresh in the
 * background. Each lookup also keeps the person's name and gender in sync with the platform's profile.
 */
import { type MeSettings, type MemoryGender, type MemoryMode } from './contract.js';
import { type RecordareClient } from './client.js';

export interface Person {
  /** null = not known yet (not opted in on the platform, or Recordare unreachable before the first lookup). */
  memoryId: string | null;
  mode: MemoryMode | null;
  atlasUrl: string | null;
}

/** The user as the platform knows them. */
export interface PlatformUser {
  /** The platform's own opt-in (e.g. a "memory" switch): when false Recordare is not contacted — no person is created. */
  enabled: boolean;
  /** The current profile name: the person's name in Recordare follows it. */
  name?: string | null;
  /** The profile's gender: the first person's gender in gendered languages follows it (not set = left as it is). */
  gender?: MemoryGender | null;
}

export interface PersonDirectoryOptions {
  /** How long a lookup is trusted; default 5 minutes. */
  ttlMs?: number;
  /** The user on the platform; null = unknown user (treated as not enabled). */
  user: (user: string) => Promise<PlatformUser | null>;
  /** A person resolved (e.g. to store the memoryId with the platform's user). */
  onResolved?: (user: string, person: Person) => void | Promise<void>;
  /** Called when a lookup or a settings update fails (the cache keeps the last known person). */
  onError?: (user: string, err: unknown) => void;
}

interface Entry extends Person { until: number }

export class PersonDirectory {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Person>>();

  constructor(private readonly client: RecordareClient, private readonly options: PersonDirectoryOptions) {}

  /** Last known person (possibly stale), or undefined; a stale or missing entry is refreshed in the background. */
  peek(user: string): Person | undefined {
    const hit = this.cache.get(user);
    if (!hit || hit.until <= Date.now()) void this.refresh(user).catch(() => undefined);
    if (!hit) return undefined;
    const { until: _until, ...person } = hit;
    return person;
  }

  /** A person known from the host's own storage (e.g. after a restart), marked stale so it is refreshed on first use. */
  seed(user: string, memoryId: string): void {
    if (!this.cache.has(user)) this.cache.set(user, { memoryId, mode: null, atlasUrl: null, until: 0 });
  }

  /** Forgets a user (e.g. after their switch or name changed): the next read asks Recordare again. */
  invalidate(user: string): void {
    this.cache.delete(user);
  }

  /** Asks Recordare now (one request in flight per user). */
  refresh(user: string): Promise<Person> {
    const running = this.inflight.get(user);
    if (running) return running;
    const p = this.lookup(user).finally(() => this.inflight.delete(user));
    this.inflight.set(user, p);
    return p;
  }

  private async lookup(user: string): Promise<Person> {
    const ttl = this.options.ttlMs ?? 5 * 60 * 1_000;
    const remember = (p: Person): Person => {
      this.cache.set(user, { ...p, until: Date.now() + ttl });
      return p;
    };
    const last = this.cache.get(user);
    try {
      const platform = await this.options.user(user);
      // Not opted in on the platform: never contact Recordare; a person already known stays known (e.g. for tracing).
      if (!platform?.enabled) return remember({ memoryId: last?.memoryId ?? null, mode: last?.mode ?? null, atlasUrl: last?.atlasUrl ?? null });
      const me = await this.client.me(user);
      const name = platform.name?.trim().slice(0, 100);
      const changed: MeSettings = {
        ...(name && me.displayName !== name ? { displayName: name } : {}),
        ...(platform.gender && me.gender !== platform.gender ? { gender: platform.gender } : {}),
      };
      if (Object.keys(changed).length) {
        await this.client.updateMe(user, changed).catch((err) => this.options.onError?.(user, err));
      }
      const person: Person = { memoryId: me.memoryId, mode: me.mode, atlasUrl: me.atlasUrl ?? null };
      await this.options.onResolved?.(user, person);
      return remember(person);
    } catch (err) {
      this.options.onError?.(user, err);
      return remember({ memoryId: last?.memoryId ?? null, mode: last?.mode ?? null, atlasUrl: last?.atlasUrl ?? null });
    }
  }
}
