// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { LlmConfigsModule } from '../llm-configs/llm-configs.module';
import { OcrService } from './ocr.service';
import { OcrAdminController, OcrController } from './ocr.controller';

/**
 * Document OCR levels. Reads its settings straight from the app_config row
 * (not via AppConfigModule, which would close a module cycle through
 * EmbedModule → FilesModule → OcrModule).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppConfigEntity]), LlmConfigsModule],
  providers: [OcrService],
  controllers: [OcrController, OcrAdminController],
  exports: [OcrService],
})
export class OcrModule {}
