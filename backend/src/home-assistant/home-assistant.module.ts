// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/users.entity';
import { ToolSourcesModule } from '../tool-sources/tool-sources.module';
import { HaToolsService } from './ha-tools.service';
import { FilesModule } from '../files/files.module';
import { FlowsModule } from '../flows/flows.module';
import { HaTriggersService } from './ha-triggers.service';
import { HaPerceptionsService } from './ha-perceptions.service';
import { AppConfigModule } from '../app-config/app-config.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ChatsModule } from '../chats/chats.module';
import { RecordareModule } from '../recordare/recordare.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HomeAssistantService } from './home-assistant.service';
import { HomeAssistantController } from './home-assistant.controller';

/**
 * Home Assistant as a native integration (opt-in, admin settings): the agent's `ha_*` tools (a native tool source),
 * presence impulses and perceptions to Recordare, the initiatives and the voice deliveries said on the voice satellites.
 * Imported only by AppModule; it registers itself with the tool sources, the initiatives and the voice delivery (their
 * voice channel), so none of them imports it.
 */
@Module({
  imports: [AppConfigModule, McpServersModule, ChatsModule, RecordareModule, NotificationsModule, ToolSourcesModule, FilesModule, FlowsModule, TypeOrmModule.forFeature([User])],
  controllers: [HomeAssistantController],
  providers: [HomeAssistantService, HaToolsService, HaTriggersService, HaPerceptionsService],
})
export class HomeAssistantModule {}
