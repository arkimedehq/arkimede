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
import { AppConfigModule } from '../app-config/app-config.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ChatsModule } from '../chats/chats.module';
import { RecordareModule } from '../recordare/recordare.module';
import { HomeAssistantService } from './home-assistant.service';
import { HomeAssistantController } from './home-assistant.controller';

/**
 * Home Assistant as a native integration (opt-in, admin settings): the agent's `ha_*` tools (a native tool source),
 * presence impulses to Recordare, the initiatives said on the voice satellites. Imported only by AppModule; it
 * registers itself with the tool sources and with the initiatives (their voice channel), so neither imports it.
 */
@Module({
  imports: [AppConfigModule, McpServersModule, ChatsModule, RecordareModule, ToolSourcesModule, FilesModule, FlowsModule, TypeOrmModule.forFeature([User])],
  controllers: [HomeAssistantController],
  providers: [HomeAssistantService, HaToolsService, HaTriggersService],
})
export class HomeAssistantModule {}
