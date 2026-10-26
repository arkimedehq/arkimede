// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chat } from './chats.entity';
import { ChatsService } from './chats.service';
import { ExternalChatsService } from './external-chats.service';
import { Message } from '../messages/messages.entity';
import { ChatsController } from './chats.controller';
import { ExternalChatsController } from './external-chats.controller';
import { ConversationFocusService } from './conversation-focus.service';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [TypeOrmModule.forFeature([Chat, Message]), ProjectsModule],
  providers: [ChatsService, ExternalChatsService, ConversationFocusService],
  controllers: [ChatsController, ExternalChatsController],
  exports: [ChatsService, ExternalChatsService, ConversationFocusService],
})
export class ChatsModule {}
