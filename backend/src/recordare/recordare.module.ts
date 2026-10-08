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

/**
 * Recordare as the users' episodic memory (opt-in: RECORDARE_URL + RECORDARE_API_KEY,
 * then per user `episodicMemoryEnabled`). Identity mapping, ingest outbox (subscriber
 * + worker), the recall tools and the user's Diary (read API proxy). Everything is a
 * no-op when not configured.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [RecordareDiaryController],
  providers: [RecordareIdentityService, RecordareOutboxService, RecordareMessageSubscriber, RecordareMcpService],
  exports: [RecordareIdentityService, RecordareMcpService],
})
export class RecordareModule {}
