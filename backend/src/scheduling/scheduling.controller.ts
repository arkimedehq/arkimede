/**
 * @file scheduling.controller.ts
 *
 * REST for **automations** (Auto-Scheduling).
 *   GET    /api/scheduled-tasks            → my automations
 *   POST   /api/scheduled-tasks/:id/run     → run now, out of schedule
 *   PATCH  /api/scheduled-tasks/:id/enabled → enable/disable
 *   DELETE /api/scheduled-tasks/:id        → delete
 */
import {
  Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SchedulingService } from './scheduling.service';

class ToggleDto {
  @IsBoolean() enabled: boolean;
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
