/**
 * @file agents.controller.ts
 *
 * REST for agents and agent teams (Multi-Agent).
 *
 *  GET/POST/GET:id/PUT:id/DELETE:id  /api/agents
 *  GET/POST/GET:id/PUT:id/DELETE:id  /api/agent-teams   (+ PUT :id/members)
 *
 * Management (create/update/delete) respects the scope via assertCanManage.
 */
import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsArray, IsObject, IsIn, IsInt, IsBoolean,
} from 'class-validator';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AgentsService } from './agents.service';
import { AgentTeamsService } from './agent-teams.service';
import { MultiAgentService } from './multi-agent.service';
import { AgentScope, AgentToolFilter, TeamTopology } from './agent.types';

class UpsertAgentDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsString() llmConfigId?: string | null;
  @IsOptional() @IsObject() toolFilter?: AgentToolFilter;
  @IsOptional() @IsInt() maxIterations?: number | null;
  @IsOptional() @IsBoolean() exposeAsTool?: boolean;
  @IsOptional() @IsIn(['personal', 'team', 'org']) scope?: AgentScope;
  @IsOptional() @IsString() teamId?: string | null;
}

class UpsertTeamDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(['supervisor', 'sequential', 'parallel']) topology?: TeamTopology;
  @IsOptional() @IsString() supervisorAgentId?: string | null;
  @IsOptional() @IsBoolean() exposeAsTool?: boolean;
  @IsOptional() @IsIn(['personal', 'team', 'org']) scope?: AgentScope;
  @IsOptional() @IsString() teamId?: string | null;
}

class SetMembersDto {
  @IsArray() members: { agentId: string; position?: number; role?: string | null }[];
}

class RunDto {
  @IsString() input: string;
  @IsOptional() @IsString() projectId?: string;
}

@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/agents')
export class AgentsController {
  constructor(
    private readonly service: AgentsService,
    private readonly runner: MultiAgentService,
  ) {}

  @Post(':id/run')
  @ApiOperation({ summary: 'Run a single agent with an input' })
  async run(@Param('id') id: string, @Body() dto: RunDto, @CurrentUser() user: any) {
    const output = await this.runner.runAgentById(id, user.id, dto.input, dto.projectId);
    return { output };
  }

  @Get()
  @ApiOperation({ summary: 'List accessible agents' })
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  @Post()
  async create(@Body() dto: UpsertAgentDto, @CurrentUser() user: any) {
    const scope = dto.scope ?? 'personal';
    await this.service.assertCanManage(user, scope, dto.teamId);
    return this.service.create(user.id, { ...dto, scope });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOneAccessible(id, user.id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpsertAgentDto, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    if (dto.scope !== undefined && dto.scope !== existing.scope) {
      await this.service.assertCanManage(user, dto.scope, dto.teamId ?? existing.teamId, existing.userId);
    }
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    await this.service.remove(id, user.id);
  }
}

@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/agent-teams')
export class AgentTeamsController {
  constructor(
    private readonly service: AgentTeamsService,
    private readonly runner: MultiAgentService,
  ) {}

  @Post(':id/run')
  @ApiOperation({ summary: 'Run the team with an input (MA-3: sequential)' })
  run(@Param('id') id: string, @Body() dto: RunDto, @CurrentUser() user: any) {
    return this.runner.runTeamById(id, user.id, dto.input, dto.projectId);
  }

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  @Post()
  async create(@Body() dto: UpsertTeamDto, @CurrentUser() user: any) {
    const scope = dto.scope ?? 'personal';
    await this.service.assertCanManage(user, scope, dto.teamId);
    return this.service.create(user.id, { ...dto, scope });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOneAccessible(id, user.id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpsertTeamDto, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    if (dto.scope !== undefined && dto.scope !== existing.scope) {
      await this.service.assertCanManage(user, dto.scope, dto.teamId ?? existing.teamId, existing.userId);
    }
    return this.service.update(id, dto);
  }

  @Put(':id/members')
  @ApiOperation({ summary: 'Replace the team members' })
  async setMembers(@Param('id') id: string, @Body() dto: SetMembersDto, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.setMembers(id, dto.members ?? []);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    await this.service.remove(id, user.id);
  }
}
