import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { Skill } from './skill.entity';
import { SkillScript } from './skill-script.entity';
import { SkillProjectAssignment } from './skill-project-assignment.entity';
import { SkillConfigVar } from './skill-config-var.entity';
import { SkillExecutorClient } from './skill-executor.client';
import { SkillsService } from './skills.service';
import { EgressSyncService } from './egress-sync.service';
import { SkillsController } from './skills.controller';
import { InternalSkillsController } from './internal-skills.controller';
import { RegistryService } from './registry.service';
import { TeamsModule } from '../teams/teams.module';
import { ProjectsModule } from '../projects/projects.module';
import { AuditModule } from '../audit/audit.module';
import { FilesModule } from '../files/files.module';
import { AppConfigModule } from '../app-config/app-config.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Skill, SkillScript, SkillProjectAssignment, SkillConfigVar]),
    ConfigModule,
    TeamsModule,
    ProjectsModule,
    AuditModule,
    FilesModule,
    AppConfigModule,   // LlmProviderService for the descriptive→typed compilation (S3)
    NotificationsModule, // compile-to-tool suggestion to the owner (recordSandboxUse)
  ],
  providers: [
    SkillExecutorClient,
    SkillsService,
    EgressSyncService,
    RegistryService,
  ],
  controllers: [SkillsController, InternalSkillsController],
  exports: [SkillsService, SkillExecutorClient],
})
export class SkillsModule {}
