// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './messages.entity';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { ChatsModule } from '../chats/chats.module';
import { AgentModule } from '../agent/agent.module';
import { AgentsModule } from '../agents/agents.module';
import { FilesModule } from '../files/files.module';
import { UserMemoryModule } from '../user-memory/user-memory.module';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatRunsService } from './chat-runs.service';
import { ChatRunsController } from './chat-runs.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Message]), ChatsModule, AgentModule, AgentsModule, FilesModule, UserMemoryModule, UsersModule, NotificationsModule],
  providers: [MessagesService, ChatRunsService],
  controllers: [MessagesController, ChatRunsController],
  exports: [MessagesService, ChatRunsService],
})
export class MessagesModule {}
