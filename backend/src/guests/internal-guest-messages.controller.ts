// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { InternalTokenGuard } from '../common/guards/internal-token.guard';
import { GuestMessagesService } from './guest-messages.service';

class GuestMessageDto {
  /** The user channel's name (SKILL.md `user-channel.channel`, e.g. `telegram`). */
  @IsString() @Matches(/^[a-z][a-z0-9_-]{1,39}$/)
  channel: string;

  /** The guest's id on the channel (a Telegram user id). */
  @IsString() @Length(1, 200)
  externalId: string;

  @IsOptional() @IsString() @Length(0, 200)
  displayName?: string;

  @IsString() @Length(1, 8_000)
  text: string;

  /** The skill's word that this guest is an authorized contact (a dedicated account's): the agent may act for them. */
  @IsOptional() @IsBoolean()
  authorized?: boolean;
}

/**
 * `POST /internal/guests/message` — a skill's daemon hands over a guest's message (a contact of the account writing on
 * a messaging channel) and gets the agent's answer to send back. Only with a signed DAEMON token (owner + daemon id):
 * the account the turn runs as is the daemon's owner, never a field of the request.
 */
@UseGuards(InternalTokenGuard)
@Controller('internal/guests')
export class InternalGuestMessagesController {
  constructor(private readonly guests: GuestMessagesService) {}

  @Post('message')
  @HttpCode(HttpStatus.OK)
  async message(
    @Body() dto: GuestMessageDto,
    @Req() req: { internalAuth?: { sub?: string; did?: string } },
  ): Promise<{ answer: string; chatId: string }> {
    const userId = req.internalAuth?.sub;
    const daemonId = req.internalAuth?.did;
    if (!userId || !daemonId) throw new ForbiddenException('A daemon token is required');
    return this.guests.handle(userId, daemonId, dto);
  }
}
