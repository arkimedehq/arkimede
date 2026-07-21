import {
  Controller, Get, Query, Res, UseGuards, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatsService } from '../chats/chats.service';
import { SkillExecutorClient } from '../skills/skill-executor.client';

/**
 * Download of the files produced in the sandbox workspace (per-chat). Scoping: the
 * sandbox session_id IS the chatId, so access to the chat is verified via
 * ChatsService.findOne (throws if the user cannot access it) before reading the file.
 */
@ApiTags('sandbox')
@ApiBearerAuth()
@Controller('api/sandbox')
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(
    private readonly chats:    ChatsService,
    private readonly executor: SkillExecutorClient,
  ) {}

  @Get('file')
  @ApiOperation({ summary: 'Download a file from the sandbox workspace of a chat' })
  async file(
    @Query('chatId') chatId: string,
    @Query('path') filePath: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ): Promise<void> {
    if (!chatId || !filePath) throw new BadRequestException('chatId and path are required');
    // Access check: throws 403/404 if the user cannot access the chat.
    await this.chats.findOne(chatId, user.id);

    const file = await this.executor.getSandboxFile(chatId, filePath);
    if (!file) throw new NotFoundException('File not found in the workspace');

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    res.send(Buffer.from(file.base64, 'base64'));
  }
}
