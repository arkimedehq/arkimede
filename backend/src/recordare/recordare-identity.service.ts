// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-identity.service.ts
 *
 * Arkimede account → Recordare memory (Recordare INTEGRATION.md §2, its D50 "agent
 * memory": one account = one agent = one memory), on the shared client library's
 * PersonDirectory: `GET api/v1/me` with X-Recordare-User = the Arkimede user id (the
 * client's auto-provisioning creates the memory) gives the memoryId — stored on the user
 * (users.recordareMemoryId) — the memory's mode and the Atlas address. Recordare has no
 * consent flag (its D50): the user's switch here is the only on/off.
 * Other Arkimede users who speak in the account's conversations are participants
 * recognised inside this memory (ingest mapper), never memories of their own here.
 * The memory's name and gender (first person in gendered languages) follow the Arkimede
 * profile: users.name and users.gender, synced by the directory on every lookup (gender
 * not set = Recordare's default, masculine). The mode —
 * personal (the account holder is "I") or entity (a shared agent: undeclared speakers
 * are "someone") — is the user's choice in Settings, accepted by Recordare only while
 * the memory is empty.
 *
 * Only users with episodicMemoryEnabled are looked up: switching the memory off
 * never creates a person in Recordare.
 *
 * The synchronous readers never wait on Recordare: they answer from the cache (even
 * if stale) and start a refresh in the background.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { setRecordareMemoryResolver } from '../observability/genai-tracing';
import { MemoryNotEmptyError, type MemoryMode, PersonDirectory, type RecordareClient } from './client';
import { recordareClient, recordareConfig } from './recordare.config';

/** Bound on the profile read's re-check (Settings must not hang on Recordare). */
const PROFILE_CHECK_TIMEOUT_MS = 3_000;

/** What the user's episodic memory is doing, for the profile / Settings. */
export type EpisodicMemoryStatus =
  | 'off'                  // Recordare not configured, or the user's switch is off
  | 'active'               // switch on, Recordare reached
  | 'unknown';             // switch on, Recordare not reachable right now

/** Personal memory (the account holder is "I"), or an entity's shared by everyone using the account. */
export type EpisodicMemoryMode = MemoryMode;

/** Recordare refused a mode change: the memory already holds memories. */
export { MemoryNotEmptyError as RecordareMemoryNotEmptyError };

@Injectable()
export class RecordareIdentityService implements OnModuleInit {
  private readonly logger = new Logger(RecordareIdentityService.name);
  private directory: { client: RecordareClient; people: PersonDirectory } | null = null;
  /** Users whose last lookup failed (Recordare unreachable); cleared by the next successful one. */
  private readonly unreachable = new Set<string>();

  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  async onModuleInit(): Promise<void> {
    if (!recordareConfig()) return;
    setRecordareMemoryResolver((userId) => this.cachedMemoryId(userId));
    await this.warm();
  }

  /** The directory for the current client (rebuilt if the configuration changed); null when not configured. */
  private people(): PersonDirectory | null {
    const client = recordareClient();
    if (!client) return null;
    if (this.directory?.client !== client) {
      this.directory = {
        client,
        people: new PersonDirectory(client, {
          user: async (userId) => {
            const u = await this.users.findOne({ where: { id: userId }, select: { id: true, name: true, gender: true, episodicMemoryEnabled: true } });
            return u ? { enabled: !!u.episodicMemoryEnabled, name: u.name, gender: u.gender } : null;
          },
          onResolved: async (userId, person) => {
            this.unreachable.delete(userId);
            if (!person.memoryId) return;
            const u = await this.users.findOne({ where: { id: userId }, select: { id: true, recordareMemoryId: true } });
            if (u && u.recordareMemoryId !== person.memoryId) await this.users.update(userId, { recordareMemoryId: person.memoryId });
          },
          onError: (userId, err: any) => {
            this.unreachable.add(userId);
            this.logger.warn(`Recordare lookup for user ${userId}: ${err?.message ?? err}`);
          },
        }),
      };
    }
    return this.directory.people;
  }

  /**
   * Loads the stored memoryIds (switch on, already provisioned) so the very first
   * spans after a start carry `recordare.memory_id`. One query; entries are stale,
   * so they are still refreshed in the background on first use. Never fails the start.
   */
  async warm(): Promise<number> {
    const people = this.people();
    if (!people) return 0;
    try {
      const rows = await this.users.find({
        where: { episodicMemoryEnabled: true, recordareMemoryId: Not(IsNull()) },
        select: { id: true, recordareMemoryId: true },
      });
      for (const r of rows) if (r.recordareMemoryId) people.seed(r.id, r.recordareMemoryId);
      return rows.length;
    } catch (err: any) {
      this.logger.warn(`Recordare memory cache warm-up failed: ${err?.message ?? err}`);
      return 0;
    }
  }

  /** Known memoryId, or undefined (then a background lookup is started). Never throws, never waits. */
  cachedMemoryId(userId: string): string | undefined {
    return this.people()?.peek(userId)?.memoryId ?? undefined;
  }

  /** Forgets what is cached for a user (e.g. after their switch, name or gender changed). */
  invalidate(userId: string): void {
    this.people()?.invalidate(userId);
  }

  /** Status for the profile: re-checks Recordare now (bounded wait); 'unknown' when it cannot be reached. */
  async status(userId: string, switchOn: boolean): Promise<EpisodicMemoryStatus> {
    const people = this.people();
    if (!people || !switchOn) return 'off';
    let timer: NodeJS.Timeout | undefined;
    const fresh = await Promise.race([
      people.refresh(userId).catch(() => undefined),
      new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), PROFILE_CHECK_TIMEOUT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    return fresh?.memoryId && !this.unreachable.has(userId) ? 'active' : 'unknown';
  }

  /** Memory mode and Atlas address as last read from Recordare (call after status()). */
  details(userId: string): { mode: EpisodicMemoryMode | null; atlasUrl: string | null } {
    const p = this.people()?.peek(userId);
    return { mode: p?.mode ?? null, atlasUrl: p?.atlasUrl ?? null };
  }

  /** The user's choice of memory mode; Recordare accepts it only while the memory is empty (MemoryNotEmptyError). */
  async setMode(userId: string, mode: EpisodicMemoryMode): Promise<void> {
    const client = recordareClient();
    if (!client || !(await this.ensureMemory(userId))) return;
    try {
      await client.updateMe(userId, { mode });
    } finally {
      this.invalidate(userId);
    }
  }

  /** The user's memoryId, provisioning and naming the person on first use; null when off / unavailable. */
  async ensureMemory(userId: string): Promise<string | null> {
    const people = this.people();
    if (!people) return null;
    const known = people.peek(userId)?.memoryId;
    if (known) return known;
    return (await people.refresh(userId)).memoryId;
  }
}
