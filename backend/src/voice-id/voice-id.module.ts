// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VoiceProfile } from './voice-profile.entity';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { User } from '../users/users.entity';
import { RecordareModule } from '../recordare/recordare.module';
import { VoiceIdService } from './voice-id.service';
import { VoiceIdController } from './voice-id.controller';

/** Who spoke to a satellite, from the voice (opt-in): used by the Wyoming server. */
@Module({
  imports: [TypeOrmModule.forFeature([VoiceProfile, AppConfigEntity, User]), RecordareModule],
  controllers: [VoiceIdController],
  providers: [VoiceIdService],
  exports: [VoiceIdService],
})
export class VoiceIdModule {}
