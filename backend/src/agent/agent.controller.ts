// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Controller, Post, Get, Body, Query, UseGuards, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AgentService } from './agent.service';

class PromptDto {
  @IsString() prompt: string;
}

@ApiTags('agent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/agent')
export class AgentController {
  constructor(@Inject(AgentService) private readonly agentService: AgentService) {}

  @Post('prompt')
  @ApiOperation({ summary: 'Endpoint diretto per il gestionale VB.NET' })
  async prompt(@Body() dto: PromptDto) {
    const response = await this.agentService.invoke(dto.prompt);
    return { response };
  }

  @Get('tool-catalog')
  @ApiOperation({ summary: 'Available tools grouped by source (for the agent tool picker)' })
  toolCatalog(@CurrentUser() user: any, @Query('projectId') projectId?: string) {
    return this.agentService.buildToolCatalog(user.id, projectId);
  }
}
