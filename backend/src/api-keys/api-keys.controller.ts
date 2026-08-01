// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiKeysService } from './api-keys.service';

class CreateApiKeyDto {
  @IsString()
  name: string;

  /** Days until expiry; omit/0 = never expires. */
  @IsOptional() @IsInt() @Min(0) @Max(3650)
  expiresInDays?: number;
}

class AdminCreateApiKeyDto extends CreateApiKeyDto {
  @IsUUID()
  userId: string;
}

/**
 * Long-lived opaque API keys: each user manages their own; admins can issue
 * and list keys for service accounts (e.g. a dedicated voice user) without
 * logging in as them. The clear key appears ONLY in the create response.
 */
@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('api/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'List your API keys (no secrets)' })
  list(@CurrentUser() user: any) {
    return this.service.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create an API key for yourself (clear key returned once)' })
  create(@Body() dto: CreateApiKeyDto, @CurrentUser() user: any) {
    return this.service.create(user.id, dto.name, dto.expiresInDays ?? null, user.id);
  }

  @Get('user/:userId')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '[ADMIN] List the API keys of a user' })
  @ApiParam({ name: 'userId', description: 'Owner UUID' })
  listForUser(@Param('userId') userId: string) {
    return this.service.list(userId);
  }

  @Post('admin')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '[ADMIN] Create an API key for any user (clear key returned once)' })
  createForUser(@Body() dto: AdminCreateApiKeyDto, @CurrentUser() user: any) {
    return this.service.create(dto.userId, dto.name, dto.expiresInDays ?? null, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key (owner or admin)' })
  @ApiParam({ name: 'id', description: 'API key UUID' })
  async revoke(@Param('id') id: string, @CurrentUser() user: any) {
    await this.service.revoke(id, user.id, user.role === 'admin', user.id);
  }
}
