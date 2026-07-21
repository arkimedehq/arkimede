import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsString, IsIn, IsOptional, IsInt, Min, Max, IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LlmConfigsService } from './llm-configs.service';
import { LlmProvider } from '../app-config/app-config.entity';

const LLM_PROVIDERS: LlmProvider[] = [
  'anthropic', 'openai', 'gemini', 'ollama', 'lmstudio', 'openai-compatible', 'deepseek',
];

class CreateLlmConfigDto {
  @IsString() name: string;
  @IsIn(LLM_PROVIDERS) provider: LlmProvider;
  @IsOptional() @IsString() model?: string | null;
  @IsOptional() @IsString() apiKey?: string | null;
  @IsOptional() @IsString() baseUrl?: string | null;
  @IsOptional() @IsInt() @Min(256) @Max(384000) @Type(() => Number) maxTokens?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(64) @Type(() => Number) maxConcurrency?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) inputPricePerM?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) outputPricePerM?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) cacheReadPricePerM?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) cacheWritePricePerM?: number | null;
}

class UpdateLlmConfigDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(LLM_PROVIDERS) provider?: LlmProvider;
  @IsOptional() @IsString() model?: string | null;
  @IsOptional() @IsString() apiKey?: string | null;
  @IsOptional() @IsString() baseUrl?: string | null;
  @IsOptional() @IsInt() @Min(256) @Max(384000) @Type(() => Number) maxTokens?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(64) @Type(() => Number) maxConcurrency?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) inputPricePerM?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) outputPricePerM?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) cacheReadPricePerM?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) cacheWritePricePerM?: number | null;
}

@ApiTags('llm-configs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/llm-configs')
export class LlmConfigsController {
  constructor(private readonly svc: LlmConfigsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateLlmConfigDto, @CurrentUser() user: any) {
    return this.svc.create(dto, user?.id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLlmConfigDto,
    @CurrentUser() user: any,
  ) {
    return this.svc.update(id, dto, user?.id);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.svc.remove(id, user?.id);
  }

  @Post(':id/set-default')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setDefault(id);
  }

  /** Designates this config as the summarizer for history compaction. */
  @Post(':id/set-summarizer')
  setSummarizer(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setSummarizer(id);
  }

  /** Clears the designated summarizer (compaction will use the default). */
  @Post('clear-summarizer')
  clearSummarizer() {
    return this.svc.setSummarizer(null);
  }

  /** Designates this config for vision/multimodal tasks (e.g. image OCR). */
  @Post(':id/set-vision')
  setVision(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setVision(id);
  }

  /** Clears the designated vision config (vision tasks will use the default). */
  @Post('clear-vision')
  clearVision() {
    return this.svc.setVision(null);
  }

  @Post(':id/test')
  testConnection(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.testConnection(id);
  }
}
