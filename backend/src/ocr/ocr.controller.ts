// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { BadRequestException, Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OcrService } from './ocr.service';
import { OCR_LEVELS, OcrLevel, ocrRank } from './ocr.types';

class UpdateOcrConfigDto {
  @IsIn(OCR_LEVELS as unknown as string[])
  defaultLevel: OcrLevel;

  @IsIn(OCR_LEVELS as unknown as string[])
  maxLevel: OcrLevel;
}

/** OCR levels offered to users (pickers in the indexing dialogs). */
@ApiTags('ocr')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/ocr')
export class OcrController {
  constructor(@Inject(OcrService) private readonly ocr: OcrService) {}

  @Get('levels')
  @ApiOperation({ summary: 'OCR levels: admin default/maximum and availability on this deployment' })
  async levels() {
    const [settings, levels] = await Promise.all([this.ocr.getSettings(), this.ocr.levelStatuses()]);
    return { ...settings, levels };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/config/ocr')
export class OcrAdminController {
  constructor(@Inject(OcrService) private readonly ocr: OcrService) {}

  @Get()
  @ApiOperation({ summary: 'OCR configuration (default and maximum level) with level availability' })
  async get() {
    const [settings, levels] = await Promise.all([this.ocr.getSettings(), this.ocr.levelStatuses()]);
    return { ...settings, levels };
  }

  @Patch()
  @ApiOperation({ summary: 'Update the default and maximum OCR level' })
  async update(@Body() dto: UpdateOcrConfigDto, @CurrentUser() user: any) {
    if (ocrRank(dto.defaultLevel) > ocrRank(dto.maxLevel)) {
      throw new BadRequestException('ocr.defaultAboveMax');
    }
    const settings = await this.ocr.updateSettings(dto, user?.id);
    return { ...settings, levels: await this.ocr.levelStatuses() };
  }
}
