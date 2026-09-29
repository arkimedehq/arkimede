// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TtsService } from './tts.service';

@ApiTags('tts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/tts')
export class TtsController {
  constructor(private readonly service: TtsService) {}

  /**
   * GET /api/tts/status — indicates whether read-aloud is available.
   * Accessible to every authenticated user: the frontend uses it to show or
   * hide the read-aloud button in chat.
   */
  @Get('status')
  @ApiOperation({ summary: 'Text-to-speech status (enabled/disabled)' })
  async status(): Promise<{ enabled: boolean }> {
    return { enabled: await this.service.isEnabled() };
  }
}
