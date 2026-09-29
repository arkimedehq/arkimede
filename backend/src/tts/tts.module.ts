// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module, forwardRef } from '@nestjs/common';
import { TtsService } from './tts.service';
import { TtsController } from './tts.controller';
import { AppConfigModule } from '../app-config/app-config.module';

/**
 * Text-to-speech module (Piper / OpenAI-compatible providers).
 *
 * Own controller only for `GET /api/tts/status` (read-aloud button visibility):
 * the synthesis surface is the OpenAI-compatible `POST /api/openai/v1/audio/speech`
 * route (openai-compat module); the admin config endpoints live in AppConfigController.
 *
 * forwardRef on AppConfigModule: TtsService reads the config from
 * AppConfigService, and AppConfigController injects TtsService for the
 * admin endpoints (config + test) → circular dependency resolved with
 * forwardRef, same pattern as TranscriptionModule ↔ AppConfigModule.
 */
@Module({
  imports: [forwardRef(() => AppConfigModule)],
  providers: [TtsService],
  controllers: [TtsController],
  exports: [TtsService],
})
export class TtsModule {}
