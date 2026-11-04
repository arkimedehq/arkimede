// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/users.entity';
import { UserMemoryModule } from '../user-memory/user-memory.module';
import { RecordareModule } from '../recordare/recordare.module';
import { AgentMemoryService } from './agent-memory.service';

/** The agent's memory (Recordare, else A-MEM) for every agent run: chat, voice, automations, delegates, team members. */
@Module({
  imports: [TypeOrmModule.forFeature([User]), UserMemoryModule, RecordareModule],
  providers: [AgentMemoryService],
  exports: [AgentMemoryService],
})
export class AgentMemoryModule {}
