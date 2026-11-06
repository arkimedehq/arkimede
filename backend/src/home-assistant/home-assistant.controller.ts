// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { BadRequestException, Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AppConfigService } from '../app-config/app-config.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { User } from '../users/users.entity';
import { HomeAssistantService, bearerToken } from './home-assistant.service';

class UpdateHomeAssistantDto {
  @IsOptional() @IsString() @MaxLength(500) @Matches(/^https?:\/\/\S+$/i, { message: 'haUrl must be an http(s) URL' })
  haUrl?: string | null;

  /** A long-lived access token (Home Assistant → your profile → Security); null removes it. */
  @IsOptional() @IsString() @MaxLength(2000)
  haToken?: string | null;

  @IsOptional() @IsBoolean()
  haPresenceEnabled?: boolean;

  @IsOptional() @IsBoolean()
  haVoiceEnabled?: boolean;

  @IsOptional() @IsBoolean()
  haToolsEnabled?: boolean;

  /** Who may use the agent's `ha_*` tools; null or empty = every user. */
  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  haToolsUserIds?: string[] | null;
}

class ImportFromMcpDto {
  @IsUUID()
  serverId: string;

  /** Turn the MCP server off afterwards (its tools would duplicate the native ones). */
  @IsOptional() @IsBoolean()
  disable?: boolean;
}

class LinkPersonDto {
  @IsUUID()
  userId: string;

  /** `person.x`, or null to unlink. */
  @IsOptional() @IsString() @Matches(/^person\.[a-z0-9_]+$/)
  haPerson?: string | null;
}

/** Home Assistant as a native integration (admin): connection, presence, voice, the agent's tools, users ↔ persons. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/config/home-assistant')
export class HomeAssistantController {
  constructor(
    private readonly config: AppConfigService,
    private readonly mcp: McpServersService,
    private readonly ha: HomeAssistantService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** GET — the settings (the token only as set or not), the live status, users, MCP servers to import from. */
  @Get()
  @ApiOperation({ summary: 'Home Assistant integration: settings and live status' })
  async get() {
    return this.view();
  }

  /** PATCH — updates the settings and reconnects. */
  @Patch()
  @ApiOperation({ summary: 'Update the Home Assistant integration' })
  async update(@Body() dto: UpdateHomeAssistantDto, @CurrentUser() user: any) {
    await this.config.updateHomeAssistantConfig(dto, user?.id);
    await this.ha.apply();
    return this.view();
  }

  /** POST import-mcp — takes the URL and token of a Home Assistant MCP server (and turns it off, if asked). */
  @Post('import-mcp')
  @ApiOperation({ summary: 'Import the Home Assistant URL and token from its MCP server' })
  async importFromMcp(@Body() dto: ImportFromMcpDto, @CurrentUser() user: any) {
    const creds = await this.mcp.credentialsFor(dto.serverId, /./);
    const token = creds ? bearerToken(creds.headers) : null;
    if (!creds || !token) throw new BadRequestException('That MCP server has no URL or Bearer token to import');
    await this.config.updateHomeAssistantConfig({ haUrl: new URL(creds.url).origin, haToken: token }, user?.id);
    if (dto.disable) await this.mcp.disable(dto.serverId);
    await this.ha.apply();
    return this.view();
  }

  /** PATCH people — links an Arkimede user to their Home Assistant person ("me" for the tools). */
  @Patch('people')
  @ApiOperation({ summary: 'Link a user to their Home Assistant person' })
  async linkPerson(@Body() dto: LinkPersonDto) {
    await this.users.update(dto.userId, { haPerson: dto.haPerson ?? null });
    return this.view();
  }

  private async view() {
    const users = await this.users.find({ select: { id: true, name: true, email: true, haPerson: true }, order: { name: 'ASC' } });
    return {
      ...(await this.config.getHomeAssistantConfig()),
      status: this.ha.getStatus(),
      users: users.map((u) => ({ id: u.id, name: u.name ?? u.email, haPerson: u.haPerson })),
      servers: await this.mcp.httpServers(),
    };
  }
}
