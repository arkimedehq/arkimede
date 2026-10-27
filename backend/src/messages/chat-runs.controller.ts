// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatsService } from '../chats/chats.service';
import { ChatRunsService } from './chat-runs.service';

/**
 * The agent run in progress in a chat (ChatRunsService). Same access as sending a
 * message: the chat's author, or the owner/collaborators of its project.
 */
@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/chats/:chatId/run')
export class ChatRunsController {
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(ChatRunsService) private readonly runs: ChatRunsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The agent run in progress in the chat (null when idle)' })
  async get(@Param('chatId', ParseUUIDPipe) chatId: string, @CurrentUser() user: any) {
    await this.chats.findOneForWrite(chatId, user.id);
    return { run: this.runs.get(chatId) };
  }

  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the agent run in progress in the chat' })
  async cancel(@Param('chatId', ParseUUIDPipe) chatId: string, @CurrentUser() user: any) {
    await this.chats.findOneForWrite(chatId, user.id);
    return { cancelled: this.runs.cancel(chatId) };
  }
}
