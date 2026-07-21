import { Module, forwardRef } from '@nestjs/common';
import { TranscriptionService } from './transcription.service';
import { TranscriptionController } from './transcription.controller';
import { AppConfigModule } from '../app-config/app-config.module';

/**
 * Voice transcription module (Whisper).
 *
 * forwardRef on AppConfigModule: TranscriptionService reads the config from
 * AppConfigService, and AppConfigController injects TranscriptionService for the
 * admin endpoints (config + test) → circular dependency resolved with forwardRef,
 * same pattern as EmbedModule ↔ AppConfigModule.
 */
@Module({
  imports: [forwardRef(() => AppConfigModule)],
  providers: [TranscriptionService],
  controllers: [TranscriptionController],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
