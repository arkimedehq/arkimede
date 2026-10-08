// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-identity.service.ts
 *
 * Arkimede user → Recordare person (Recordare INTEGRATION.md §2), on the shared
 * client library's PersonDirectory: `GET api/v1/me` with X-Recordare-User = the
 * Arkimede user id (the client's auto-provisioning creates the person) gives the
 * ownerId — stored on the user (users.recordareOwnerId) — the consent the Recordare
 * admin gives (cached, never stored), the kind of memory and the Atlas address.
 * The person's name follows the Arkimede profile (synced on every lookup). The kind
 * (personal, or shared by everyone using the account — Recordare D48 "entity") is
 * the user's choice in Settings, accepted by Recordare only while the memory is empty.
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
import { setRecordareOwnerResolver } from '../observability/genai-tracing';
import { MemoryNotEmptyError, type MemoryKind, PersonDirectory, type RecordareClient } from './client';
import { recordareClient, recordareConfig } from './recordare.config';
import { setConsentOffProvider } from './recordare-outbox';

/** Bound on the profile read's re-check (Settings must not hang on Recordare). */
const PROFILE_CHECK_TIMEOUT_MS = 3_000;

/** What the user's episodic memory is doing, for the profile / Settings. */
export type EpisodicMemoryStatus =
  | 'off'                  // Recordare not configured, or the user's switch is off
  | 'waiting_activation'   // switch on, consent not (yet) given by the Recordare admin
  | 'active'               // switch on and consent given
  | 'unknown';             // switch on, Recordare not reachable right now

/** Personal memory, or one shared by everyone using the account (Recordare's `entity`). */
export type EpisodicMemoryKind = MemoryKind;

/** Recordare refused a kind change: the memory already holds memories. */
export { MemoryNotEmptyError as RecordareMemoryNotEmptyError };

@Injectable()
export class RecordareIdentityService implements OnModuleInit {
  private readonly logger = new Logger(RecordareIdentityService.name);
  private directory: { client: RecordareClient; people: PersonDirectory } | null = null;

  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  async onModuleInit(): Promise<void> {
    if (!recordareConfig()) return;
    setRecordareOwnerResolver((userId) => this.cachedOwnerId(userId));
    setConsentOffProvider(() => this.consentKnownOff());
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
            const u = await this.users.findOne({ where: { id: userId }, select: { id: true, name: true, episodicMemoryEnabled: true } });
            return u ? { enabled: !!u.episodicMemoryEnabled, name: u.name } : null;
          },
          onResolved: async (userId, person) => {
            if (!person.ownerId) return;
            const u = await this.users.findOne({ where: { id: userId }, select: { id: true, recordareOwnerId: true } });
            if (u && u.recordareOwnerId !== person.ownerId) await this.users.update(userId, { recordareOwnerId: person.ownerId });
          },
          onError: (userId, err: any) => this.logger.warn(`Recordare lookup for user ${userId}: ${err?.message ?? err}`),
        }),
      };
    }
    return this.directory.people;
  }

  /**
   * Loads the stored ownerIds (switch on, already provisioned) so the very first
   * spans after a start carry `recordare.owner_id`. One query; entries are stale,
   * so their consent is still fetched in the background on first use. Never fails the start.
   */
  async warm(): Promise<number> {
    const people = this.people();
    if (!people) return 0;
    try {
      const rows = await this.users.find({
        where: { episodicMemoryEnabled: true, recordareOwnerId: Not(IsNull()) },
        select: { id: true, recordareOwnerId: true },
      });
      for (const r of rows) if (r.recordareOwnerId) people.seed(r.id, r.recordareOwnerId);
      return rows.length;
    } catch (err: any) {
      this.logger.warn(`Recordare owner cache warm-up failed: ${err?.message ?? err}`);
      return 0;
    }
  }

  /** Known ownerId, or undefined (then a background lookup is started). Never throws, never waits. */
  cachedOwnerId(userId: string): string | undefined {
    return this.people()?.peek(userId)?.ownerId ?? undefined;
  }

  /** Cached consent: true / false, or undefined when unknown (a lookup is started). Never waits. */
  cachedConsent(userId: string): boolean | undefined {
    return this.people()?.peek(userId)?.consent ?? undefined;
  }

  /** Users whose consent is KNOWN to be off (the outbox skips them: no messages buffered before consent). */
  consentKnownOff(): string[] {
    return this.people()?.knownOff() ?? [];
  }

  /** Forgets what is cached for a user (e.g. after their switch or name changed). */
  invalidate(userId: string): void {
    this.people()?.invalidate(userId);
  }

  /** Status for the profile: re-checks Recordare now (bounded wait), falling back to the cached state. */
  async status(userId: string, switchOn: boolean): Promise<EpisodicMemoryStatus> {
    const people = this.people();
    if (!people || !switchOn) return 'off';
    return people.status(userId, PROFILE_CHECK_TIMEOUT_MS);
  }

  /** Kind of memory and Atlas address as last read from Recordare (call after status()). */
  details(userId: string): { kind: EpisodicMemoryKind | null; atlasUrl: string | null } {
    const p = this.people()?.peek(userId);
    return { kind: p?.kind ?? null, atlasUrl: p?.atlasUrl ?? null };
  }

  /** The user's choice of memory kind; Recordare accepts it only while the memory is empty (MemoryNotEmptyError). */
  async setKind(userId: string, kind: EpisodicMemoryKind): Promise<void> {
    const client = recordareClient();
    if (!client || !(await this.ensureOwner(userId))) return;
    try {
      await client.updateMe(userId, { kind });
    } finally {
      this.invalidate(userId);
    }
  }

  /** The user's ownerId, provisioning and naming the person on first use; null when off / unavailable. */
  async ensureOwner(userId: string): Promise<string | null> {
    const people = this.people();
    if (!people) return null;
    const known = people.peek(userId)?.ownerId;
    if (known) return known;
    return (await people.refresh(userId)).ownerId;
  }
}
