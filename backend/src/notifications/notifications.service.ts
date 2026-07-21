/**
 * @file notifications.service.ts
 *
 * Notification persistence management in the DB.
 *
 * Responsibilities:
 *   - Notification creation (called by InternalDaemonsController before the WS emit)
 *   - Paginated notification list per user (max 100, DESC createdAt order)
 *   - Mark read / mark all read
 *   - Delete single / delete all
 *   - Automatic cleanup: notifications >30 days at boot + every 24h via setInterval
 */
import { Injectable, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Notification } from './notification.entity';

export interface CreateNotificationDto {
  userId:    string;
  source?:   string;           // default 'skill_daemon'
  sourceId?: string | null;
  eventType: string;
  payload?:  Record<string, unknown>;
}

const RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24h

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  onModuleInit(): void {
    // First cleanup at boot (non-blocking)
    void this.cleanup();
    // Periodic cleanup every 24h
    setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  // ── Write ────────────────────────────────────────────────────────────────────

  /** Creates and persists a new notification. Returns the saved record. */
  async create(dto: CreateNotificationDto): Promise<Notification> {
    const notif = this.repo.create({
      userId:    dto.userId,
      source:    dto.source    ?? 'skill_daemon',
      sourceId:  dto.sourceId  ?? null,
      eventType: dto.eventType,
      payload:   dto.payload   ?? {},
      read:      false,
    });
    return this.repo.save(notif);
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  /** The user's latest `limit` notifications, most recent first. */
  async findByUser(userId: string, limit = 100): Promise<Notification[]> {
    return this.repo.find({
      where:  { userId },
      order:  { createdAt: 'DESC' },
      take:   limit,
    });
  }

  // ── Mark read ────────────────────────────────────────────────────────────────

  async markRead(userId: string, id: string): Promise<Notification> {
    const notif = await this.repo.findOneBy({ id, userId });
    if (!notif) throw new NotFoundException('notifications.notFound');
    notif.read = true;
    return this.repo.save(notif);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.repo.update({ userId, read: false }, { read: true });
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async delete(userId: string, id: string): Promise<void> {
    const result = await this.repo.delete({ id, userId });
    if (!result.affected) throw new NotFoundException('notifications.notFound');
  }

  async deleteAll(userId: string): Promise<void> {
    await this.repo.delete({ userId });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  /** Deletes notifications older than RETENTION_DAYS days (for all users). */
  async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    try {
      const result = await this.repo.delete({ createdAt: LessThan(cutoff) });
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`[cleanup] Deleted ${result.affected} notifications older than ${RETENTION_DAYS} days`);
      }
    } catch (err) {
      this.logger.error('[cleanup] Error during notifications cleanup', err);
    }
  }
}
