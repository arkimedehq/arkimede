import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Flow } from './flow.entity';
import { FlowRun } from './flow-run.entity';
import { FlowsService } from './flows.service';
import { FlowEngineService } from './flow-engine.service';
import { FlowSchedulerService } from './flow-scheduler.service';
import { FlowsController } from './flows.controller';
import { FlowsWebhookController } from './flows-webhook.controller';
import { CustomToolsModule } from '../custom-tools/custom-tools.module';
import { LlmConfigsModule } from '../llm-configs/llm-configs.module';
import { TeamsModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';

@Module({
  imports: [
    // Chat + Message: consegna dell'esito del run come messaggio in chat (repo diretti → no cicli).
    TypeOrmModule.forFeature([Flow, FlowRun, Chat, Message]),
    CustomToolsModule,   // CustomToolsService (nodo tool)
    LlmConfigsModule,    // LlmConfigsService (nodo llm)
    TeamsModule,         // TeamsService (scoping + access sub-flow)
    SkillsModule,        // SkillsService + SkillExecutorClient (nodi skill/transform)
    NotificationsModule, // NotificationsService + NotificationsGateway (notifica + consegna esiti)
  ],
  providers: [FlowsService, FlowEngineService, FlowSchedulerService],
  controllers: [FlowsController, FlowsWebhookController],
  exports: [FlowsService, FlowEngineService],
})
export class FlowsModule {}
