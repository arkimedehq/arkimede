// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plugin, PluginEvent, PluginIdentity, PluginKv, PluginSetting, PluginTrustedKey } from './plugin.entity';
import { Skill } from '../skills/skill.entity';
import { McpServer } from '../mcp-servers/mcp-server.entity';
import { Flow } from '../flows/flow.entity';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { Agent } from '../agents/agent.entity';
import { User } from '../users/users.entity';
import { SkillsModule } from '../skills/skills.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { FlowsModule } from '../flows/flows.module';
import { DaemonsModule } from '../daemons/daemons.module';
import { TeamsModule } from '../teams/teams.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GuestsModule } from '../guests/guests.module';
import { RecordareModule } from '../recordare/recordare.module';
import { PluginsService } from './plugins.service';
import { PluginRuntimeService } from './plugin-runtime.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginTokenGuard } from './plugin-token.guard';
import { PluginInstallsController, InternalPluginsController, PluginUiController, PluginsController } from './plugins.controller';

/**
 * Plugins (specs/PLUGINS.md): installable packages of skills, MCP servers, daemons and flows, with routes and event
 * handlers run as scripts in the executor, pages in an isolated iframe, events and core services behind approved
 * permissions. Imported only by AppModule: it builds on the primitives' modules, nothing imports it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Plugin, PluginSetting, PluginEvent, PluginKv, PluginIdentity, PluginTrustedKey, Skill, McpServer, Flow, AppConfigEntity, Agent, User]),
    SkillsModule, McpServersModule, FlowsModule, DaemonsModule, TeamsModule, NotificationsModule, GuestsModule, RecordareModule,
  ],
  controllers: [PluginsController, PluginInstallsController, PluginUiController, InternalPluginsController],
  providers: [PluginsService, PluginRuntimeService, PluginRegistryService, PluginTokenGuard],
})
export class PluginsModule {}
