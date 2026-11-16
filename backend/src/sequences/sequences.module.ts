// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SequencesService } from './sequences.service';
import { SequencesController } from './sequences.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { Message } from '../messages/messages.entity';
import { Chat } from '../chats/chats.entity';
import { User } from '../users/users.entity';

/** Sequences: timed tool calls run without a model in the loop (specs/RUN_SEQUENCE.md). */
@Module({
  imports: [TypeOrmModule.forFeature([Message, Chat, User]), NotificationsModule],
  providers: [SequencesService],
  controllers: [SequencesController],
  exports: [SequencesService],
})
export class SequencesModule {}
