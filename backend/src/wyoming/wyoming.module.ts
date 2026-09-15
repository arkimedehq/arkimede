// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module, forwardRef } from '@nestjs/common';
import { WyomingService } from './wyoming.service';
import { AppConfigModule } from '../app-config/app-config.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { TtsModule } from '../tts/tts.module';

/**
 * Wyoming voice server module: a TCP listener (opt-in, admin-toggled) that
 * exposes the configured STT/TTS providers to voice hubs (Home Assistant).
 *
 * No controller: the admin endpoints live in AppConfigController
 * (GET/PATCH /api/admin/config/wyoming). forwardRef on AppConfigModule for
 * the same circular reason as TtsModule/TranscriptionModule.
 */
@Module({
  imports: [
    forwardRef(() => AppConfigModule),
    forwardRef(() => TranscriptionModule),
    forwardRef(() => TtsModule),
  ],
  providers: [WyomingService],
  exports: [WyomingService],
})
export class WyomingModule {}
