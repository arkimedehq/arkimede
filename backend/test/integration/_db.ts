/**
 * Integration helper: starts an ephemeral PostgreSQL (testcontainers) and
 * builds its real schema via TypeORM `synchronize`.
 *
 * The ENTIRE set of entities is registered (the same as `app.module`) because
 * the relations graph must be complete: the FK `custom_tools.userId → users.id`
 * and `User`'s inverse relations require all related entities to be known to
 * TypeORM. The `*.entity.ts` glob does not work here (TypeORM would `require`
 * untranspiled code) → explicit imports.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { User } from '../../src/users/users.entity';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Chat } from '../../src/chats/chats.entity';
import { Message } from '../../src/messages/messages.entity';
import { File as FileEntity } from '../../src/files/files.entity';
import { CustomTool } from '../../src/custom-tools/custom-tool.entity';
import { ToolSecret } from '../../src/custom-tools/tool-secret.entity';
import { McpServer } from '../../src/mcp-servers/mcp-server.entity';
import { McpServerSecret } from '../../src/mcp-servers/mcp-server-secret.entity';
import { DataSourceEntity } from '../../src/datasources/datasource.entity';
import { AppConfigEntity } from '../../src/app-config/app-config.entity';
import { LlmConfigEntity } from '../../src/llm-configs/llm-config.entity';
import { VectorDbConfigEntity } from '../../src/vector-db/vector-db-config.entity';
import { VectorCollectionEntity } from '../../src/vector-db/vector-collection.entity';
import { Skill } from '../../src/skills/skill.entity';
import { SkillScript } from '../../src/skills/skill-script.entity';
import { SkillProjectAssignment } from '../../src/skills/skill-project-assignment.entity';
import { SkillConfigVar } from '../../src/skills/skill-config-var.entity';
import { SkillDaemon } from '../../src/daemons/skill-daemon.entity';
import { Notification } from '../../src/notifications/notification.entity';
import { Feedback } from '../../src/feedback/feedback.entity';
import { UserMemory } from '../../src/user-memory/user-memory.entity';
import { Team } from '../../src/teams/team.entity';
import { TeamMembership } from '../../src/teams/team-membership.entity';
import { Flow } from '../../src/flows/flow.entity';
import { FlowRun } from '../../src/flows/flow-run.entity';
import { Agent } from '../../src/agents/agent.entity';
import { AgentTeam } from '../../src/agents/agent-team.entity';
import { AgentTeamMember } from '../../src/agents/agent-team-member.entity';
import { ScheduledTask } from '../../src/scheduling/scheduled-task.entity';
import { AuditLog } from '../../src/audit/audit-log.entity';

export const ALL_ENTITIES = [
  User, Project, ProjectTeam, Chat, Message, FileEntity, CustomTool, ToolSecret,
  McpServer, McpServerSecret, DataSourceEntity, AppConfigEntity, LlmConfigEntity,
  VectorDbConfigEntity, VectorCollectionEntity, Skill, SkillScript,
  SkillProjectAssignment, SkillConfigVar, SkillDaemon, Notification, Feedback,
  UserMemory, Team, TeamMembership, Flow, FlowRun, Agent, AgentTeam,
  AgentTeamMember, ScheduledTask, AuditLog,
];

export interface TestDb {
  container: StartedPostgreSqlContainer;
  dataSource: DataSource;
  stop: () => Promise<void>;
}

/** Starts the container, creates the uuid extension and synchronizes the schema. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const dataSource = new DataSource({
    type: 'postgres',
    url: container.getConnectionUri(),
    entities: ALL_ENTITIES,
    synchronize: false,
  });

  await dataSource.initialize();
  // `@PrimaryGeneratedColumn('uuid')` uses uuid_generate_v4() → uuid-ossp is
  // needed BEFORE creating the tables.
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await dataSource.synchronize();

  return {
    container,
    dataSource,
    stop: async () => {
      await dataSource.destroy();
      await container.stop();
    },
  };
}
