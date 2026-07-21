import {
  Controller, Get, Post, Delete, Param, UseGuards, Res,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { BackupService } from './backup.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  @ApiOperation({ summary: 'List available backups (admin)' })
  list() {
    return this.backup.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new backup (pg_dump + file volumes + Qdrant snapshot)' })
  create() {
    return this.backup.createBackup();
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download a backup archive (admin)' })
  async download(@Param('id') id: string, @Res() res: Response) {
    const { path, filename } = await this.backup.getDownloadPath(id);
    res.download(path, filename);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a backup (admin)' })
  async remove(@Param('id') id: string) {
    await this.backup.remove(id);
    return { ok: true };
  }
}
