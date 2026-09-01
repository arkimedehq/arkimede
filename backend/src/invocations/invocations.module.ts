// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentInvocation } from './invocation.entity';
import { User } from '../users/users.entity';
import { InvocationsService } from './invocations.service';
import { InvocationsController } from './invocations.controller';

/**
 * External-invocation log: records agent calls made from OUTSIDE the chat UI
 * (OpenAI-compat shim today). Exported so the surfaces that serve those calls
 * (OpenAiCompatModule) can record into it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AgentInvocation, User])],
  providers: [InvocationsService],
  controllers: [InvocationsController],
  exports: [InvocationsService],
})
export class InvocationsModule {}
