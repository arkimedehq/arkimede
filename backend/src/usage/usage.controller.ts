import { Controller, Get, Query, UseGuards, Inject } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsageService } from './usage.service';
import { LlmMetricsService } from './llm-metrics.service';

class RangeDto {
  /** ISO date (inclusive). */
  @IsOptional() @IsString() from?: string;
  /** ISO date (exclusive). */
  @IsOptional() @IsString() to?: string;
}

function parseRange(dto: RangeDto): { from?: Date; to?: Date } {
  const from = dto.from ? new Date(dto.from) : undefined;
  const to   = dto.to   ? new Date(dto.to)   : undefined;
  return {
    from: from && !isNaN(from.getTime()) ? from : undefined,
    to:   to   && !isNaN(to.getTime())   ? to   : undefined,
  };
}

@ApiTags('usage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/usage')
export class UsageController {
  constructor(
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(LlmMetricsService) private readonly metrics: LlmMetricsService,
  ) {}

  /** My usage (ONLY tokens, no cost). */
  @Get('me')
  @ApiOperation({ summary: 'Current user\'s token usage (no costs)' })
  me(@CurrentUser() user: any, @Query() dto: RangeDto) {
    return this.usage.summaryForUser(user.id, parseRange(dto));
  }

  /** Global usage (tokens + estimated costs). Admin only. */
  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Token usage + costs of all users (admin)' })
  all(@Query() dto: RangeDto & { userId?: string }) {
    const range = parseRange(dto);
    return this.usage.summaryForAdmin({ ...range, userId: dto.userId });
  }

  /** LLM serving metrics: latency percentiles, error rate, throughput. Admin only. */
  @Get('serving')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Call-level LLM serving metrics per config + timeline (admin). Default: last 24h' })
  serving(@Query() dto: RangeDto) {
    return this.metrics.servingSummary(parseRange(dto));
  }

  /** Live dispatcher queues: active/waiting/max per gated config. Admin only. */
  @Get('serving/live')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Live LLM dispatcher queue snapshot (admin)' })
  servingLive() {
    return this.metrics.servingLive();
  }
}
