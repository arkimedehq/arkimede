// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AgentsModule } from '../agents/agents.module';
import { OpenAiCompatController } from './openai-compat.controller';

/**
 * OpenAI-compatible surface over the agent pipeline (chat/completions +
 * models). Stateless by design: external conversation clients keep the
 * dialogue window and resend it each turn. See openai-compat.controller.ts.
 */
@Module({
  imports: [AgentModule, AgentsModule],
  controllers: [OpenAiCompatController],
})
export class OpenAiCompatModule {}
