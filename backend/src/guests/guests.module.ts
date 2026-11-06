// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';
import { User } from '../users/users.entity';
import { SkillDaemon } from '../daemons/skill-daemon.entity';
import { ChatsModule } from '../chats/chats.module';
import { SkillsModule } from '../skills/skills.module';
import { AgentModule } from '../agent/agent.module';
import { GuestMessagesService } from './guest-messages.service';
import { InternalGuestMessagesController } from './internal-guest-messages.controller';

/**
 * Guests: contacts of an account writing on a messaging channel a skill holds (Telegram), answered by the agent as
 * that account. Imported only by AppModule (it imports the agent and the chats, nothing imports it).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Chat, Message, SkillDaemon, User]), ChatsModule, SkillsModule, AgentModule],
  controllers: [InternalGuestMessagesController],
  providers: [GuestMessagesService],
})
export class GuestsModule {}
