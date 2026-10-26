// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-notes-sync.service.ts
 *
 * Copies of Recordare notes in A-MEM (Recordare D34): the user copies a note by hand (Diary → Notes) or by their rule
 * (`User.recordareCopyCategories`: the notes of these categories go into the personal memory). A background worker
 * follows each such user's notes change feed (`GET api/v1/notes/changes?since`, cursor `User.recordareNotesCursor`):
 *   - a note updated or corrected → its copies take the new text and follow the note that took its place;
 *   - a note forgotten or retired → its copies are removed;
 *   - a current, confirmed note of a rule category → copied into the personal memory (once; never pushing the user's
 *     own notes out).
 * Only users with the episodic memory on and a rule or a copy are followed. A Recordare outage only delays it.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { type NoteChange } from './client';
import { recordareClient } from './recordare.config';
import { type RecordareNoteCopy, UserMemoryService } from '../user-memory/user-memory.service';

const POLL_MS = Number(process.env.RECORDARE_NOTES_SYNC_MS) || 5 * 60_000;
const PAGE = 100;
/** Pages per user per round: a long backlog (a rule just added) goes on at the next round. */
const MAX_PAGES = 20;

interface FollowedUser { id: string; categories: string[]; cursor: string }

@Injectable()
export class RecordareNotesSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordareNotesSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly memory: UserMemoryService,
  ) {}

  onModuleInit(): void {
    if (!recordareClient()) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.syncAll(); } catch (err: any) {
      this.logger.warn(`notes sync failed: ${err?.message ?? err}`);
    } finally { this.running = false; }
  }

  /** One round over every followed user. Exposed for tests. */
  async syncAll(): Promise<void> {
    if (!recordareClient()) return;
    const users: FollowedUser[] = await this.ds.query(
      `SELECT u."id", u."recordareCopyCategories" AS categories, u."recordareNotesCursor"::text AS cursor FROM "users" u
        WHERE u."episodicMemoryEnabled"
          AND (jsonb_array_length(u."recordareCopyCategories") > 0
            OR EXISTS (SELECT 1 FROM "user_memory" m WHERE m."userId" = u."id" AND m."recordareNoteId" IS NOT NULL))`);
    for (const u of users) {
      try {
        await this.syncUser(u);
      } catch (err: any) {
        this.logger.warn(`notes sync for user ${u.id} stopped: ${err?.message ?? err}`);
      }
    }
  }

  /** Follows one user's feed from their cursor, saving it after every page. */
  async syncUser(u: FollowedUser): Promise<void> {
    const client = recordareClient();
    if (!client) return;
    let since = Number(u.cursor);
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await client.noteChanges(u.id, { since, limit: PAGE });
      for (const change of page.items) await this.apply(u.id, u.categories, change);
      if (page.next !== since) {
        since = page.next;
        await this.ds.query(`UPDATE "users" SET "recordareNotesCursor" = $2 WHERE "id" = $1`, [u.id, since]);
      }
      if (!page.more) return;
    }
  }

  async apply(userId: string, categories: string[], c: NoteChange): Promise<void> {
    const note: RecordareNoteCopy | null = c.note ? { id: c.note.id, content: c.note.content, category: c.note.category } : null;
    if (c.change === 'forgotten' || c.change === 'retired') {
      await this.memory.followRecordareNote(userId, c.noteId, null);
      return;
    }
    // The new note, even if it was replaced again since: a later change in the feed moves the copies on.
    if ((c.change === 'updated' || c.change === 'corrected') && c.replaces) await this.memory.followRecordareNote(userId, c.replaces, note);
    if (note && c.note!.status === 'current' && !c.note!.pending && categories.includes(note.category ?? '')) {
      await this.memory.copyRecordareNote(userId, note, { scope: 'personal', teamId: null, isAdmin: false }, true);
    }
  }
}
