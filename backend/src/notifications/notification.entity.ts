/**
 * @file notification.entity.ts
 *
 * TypeORM entity for the user's persistent notifications.
 *
 * Generic: not tied only to skill daemons, it can be used
 * for any kind of notification (system, billing, custom, etc.).
 *
 * Key fields:
 *   source    — who generated the notification ('skill_daemon', 'system', ...)
 *   eventType — event type ('new_emails', 'daemon_exit', ...)
 *   payload   — arbitrary JSON data specific to eventType
 *   read      — true after the user has viewed/marked the notification
 *
 * Automatic cleanup: notifications older than 30 days are deleted
 * by NotificationsService.cleanup() called at boot and every 24h.
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from '../users/users.entity';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User recipient of the notification */
  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Source of the notification.
   * E.g.: 'skill_daemon' | 'system' | 'billing' | ...
   */
  @Column({ type: 'varchar', length: 32, default: 'skill_daemon' })
  source: string;

  /**
   * Optional identifier of the source resource.
   * For skill_daemon: daemon UUID; for others: null.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  sourceId: string | null;

  /**
   * Event type specific to the source.
   * E.g.: 'new_emails', 'daemon_exit', 'auth_error', 'invoice_due', ...
   */
  @Column({ type: 'varchar', length: 64 })
  eventType: string;

  /** Arbitrary payload specific to source+eventType. */
  @Column({ type: 'jsonb', default: '{}' })
  payload: Record<string, unknown>;

  /** true = the user has already seen/marked this notification. */
  @Column({ type: 'boolean', default: false })
  read: boolean;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
