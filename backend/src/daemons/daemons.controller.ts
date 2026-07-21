/**
 * @file daemons.controller.ts
 *
 * REST controller for managing skill daemons.
 *
 * All endpoints require JWT authentication.
 *
 * Endpoints:
 *   GET    /api/daemons            — list the user's daemons
 *   POST   /api/daemons            — start a new daemon
 *   GET    /api/daemons/:id        — daemon detail
 *   POST   /api/daemons/:id/restart — restart daemon
 *   DELETE /api/daemons/:id        — stop daemon
 *   DELETE /api/daemons/:id/record — delete record (only if stopped/error)
 */
import {
  Controller, Get, Post, Delete, Param, Body,
  UseGuards, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

import { JwtAuthGuard }   from '../common/guards/jwt-auth.guard';
import { CurrentUser }    from '../common/decorators/current-user.decorator';
import { DaemonsService } from './daemons.service';

class StartDaemonDto {
  @IsUUID()
  skillId: string;

  @IsString()
  scriptFilename: string;
}

@ApiTags('daemons')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/daemons')
export class DaemonsController {
  private readonly logger = new Logger(DaemonsController.name);

  constructor(private readonly daemonsSvc: DaemonsService) {}

  @Get()
  @ApiOperation({ summary: 'List the user\'s daemons' })
  findAll(@CurrentUser() user: any) {
    return this.daemonsSvc.findAll(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Daemon detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.daemonsSvc.findOne(id, user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Start a new daemon' })
  @HttpCode(HttpStatus.CREATED)
  start(@Body() dto: StartDaemonDto, @CurrentUser() user: any) {
    return this.daemonsSvc.start(user.id, dto.skillId, dto.scriptFilename);
  }

  @Post(':id/restart')
  @ApiOperation({ summary: 'Restart a daemon' })
  @HttpCode(HttpStatus.OK)
  restart(@Param('id') id: string, @CurrentUser() user: any) {
    return this.daemonsSvc.restart(id, user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Stop a daemon' })
  @HttpCode(HttpStatus.OK)
  stop(@Param('id') id: string, @CurrentUser() user: any) {
    return this.daemonsSvc.stop(id, user.id);
  }

  @Delete(':id/record')
  @ApiOperation({ summary: 'Delete a daemon record (only if stopped/error)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.daemonsSvc.remove(id, user.id);
  }
}
