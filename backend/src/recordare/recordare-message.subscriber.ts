// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-message.subscriber.ts
 *
 * One hook for every persisted chat message: a TypeORM subscriber on Message
 * inserts the outbox row in the SAME transaction as the message (under a
 * savepoint — see recordare-outbox.ts). Covers every current and future
 * `save()` of a Message (chat stream, team runs, error turns, external chats,
 * automations and flows delivered into a chat) without touching those sites.
 * No-op when Recordare is not configured.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { Message } from '../messages/messages.entity';
import { enqueueRecordareMessage } from './recordare-outbox';

@Injectable()
export class RecordareMessageSubscriber implements EntitySubscriberInterface<Message> {
  constructor(@InjectDataSource() dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return Message;
  }

  async afterInsert(event: InsertEvent<Message>): Promise<void> {
    try {
      await enqueueRecordareMessage(event.queryRunner ?? event.manager, event.entity);
    } catch { /* enqueueRecordareMessage already never throws; belt and braces */ }
  }
}
