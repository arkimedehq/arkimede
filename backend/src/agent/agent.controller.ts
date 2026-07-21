import { Controller, Post, Body, UseGuards, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
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
}
