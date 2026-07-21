/**
 * @file skill-daemon.entity.ts
 *
 * TypeORM entity for skill daemons.
 *
 * A daemon is a long-running process associated with a user and with a script
 * of a skill with mode='daemon'. The record is persisted in the DB so that the backend
 * can automatically restart active daemons after a restart.
 *
 * Lifecycle:
 *   starting → running  — after start confirmed by the executor
 *   running  → stopped  — after explicit stop by the user
 *   running  → error    — after unexpected exit (daemon_exit event)
 *   stopped/error → starting — explicit restart
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { Skill } from '../skills/skill.entity';

export type DaemonStatus = 'starting' | 'running' | 'stopped' | 'error';

@Entity('skill_daemons')
export class SkillDaemon {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** User that owns the daemon */
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /** Skill the daemon script comes from */
  @ManyToOne(() => Skill, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'skillId' })
  skill: Skill;

  @Column({ type: 'uuid' })
  skillId: string;

  /**
   * Relative path of the script within the skill package.
   * E.g.: "scripts/daemon_emails.py"
   */
  @Column({ type: 'varchar', length: 256 })
  scriptFilename: string;

  /**
   * Current state of the daemon:
   *   starting — startup in progress (waiting for confirmation from the executor)
   *   running  — process active in the executor
   *   stopped  — stopped explicitly by the user
   *   error    — exited unexpectedly (see lastError)
   */
  @Column({
    type:    'varchar',
    length:  16,
    default: 'starting',
  })
  status: DaemonStatus;

  /**
   * PID of the process in the executor (null before startup confirmation).
   * Useful for diagnostics, not for operations (stop uses daemon_id).
   */
  @Column({ type: 'integer', nullable: true, default: null })
  pid: number | null;

  /**
   * Startup timestamp confirmed by the executor.
   * Null until the /daemon/start response is received.
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  startedAt: Date | null;

  /** Date of the last event received from the daemon (implicit keep-alive). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastEventAt: Date | null;

  /** Error message in case of unexpected exit. */
  @Column({ type: 'text', nullable: true, default: null })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
