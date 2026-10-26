// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file external-chats.controller.ts
 *
 * Conversation focus of external satellites (conversation-focus.service.ts):
 * PUT sets the chat a satellite's turns go into, DELETE ends it, GET lists the
 * caller's. The chat must be the caller's own; the focus is the caller's
 * (the user the entry point runs as, e.g. the voice user with its API key).
 */
import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatsService } from './chats.service';
import {
  ConversationFocusService, FOCUS_DEFAULT_TTL_MS, FOCUS_MAX_TTL_MS, SATELLITE_MAX, satelliteName,
} from './conversation-focus.service';

class SetFocusDto {
  @IsString() @MinLength(1) @MaxLength(SATELLITE_MAX) satellite: string;
  @IsUUID() chatId: string;
  @IsOptional() @IsInt() @Min(1) @Max(FOCUS_MAX_TTL_MS / 1000) ttlSeconds?: number;
}

@ApiTags('chats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/external-chats/focus')
export class ExternalChatsController {
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(ConversationFocusService) private readonly focus: ConversationFocusService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The caller's satellite focuses" })
  list(@CurrentUser() user: any) {
    return this.focus.list(user.id);
  }

  @Put()
  @ApiOperation({ summary: "Send a satellite's turns into one of the caller's chats (refresh before it expires)" })
  async set(@Body() dto: SetFocusDto, @CurrentUser() user: any) {
    await this.chats.findOneAsAuthor(dto.chatId, user.id);
    const satellite = satelliteName(dto.satellite)!;
    return this.focus.set(user.id, satellite, dto.chatId, dto.ttlSeconds ? dto.ttlSeconds * 1000 : FOCUS_DEFAULT_TTL_MS);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "End a satellite's focus: its next turn starts a new conversation" })
  clear(@Query('satellite') satellite: string, @CurrentUser() user: any) {
    const name = satelliteName(satellite);
    if (name) this.focus.clear(user.id, name);
  }
}
