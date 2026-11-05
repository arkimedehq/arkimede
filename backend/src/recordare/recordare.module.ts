// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/users.entity';
import { RecordareIdentityService } from './recordare-identity.service';
import { RecordareOutboxService } from './recordare-outbox.service';
import { RecordareMessageSubscriber } from './recordare-message.subscriber';
import { RecordareMcpService } from './recordare-mcp.service';
import { RecordareDiaryController } from './recordare-diary.controller';
import { RecordareNotesSyncService } from './recordare-notes-sync.service';
import { UserMemoryModule } from '../user-memory/user-memory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RecordareInitiativesService } from './recordare-initiatives.service';
import { RecordareWebhookController } from './recordare-webhook.controller';

/**
 * Recordare as the users' episodic memory (opt-in: RECORDARE_URL + RECORDARE_API_KEY,
 * then per user `episodicMemoryEnabled`). Identity mapping, ingest outbox (subscriber
 * + worker), the recall tools, the user's Diary (read API proxy), the copies of its
 * notes in A-MEM (D34) and the memory's own initiatives (Recordare D55: webhook, feed,
 * presence, delivered in a dedicated chat). Everything is a no-op when not configured.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User]), UserMemoryModule, NotificationsModule],
  controllers: [RecordareDiaryController, RecordareWebhookController],
  providers: [RecordareIdentityService, RecordareOutboxService, RecordareMessageSubscriber, RecordareMcpService, RecordareNotesSyncService,
    RecordareInitiativesService],
  exports: [RecordareIdentityService, RecordareMcpService],
})
export class RecordareModule {}
