// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file health.module.ts
 *
 * Exposes the public GET /api/health endpoint. Relies on the global TypeORM
 * DataSource (registered in AppModule) for the DB probe and on ioredis for the
 * optional Redis probe.
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
