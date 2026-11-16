// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatsService } from '../chats/chats.service';
import { ChatRunsService } from './chat-runs.service';
import { SequencesService } from '../sequences/sequences.service';

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

/**
 * The work in progress the user can see: the agent runs in the chats they may write to (`runs`, kind `run`) and their
 * running sequences (`sequences`, kind `sequence`, stopped with POST /api/sequences/:id/stop). A client listing chats
 * (an app, a device's chats list) shows which are working — e.g. a voice turn's long work, lights blinking.
 */
@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/chat-runs')
export class ActiveChatRunsController {
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(ChatRunsService) private readonly runs: ChatRunsService,
    @Inject(SequencesService) private readonly sequences: SequencesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The work in progress: agent runs in the chats the user may write to, and the user\'s sequences' })
  async list(@CurrentUser() user: any) {
    const runs = [];
    for (const run of this.runs.list()) {
      const allowed = await this.chats.findOneForWrite(run.chatId, user.id).then(() => true, () => false);
      if (allowed) runs.push({ kind: 'run' as const, ...run });
    }
    return { runs, sequences: this.sequences.list(user.id) };
  }
}
