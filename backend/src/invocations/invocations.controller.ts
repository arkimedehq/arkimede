// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { InvocationsService } from './invocations.service';

@ApiTags('invocations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/invocations')
export class InvocationsController {
  constructor(private readonly service: InvocationsService) {}

  /**
   * GET /api/invocations — the caller's external-invocation log, newest first.
   * `all=1` (admins only, silently ignored otherwise) lists every user's rows.
   */
  @Get()
  @ApiOperation({ summary: 'External agent invocation log (own; admin: all users)' })
  list(
    @CurrentUser() user: any,
    @Query('all') all?: string,
    @Query('origin') origin?: string,
    @Query('route') route?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.findAll(user.id, {
      all: all === '1' && user.role === 'admin',
      origin: origin || undefined,
      route: route || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }
}
