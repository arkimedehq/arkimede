// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file scheduling.controller.ts
 *
 * REST for **automations** (Auto-Scheduling).
 *   GET    /api/scheduled-tasks            → my automations
 *   GET    /api/scheduled-tasks/limits     → global limits (default token cap)
 *   PATCH  /api/scheduled-tasks/:id        → edit (instruction, schedule, tools, token cap)
 *   POST   /api/scheduled-tasks/:id/run     → run now, out of schedule
 *   PATCH  /api/scheduled-tasks/:id/enabled → enable/disable
 *   DELETE /api/scheduled-tasks/:id        → delete
 */
import {
  Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsOptional, IsString, IsIn, IsArray, IsInt, Min, MaxLength, ValidateIf, ValidateNested,
} from 'class-validator';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SchedulingService } from './scheduling.service';

class ToggleDto {
  @IsBoolean() enabled: boolean;
}

class ToolFilterDto {
  @IsIn(['all', 'names', 'none']) mode: 'all' | 'names' | 'none';
  @IsOptional() @IsArray() @IsString({ each: true }) names?: string[];
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() instruction?: string;
  @IsOptional() @IsString() @MaxLength(120) cron?: string;
  @IsOptional() @IsString() runAt?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string | null;
  @IsOptional() @ValidateNested() @Type(() => ToolFilterDto) toolFilter?: ToolFilterDto;
  /** null = global default, absent = unchanged; validated only when a value is sent. */
  @ValidateIf((o) => o.maxTokensPerRun != null) @IsInt() @Min(0) maxTokensPerRun?: number | null;
}

@ApiTags('scheduled-tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/scheduled-tasks')
export class SchedulingController {
  constructor(private readonly service: SchedulingService) {}

  @Get()
  @ApiOperation({ summary: 'Le mie automazioni programmate' })
  list(@CurrentUser() user: any) {
    return this.service.list(user.id);
  }

  @Get('limits')
  @ApiOperation({ summary: 'Limiti globali delle automazioni (cap token di default)' })
  limits() {
    return this.service.limits();
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifica un\'automazione' })
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    return this.service.update(id, user.id, user.role === 'admin', dto);
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Attiva un\'automazione in attesa di conferma' })
  activate(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.activate(id, user.id);
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Esegue subito l\'automazione, fuori programmazione' })
  run(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.runNow(id, user.id);
  }

  @Patch(':id/enabled')
  toggle(@Param('id') id: string, @Body() dto: ToggleDto, @CurrentUser() user: any) {
    return this.service.setEnabled(id, user.id, dto.enabled);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user.id);
  }
}
