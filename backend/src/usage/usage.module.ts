// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../messages/messages.entity';
import { LlmConfigEntity } from '../llm-configs/llm-config.entity';
import { UsageService } from './usage.service';
import { LlmCall } from './llm-call.entity';
import { LlmMetricsService } from './llm-metrics.service';
import { LlmDispatcherService } from './llm-dispatcher.service';
import { UsageController } from './usage.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Message, LlmConfigEntity, LlmCall])],
  providers: [UsageService, LlmMetricsService, LlmDispatcherService],
  controllers: [UsageController],
  exports: [UsageService, LlmMetricsService, LlmDispatcherService],
})
export class UsageModule {}
