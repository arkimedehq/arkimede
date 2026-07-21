/**
 * @file flows.controller.ts
 *
 * REST for Flows (deterministic graph-based workflows).
 *
 *  GET    /api/flows              → list of accessible flows (own + team + org)
 *  POST   /api/flows              → create
 *  GET    /api/flows/:id          → detail (own or shared)
 *  PUT    /api/flows/:id          → update
 *  DELETE /api/flows/:id          → delete
 *  PATCH  /api/flows/:id/toggle   → enable/disable
 *  POST   /api/flows/:id/run      → manual execution (returns the FlowRun)
 *  GET    /api/flows/:id/runs     → execution history
 *
 * All endpoints require JWT. Management (create/update/delete) respects
 * the scope via assertCanManage; read/execution require access to the flow.
 */
import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam,
} from '@nestjs/swagger';
import {
  IsString, IsOptional, IsBoolean, IsObject, IsArray, IsIn,
} from 'class-validator';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FlowsService } from './flows.service';
import { FlowDefinition, FlowInputVar, FlowScope, FlowTrigger } from './flow.types';

class UpsertFlowDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsObject() definition?: FlowDefinition;
  @IsOptional() @IsObject() trigger?: FlowTrigger;
  @IsOptional() @IsArray() inputSchema?: FlowInputVar[];
  @IsOptional() @IsBoolean() exposeAsTool?: boolean;
  @IsOptional() @IsBoolean() loadOnFirst?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['personal', 'team', 'org']) scope?: FlowScope;
  @IsOptional() @IsString() teamId?: string | null;
}

class RunFlowDto {
  @IsOptional() @IsObject() input?: Record<string, unknown>;
}

class RunNodeDto {
  @IsString() nodeId: string;
  @IsOptional() @IsObject() input?: Record<string, unknown>;
  @IsOptional() @IsObject() definition?: FlowDefinition;
}

class ToggleDto {
  @IsBoolean() enabled: boolean;
}

@ApiTags('flows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/flows')
export class FlowsController {
  constructor(private readonly service: FlowsService) {}

  @Get()
  @ApiOperation({ summary: 'List accessible flows (own + team + org)' })
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a flow' })
  @ApiResponse({ status: 201, description: 'Flow created' })
  async create(@Body() dto: UpsertFlowDto, @CurrentUser() user: any) {
    const scope = dto.scope ?? 'personal';
    await this.service.assertCanManage(user, scope, dto.teamId);
    return this.service.create(user.id, { ...dto, scope });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Flow detail (own or shared)' })
  @ApiParam({ name: 'id', description: 'Flow UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOneAccessible(id, user.id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a flow' })
  async update(@Param('id') id: string, @Body() dto: UpsertFlowDto, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    if (dto.scope !== undefined && dto.scope !== existing.scope) {
      await this.service.assertCanManage(user, dto.scope, dto.teamId ?? existing.teamId, existing.userId);
    }
    return this.service.update(id, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Enable/disable a flow' })
  async toggle(@Param('id') id: string, @Body() dto: ToggleDto, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.update(id, { enabled: dto.enabled });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a flow' })
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findById(id);
    await this.service.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    await this.service.remove(id, user.id);
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Run the flow manually and return the run' })
  run(@Param('id') id: string, @Body() dto: RunFlowDto, @CurrentUser() user: any) {
    return this.service.runManual(id, user.id, dto.input ?? {});
  }

  @Post(':id/run-node')
  @ApiOperation({ summary: 'Test run of a node + predecessors (subgraph); returns the run' })
  runNode(@Param('id') id: string, @Body() dto: RunNodeDto, @CurrentUser() user: any) {
    return this.service.runNode(id, user.id, dto.nodeId, dto.input ?? {}, dto.definition);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'Flow execution history' })
  listRuns(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listRuns(id, user.id);
  }
}
