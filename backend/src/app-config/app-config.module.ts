import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigEntity } from './app-config.entity';
import { AppConfigService } from './app-config.service';
import { AppConfigController } from './app-config.controller';
import { LlmProviderService } from './llm-provider.service';
import { EmbedModule } from '../embed/embed.module';
import { LlmConfigsModule } from '../llm-configs/llm-configs.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { SkillExecutorClient } from '../skills/skill-executor.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppConfigEntity]),
    forwardRef(() => EmbedModule),  // forwardRef: EmbedModule uses AppConfigService → circular
    forwardRef(() => TranscriptionModule), // forwardRef: TranscriptionService uses AppConfigService → circular
    LlmConfigsModule,               // provides LlmConfigsService (used by AppConfigService and LlmProviderService)
  ],
  // SkillExecutorClient: local provider (depends only on ConfigService), used by
  // the controller to report the sandbox runtime mode (broker | in-process).
  providers: [AppConfigService, LlmProviderService, SkillExecutorClient],
  controllers: [AppConfigController],
  // Re-exports LlmConfigsModule: all modules that import AppConfigModule
  // automatically get LlmConfigsService and LlmProviderService
  exports: [AppConfigService, LlmProviderService, LlmConfigsModule],
})
export class AppConfigModule {}
