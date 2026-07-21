/**
 * @file health.service.ts
 *
 * Liveness/readiness checks for the core dependencies of the backend.
 *
 * - Postgres (essential): a lightweight `SELECT 1` on the TypeORM DataSource.
 * - Redis (optional): a `PING` on an ioredis client built from REDIS_URL. If
 *   REDIS_URL is not configured the check reports 'n/a' (not an error).
 *
 * Every probe is best-effort: it never throws, it only maps failures to a
 * 'down' status so a single flaky dependency can't crash the health endpoint.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

export type ComponentState = 'up' | 'down' | 'n/a';

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptime: number;
  timestamp: string;
  version: string;
  checks: {
    db: ComponentState;
    redis: ComponentState;
  };
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly version: string;
  // Reused Redis client (lazy). Kept alive across requests to avoid opening a
  // new connection on every probe. `undefined` = Redis not configured.
  private redisClient?: Redis;
  private readonly redisUrl?: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.version = process.env.npm_package_version || '1.0.0';
    const url = (this.config.get<string>('REDIS_URL') || '').trim();
    this.redisUrl = url || undefined;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.quit().catch(() => undefined);
    }
  }

  /** Runs all probes and aggregates them into a single report. */
  async check(): Promise<HealthReport> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    // DB is the only essential check: if it is down the service is degraded.
    const status: HealthReport['status'] = db === 'up' ? 'ok' : 'degraded';
    return {
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: this.version,
      checks: { db, redis },
    };
  }

  /** Lightweight Postgres probe: `SELECT 1`. */
  private async checkDb(): Promise<ComponentState> {
    try {
      await this.dataSource.query('SELECT 1');
      return 'up';
    } catch (err: any) {
      this.logger.warn(`DB health check failed: ${err?.message}`);
      return 'down';
    }
  }

  /** Redis probe via PING. Returns 'n/a' when REDIS_URL is not configured. */
  private async checkRedis(): Promise<ComponentState> {
    if (!this.redisUrl) return 'n/a';
    try {
      const client = this.getRedisClient();
      const pong = await client.ping();
      return pong === 'PONG' ? 'up' : 'down';
    } catch (err: any) {
      this.logger.warn(`Redis health check failed: ${err?.message}`);
      return 'down';
    }
  }

  private getRedisClient(): Redis {
    if (!this.redisClient) {
      // lazyConnect: connect on the first probe. Fast-fail comes from retryStrategy
      // returning null (no reconnection) + maxRetriesPerRequest — NOT from
      // enableOfflineQueue, which must stay enabled so the first PING can trigger
      // the connection instead of throwing "Stream isn't writeable".
      this.redisClient = new Redis(this.redisUrl as string, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      // Swallow connection errors: without a listener ioredis emits 'error' as an
      // unhandled event → would crash the process.
      this.redisClient.on('error', (err) =>
        this.logger.debug(`Redis client error: ${err?.message}`),
      );
    }
    return this.redisClient;
  }
}
