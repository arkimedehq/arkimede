// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-diary.controller.ts
 *
 * The user's Diary (Recordare D18, Arkimede Settings → Diary): what Recordare
 * remembers about them — timeline, day / month diary, facts and notes, plans, what
 * awaits confirmation — and their own edits (correct or forget an episode, pin or
 * delete a note, confirm or reject what was inferred). A thin proxy over Recordare's
 * read API (its API.md §4) through the shared client library, always for the logged-in
 * user: the browser never sees Recordare's key, and nobody reads another user's diary.
 * Recordare errors keep their status (404 stays 404); an outage is a 503.
 */
import {
  Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, Param, Patch, Post, Query, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { User } from '../users/users.entity';
import { type EpisodeQuery, type PlanStatus, RecordareHttpError, type RecordareClient } from './client';
import { recordareClient } from './recordare.config';

const ISO_DAY = /^\d{4}-\d{2}(-\d{2})?$/;

class CorrectionDto {
  @IsOptional() @IsString() @MaxLength(4000) content?: string;
  @IsOptional() @Matches(ISO_DAY) occurredAt?: string;
  @IsOptional() @IsIn(['day', 'month', 'year', 'approximate']) datePrecision?: 'day' | 'month' | 'year' | 'approximate';
}

class PinDto {
  @IsBoolean() pinned: boolean;
}

const bool = (v?: string) => (v === 'true' ? true : v === 'false' ? false : undefined);
const day = (v?: string) => (v && ISO_DAY.test(v) ? v : undefined);

@Controller('api/recordare/diary')
@UseGuards(JwtAuthGuard)
export class RecordareDiaryController {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  /** The client for the logged-in user, who must have the episodic memory switched on. */
  private async client(userId: string): Promise<RecordareClient> {
    const client = recordareClient();
    if (!client) throw new ServiceUnavailableException('recordare.notConfigured');
    const u = await this.users.findOne({ where: { id: userId }, select: { id: true, episodicMemoryEnabled: true } });
    if (!u?.episodicMemoryEnabled) throw new ForbiddenException('recordare.episodicMemoryOff');
    return client;
  }

  /** Runs a Recordare call, keeping its status (404 stays 404) and turning an outage into a 503. */
  private async call<T>(userId: string, fn: (c: RecordareClient) => Promise<T>): Promise<T> {
    const client = await this.client(userId);
    try {
      return await fn(client);
    } catch (err) {
      if (err instanceof RecordareHttpError && err.status < 500) throw new HttpException(err.problem.code ?? 'recordare.error', err.status);
      throw new ServiceUnavailableException('recordare.unavailable');
    }
  }

  @Get('episodes')
  episodes(@CurrentUser() user: User, @Query('from') from?: string, @Query('to') to?: string, @Query('kind') kind?: string,
    @Query('planStatus') planStatus?: string, @Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const query: EpisodeQuery = {
      from: day(from), to: day(to),
      ...(kind ? { kind: kind as EpisodeQuery['kind'] } : {}),
      ...(planStatus ? { planStatus: planStatus as PlanStatus } : {}),
      ...(q?.trim() ? { q: q.trim().slice(0, 500) } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit && Number(limit) > 0 ? { limit: Math.min(Number(limit), 200) } : {}),
    };
    return this.call(user.id, (c) => c.episodes(user.id, query));
  }

  @Get('episodes/:id')
  episode(@CurrentUser() user: User, @Param('id') id: string) {
    return this.call(user.id, (c) => c.episode(user.id, id));
  }

  @Post('episodes/:id/corrections')
  async correct(@CurrentUser() user: User, @Param('id') id: string, @Body() body: CorrectionDto) {
    return { id: await this.call(user.id, (c) => c.correctEpisode(user.id, id, body)) };
  }

  @Delete('episodes/:id')
  @HttpCode(204)
  async forget(@CurrentUser() user: User, @Param('id') id: string) {
    await this.call(user.id, (c) => c.forgetEpisode(user.id, id));
  }

  @Get('digests')
  digests(@CurrentUser() user: User, @Query('level') level?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const lv = level === 'day' || level === 'month' ? level : undefined;
    return this.call(user.id, (c) => c.digests(user.id, { level: lv, from: day(from), to: day(to) }));
  }

  @Get('facts')
  facts(@CurrentUser() user: User, @Query('asOf') asOf?: string, @Query('includePending') includePending?: string) {
    return this.call(user.id, (c) => c.facts(user.id, { asOf: day(asOf), includePending: bool(includePending) }));
  }

  @Get('notes')
  notes(@CurrentUser() user: User, @Query('includePending') includePending?: string) {
    return this.call(user.id, (c) => c.notes(user.id, { includePending: bool(includePending) }));
  }

  @Get('plans')
  plans(@CurrentUser() user: User) {
    return this.call(user.id, (c) => c.plans(user.id));
  }

  @Patch('notes/:id')
  @HttpCode(204)
  async pin(@CurrentUser() user: User, @Param('id') id: string, @Body() body: PinDto) {
    await this.call(user.id, (c) => c.pinNote(user.id, id, body.pinned));
  }

  @Delete(':what/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: User, @Param('what') what: string, @Param('id') id: string) {
    if (what !== 'notes' && what !== 'facts') throw new ForbiddenException();
    await this.call(user.id, (c) => c.delete(user.id, what, id));
  }

  @Post(':what/:id/:decision')
  @HttpCode(204)
  async decide(@CurrentUser() user: User, @Param('what') what: string, @Param('id') id: string, @Param('decision') decision: string) {
    if ((what !== 'notes' && what !== 'facts') || (decision !== 'confirm' && decision !== 'reject')) throw new ForbiddenException();
    await this.call(user.id, (c) => c.decide(user.id, what, id, decision));
  }
}
