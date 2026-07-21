/**
 * @file mcp-servers.controller.ts
 *
 * REST controller for managing the user's MCP servers.
 *
 * Endpoints:
 *   GET    /api/mcp-servers              — list servers (with secret keyNames)
 *   POST   /api/mcp-servers              — create server
 *   GET    /api/mcp-servers/:id          — server detail
 *   PATCH  /api/mcp-servers/:id          — update server
 *   DELETE /api/mcp-servers/:id          — delete server
 *
 *   GET    /api/mcp-servers/:id/secrets  — list secret keyNames
 *   PUT    /api/mcp-servers/:id/secrets  — upsert secrets
 *   DELETE /api/mcp-servers/:id/secrets/:key — delete a secret
 *
 *   GET    /api/mcp-servers/:id/status   — bridge status (connected/disconnected)
 *   POST   /api/mcp-servers/:id/refresh  — send updated config to the bridge
 */
import {
  Controller, Get, Post, Patch, Delete, Put, Param,
  Body, UseGuards, HttpCode, HttpStatus, Inject,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { McpServersService, CreateMcpServerDto, UpdateMcpServerDto } from './mcp-servers.service';
import { McpBridgeGateway } from './mcp-bridge.gateway';
import { IsString, IsOptional, IsIn, IsBoolean, IsArray, IsObject, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

class CreateMcpServerDtoValidated implements CreateMcpServerDto {
  @IsString() @MaxLength(128)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsIn(['http', 'sse', 'local', 'remote'])
  transport: 'http' | 'sse' | 'local' | 'remote';

  @IsOptional() @IsString() @MaxLength(2048)
  url?: string;

  @IsOptional() @IsString() @MaxLength(512)
  command?: string;

  @IsOptional() @IsArray()
  @Type(() => String)
  args?: string[];

  @IsOptional() @IsObject()
  headers?: Record<string, string>;

  @IsOptional() @IsObject()
  env?: Record<string, string>;

  @IsOptional() @IsBoolean()
  loadOnFirst?: boolean;

  @IsOptional() @IsObject()
  secrets?: Record<string, string>;
}

class UpdateMcpServerDtoValidated implements UpdateMcpServerDto {
  @IsOptional() @IsString() @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsIn(['http', 'sse', 'local', 'remote'])
  transport?: 'http' | 'sse' | 'local' | 'remote';

  @IsOptional() @IsString() @MaxLength(2048)
  url?: string;

  @IsOptional() @IsString() @MaxLength(512)
  command?: string;

  @IsOptional() @IsArray()
  @Type(() => String)
  args?: string[];

  @IsOptional() @IsObject()
  headers?: Record<string, string>;

  @IsOptional() @IsObject()
  env?: Record<string, string>;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsBoolean()
  loadOnFirst?: boolean;

  @IsOptional() @IsObject()
  secrets?: Record<string, string>;
}

@Controller('api/mcp-servers')
@UseGuards(JwtAuthGuard)
export class McpServersController {
  constructor(
    @Inject(McpServersService)
    private readonly service: McpServersService,
    @Inject(McpBridgeGateway)
    private readonly gateway: McpBridgeGateway,
  ) {}

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateMcpServerDtoValidated) {
    return this.service.create(user.id, dto, user.role === 'admin');
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user.id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateMcpServerDtoValidated,
  ) {
    const result = await this.service.update(id, user.id, dto, user.role === 'admin');
    // Update the config on the bridge if present
    await this.gateway.pushConfigUpdate(user.id);
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    await this.service.remove(id, user.id);
    await this.gateway.pushConfigUpdate(user.id);
  }

  // ── Secrets ──────────────────────────────────────────────────────────────

  @Get(':id/secrets')
  getSecretKeys(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.getSecretKeys(id, user.id).then((keys) => ({ keys }));
  }

  @Put(':id/secrets')
  @HttpCode(HttpStatus.NO_CONTENT)
  upsertSecrets(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() body: Record<string, string>,
  ) {
    return this.service.upsertSecrets(id, body);
  }

  @Delete(':id/secrets/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSecret(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() user: any,
  ) {
    return this.service.removeSecret(id, key, user.id);
  }

  // ── Bridge status ─────────────────────────────────────────────────────────

  @Get(':id/status')
  getBridgeStatus(@Param('id') _id: string, @CurrentUser() user: any) {
    const connected = this.gateway.isBridgeConnected(user.id);
    return { connected };
  }

  @Post('bridge/refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refreshBridge(@CurrentUser() user: any) {
    await this.gateway.pushConfigUpdate(user.id);
  }
}
