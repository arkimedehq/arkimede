// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Get, Patch, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsInt, Min, Max, MaxLength, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { HostBackupService, HostBackupDestType } from './host-backup.service';
import { HOST_BACKUP_NETWORK_TYPES, HostBackupNetworkType } from './host-backup-destination';

const DEST_TYPES: HostBackupDestType[] = ['local', ...HOST_BACKUP_NETWORK_TYPES];

class HostBackupDestinationDto {
  @IsString() host: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number | null;
  @IsOptional() @IsString() share?: string | null;
  @IsOptional() @IsString() path?: string | null;
  @IsOptional() @IsString() domain?: string | null;
  @IsString() username: string;
  /** Empty/absent → keep the stored password. */
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsBoolean() secure?: boolean | null;
}

class UpdateHostBackupDto {
  /** Cron expression (minute hour day-of-month month day-of-week), host local time. */
  @IsOptional() @IsString() @MaxLength(100) schedule?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) keepDaily?: number;
  @IsOptional() @IsInt() @Min(1) @Max(52) keepBase?: number;
  @IsOptional() @IsInt() @Min(0) @Max(6) baseWeekday?: number;
  @IsOptional() @IsBoolean() walArchiving?: boolean;
  @IsOptional() @IsIn(DEST_TYPES) destType?: HostBackupDestType;
  @IsOptional() @ValidateNested() @Type(() => HostBackupDestinationDto) destination?: HostBackupDestinationDto;
}

class TestHostBackupDestinationDto {
  @IsIn(HOST_BACKUP_NETWORK_TYPES) type: HostBackupNetworkType;
  @ValidateNested() @Type(() => HostBackupDestinationDto) destination: HostBackupDestinationDto;
}

/** Settings and status of the host-level scheduled backups (scripts/backup.sh). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/backup/host')
export class HostBackupController {
  constructor(private readonly hostBackup: HostBackupService) {}

  @Get()
  @ApiOperation({ summary: 'Scheduled host backups: settings, WAL archiving state, recent runs (admin)' })
  status() {
    return this.hostBackup.getStatus();
  }

  @Patch()
  @ApiOperation({ summary: 'Update the scheduled host backup settings (admin)' })
  update(@Body() dto: UpdateHostBackupDto) {
    return this.hostBackup.updateConfig(dto);
  }

  @Post('test')
  @ApiOperation({ summary: 'Test a network backup destination: connect, write and delete a probe file (admin)' })
  test(@Body() dto: TestHostBackupDestinationDto) {
    return this.hostBackup.testDestination(dto.type, dto.destination);
  }
}
