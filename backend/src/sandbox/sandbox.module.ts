import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SandboxService } from './sandbox.service';
import { AppConfigModule } from '../app-config/app-config.module';
import { TeamsModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { ChatsModule } from '../chats/chats.module';
import { FilesModule } from '../files/files.module';
import { Message } from '../messages/messages.entity';
import { SkillExecutorClient } from '../skills/skill-executor.client';
import { SandboxController } from './sandbox.controller';

/**
 * Sandbox capability module. Provides SkillExecutorClient locally
 * (depends only on ConfigService); SkillsModule is used to stage the descriptive
 * skills in the workspace; ChatsModule for scoping the file download; FilesModule
 * + the Message repository to stage the chat attachments into inputs/.
 */
@Module({
  imports: [ConfigModule, AppConfigModule, TeamsModule, SkillsModule, ChatsModule, FilesModule, TypeOrmModule.forFeature([Message])],
  providers: [SandboxService, SkillExecutorClient],
  controllers: [SandboxController],
  exports: [SandboxService],
})
export class SandboxModule {}
