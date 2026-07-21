/**
 * @file health.controller.ts
 *
 * PUBLIC health-check endpoint (no JWT). Auth in this codebase is applied
 * per-controller via `@UseGuards(JwtAuthGuard)` — there is NO global guard — so
 * this controller is public simply by NOT declaring any guard (same approach as
 * AuthController and FlowsWebhookController).
 *
 *   GET /api/health → 200 when the essential dependency (DB) is up,
 *                     503 when it is down.
 *
 * Path convention: no global prefix — the full 'api/...' path is hardcoded here.
 */
import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('api/health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Service health check',
    description:
      'Public (no auth) liveness/readiness probe. Returns 200 when the essential ' +
      'dependency (Postgres) is up, 503 when it is down. Reports the state of the ' +
      'DB and Redis, process uptime, timestamp and app version.',
  })
  @ApiResponse({ status: 200, description: 'Service healthy (status: ok).' })
  @ApiResponse({ status: 503, description: 'Essential dependency down (status: degraded).' })
  async check(@Res() res: Response): Promise<void> {
    const report = await this.health.check();
    const httpStatus = report.status === 'ok' ? 200 : 503;
    res.status(httpStatus).json(report);
  }
}
