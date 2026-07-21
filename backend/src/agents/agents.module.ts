import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from './agent.entity';
import { AgentTeam } from './agent-team.entity';
import { AgentTeamMember } from './agent-team-member.entity';
import { AgentsService } from './agents.service';
import { AgentTeamsService } from './agent-teams.service';
import { MultiAgentService } from './multi-agent.service';
import { AgentsController, AgentTeamsController } from './agents.controller';
import { TeamsModule } from '../teams/teams.module';
import { CustomToolsModule } from '../custom-tools/custom-tools.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { SkillsModule } from '../skills/skills.module';
import { FlowsModule } from '../flows/flows.module';
import { LlmConfigsModule } from '../llm-configs/llm-configs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Agent, AgentTeam, AgentTeamMember]),
    TeamsModule,
    CustomToolsModule,   // agent tools
    McpServersModule,
    SkillsModule,
    FlowsModule,
    LlmConfigsModule,    // per-agent model
  ],
  providers: [AgentsService, AgentTeamsService, MultiAgentService],
  controllers: [AgentsController, AgentTeamsController],
  exports: [AgentsService, AgentTeamsService, MultiAgentService],
})
export class AgentsModule {}
