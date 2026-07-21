import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { ToolSelectionService } from './tool-selection.service';
import { EmbedModule } from '../embed/embed.module';
import { CustomToolsModule } from '../custom-tools/custom-tools.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { AppConfigModule } from '../app-config/app-config.module';
import { SkillsModule } from '../skills/skills.module';
import { VectorDbModule } from '../vector-db/vector-db.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { UserMemoryModule } from '../user-memory/user-memory.module';
import { FlowsModule } from '../flows/flows.module';
import { AgentsModule } from '../agents/agents.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { User } from '../users/users.entity';
import { Project } from '../projects/projects.entity';
import { Chat } from '../chats/chats.entity';

@Module({
  imports: [
    EmbedModule,
    CustomToolsModule,
    McpServersModule,
    AppConfigModule,
    VectorDbModule,
    SkillsModule,
    FeedbackModule,
    UserMemoryModule,
    FlowsModule,
    AgentsModule,        // agenti/team esposti come tool (exposeAsTool)
    SchedulingModule,
    SandboxModule,
    TypeOrmModule.forFeature([User, Project, Chat]),
  ],
  providers: [AgentService, ToolSelectionService],
  controllers: [AgentController],
  exports: [AgentService],
})
export class AgentModule {}

