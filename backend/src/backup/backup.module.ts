// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

@Module({
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
