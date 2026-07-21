import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { ChatsModule } from './chats/chats.module';
import { MessagesModule } from './messages/messages.module';
import { FilesModule } from './files/files.module';
import { AgentModule } from './agent/agent.module';
import { EmbedModule } from './embed/embed.module';
import { CustomToolsModule } from './custom-tools/custom-tools.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { DataSourcesModule } from './datasources/datasources.module';
import { AppConfigModule } from './app-config/app-config.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { VectorDbModule } from './vector-db/vector-db.module';
import { SkillsModule } from './skills/skills.module';
import { DaemonsModule } from './daemons/daemons.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FeedbackModule } from './feedback/feedback.module';
import { UserMemoryModule } from './user-memory/user-memory.module';
import { UsageModule } from './usage/usage.module';
import { User } from './users/users.entity';
import { Project } from './projects/projects.entity';
import { ProjectTeam } from './projects/project-team.entity';
import { Chat } from './chats/chats.entity';
import { Message } from './messages/messages.entity';
import { File as FileEntity } from './files/files.entity';
import { CustomTool } from './custom-tools/custom-tool.entity';
import { ToolSecret } from './custom-tools/tool-secret.entity';
import { McpServer } from './mcp-servers/mcp-server.entity';
import { McpServerSecret } from './mcp-servers/mcp-server-secret.entity';
import { DataSourceEntity } from './datasources/datasource.entity';
import { AppConfigEntity } from './app-config/app-config.entity';
import { LlmConfigEntity } from './llm-configs/llm-config.entity';
import { VectorDbConfigEntity } from './vector-db/vector-db-config.entity';
import { VectorCollectionEntity } from './vector-db/vector-collection.entity';
import { Skill } from './skills/skill.entity';
import { SkillScript } from './skills/skill-script.entity';
import { SkillProjectAssignment } from './skills/skill-project-assignment.entity';
import { SkillConfigVar } from './skills/skill-config-var.entity';
import { SkillDaemon } from './daemons/skill-daemon.entity';
import { Notification } from './notifications/notification.entity';
import { Feedback } from './feedback/feedback.entity';
import { UserMemory } from './user-memory/user-memory.entity';
import { TeamsModule } from './teams/teams.module';
import { Team } from './teams/team.entity';
import { TeamMembership } from './teams/team-membership.entity';
import { FlowsModule } from './flows/flows.module';
import { Flow } from './flows/flow.entity';
import { FlowRun } from './flows/flow-run.entity';
import { AgentsModule } from './agents/agents.module';
import { Agent } from './agents/agent.entity';
import { AgentTeam } from './agents/agent-team.entity';
import { AgentTeamMember } from './agents/agent-team-member.entity';
import { SchedulingModule } from './scheduling/scheduling.module';
import { ScheduledTask } from './scheduling/scheduled-task.entity';
import { ActivityModule } from './activity/activity.module';
import { AuditModule } from './audit/audit.module';
import { AuditLog } from './audit/audit-log.entity';
import { LlmCall } from './usage/llm-call.entity';
import { HealthModule } from './health/health.module';
import { BackupModule } from './backup/backup.module';
import { I18nModule, AcceptLanguageResolver, QueryResolver } from 'nestjs-i18n';

@Module({
  imports: [
    // SINGLE .env at the repo root. In dev (cwd=backend) → ../.env; fallback to
    // ./.env. In Docker the variables already arrive from the compose's
    // `env_file`/`environment` (process.env), so the file's absence is not a problem.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(process.cwd(), '..', '.env'), join(process.cwd(), '.env')],
    }),
    // i18n of the error messages: language from the request (Accept-Language header,
    // set by the frontend; ?lang= as a fallback for tests). Files in src/i18n/<lang>/*.json.
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: { path: join(__dirname, '/i18n/'), watch: true },
      resolvers: [new QueryResolver(['lang']), AcceptLanguageResolver],
    }),
    // Rate limiting (global module). A lenient default; the auth routes apply a
    // strict per-IP limit via @Throttle to blunt credential brute-force / spam.
    // NOTE: in-memory store — for a multi-instance deployment behind a LB, back it
    // with a shared store (e.g. Redis) so the limit is enforced across replicas.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        host: cfg.get('DB_HOST', 'localhost'),
        port: cfg.get<number>('DB_PORT', 5432),
        username: cfg.get('DB_USER', 'postgres'),
        password: cfg.get('DB_PASSWORD', 'postgres'),
        database: cfg.get('DB_NAME', 'arkimede'),
        entities: [User, Project, ProjectTeam, Chat, Message, FileEntity, CustomTool, ToolSecret, McpServer, McpServerSecret, DataSourceEntity, AppConfigEntity, LlmConfigEntity, VectorDbConfigEntity, VectorCollectionEntity, Skill, SkillScript, SkillProjectAssignment, SkillConfigVar, SkillDaemon, Notification, Feedback, UserMemory, Team, TeamMembership, Flow, FlowRun, Agent, AgentTeam, AgentTeamMember, ScheduledTask, AuditLog, LlmCall],
        // Automatic migrations at startup — never use synchronize alongside
        synchronize: false,
        migrations: [join(__dirname, 'database/migrations/*.{ts,js}')],
        migrationsRun: true,
        logging: ['error', 'migration'],
      }),
    }),
    AuthModule,
    UsersModule,
    ProjectsModule,
    ChatsModule,
    MessagesModule,
    FilesModule,
    AgentModule,
    EmbedModule,
    CustomToolsModule,
    McpServersModule,
    DataSourcesModule,
    AppConfigModule,
    TranscriptionModule,
    VectorDbModule,
    SkillsModule,
    DaemonsModule,
    NotificationsModule,
    FeedbackModule,
    UserMemoryModule,
    UsageModule,
    TeamsModule,
    FlowsModule,
    AgentsModule,
    SchedulingModule,
    ActivityModule,
    AuditModule,
    HealthModule,
    BackupModule,
  ],
})
export class AppModule {}
