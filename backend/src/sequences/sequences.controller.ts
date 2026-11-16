// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SequencesService } from './sequences.service';

/** The user's running sequences (run_sequence): list and stop. A sequence is its user's only. */
@ApiTags('sequences')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/sequences')
export class SequencesController {
  constructor(@Inject(SequencesService) private readonly sequences: SequencesService) {}

  @Get()
  @ApiOperation({ summary: 'The user\'s running sequences, optionally those started from one chat' })
  @ApiQuery({ name: 'chatId', required: false })
  list(@CurrentUser() user: any, @Query('chatId') chatId?: string) {
    const all = this.sequences.list(user.id);
    return { sequences: chatId ? all.filter((s) => s.chatId === chatId) : all };
  }

  @Post('stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop all the user\'s running sequences (each runs its finally)' })
  stopAll(@CurrentUser() user: any) {
    return { stopped: this.sequences.stop(user.id) };
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop one of the user\'s running sequences (it runs its finally)' })
  stop(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return { stopped: this.sequences.stop(user.id, id) };
  }
}
