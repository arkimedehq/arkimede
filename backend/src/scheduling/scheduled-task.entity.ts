/**
 * @file scheduled-task.entity.ts
 *
 * An **automation** scheduled by the user (including from chat, via the built-in
 * tool `schedule_task`). On fire, a headless runner re-runs the agent with
 * `instruction` and delivers the outcome via a notification. See SchedulingService.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';

export type ScheduleType = 'cron' | 'scheduled';
/** pending = created but awaiting confirmation (not registered on BullMQ). */
export type ScheduledTaskStatus = 'pending' | 'active' | 'done' | 'error';

@Entity('scheduled_tasks')
export class ScheduledTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /** What to do, as a complete instruction for the headless agent. */
  @Column({ type: 'text' })
  instruction: string;

  /** Short label (derived or provided). */
  @Column({ type: 'varchar', length: 160, nullable: true })
  title: string | null;

  @Column({ type: 'varchar', length: 16 })
  scheduleType: ScheduleType;

  /** Cron expression (scheduleType='cron'). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  cron: string | null;

  /** ISO date/time of the single fire (scheduleType='scheduled'). */
  @Column({ type: 'timestamptz', nullable: true })
  runAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone: string | null;

  /** Project context for the headless run (project tools/RAG). */
  @Column({ type: 'uuid', nullable: true })
  projectId: string | null;

  /**
   * Outcome delivery chat. Set to the ORIGIN chat (where the user requested
   * the automation); if missing/deleted, on the first run a dedicated chat is
   * created and its id saved here. null = no chat associated yet.
   */
  @Column({ type: 'uuid', nullable: true })
  chatId: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: ScheduledTaskStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastResult: string | null;

  /** Tokens consumed by the last headless run (cost accounting). */
  @Column({ type: 'int', nullable: true })
  lastInputTokens: number | null;

  @Column({ type: 'int', nullable: true })
  lastOutputTokens: number | null;

  /** Cumulative tokens across all runs (accounting + cost guardrail). */
  @Column({ type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  totalTokens: number;

  /**
   * Subset of tools allowed in the headless run. Default `none` (cheap run):
   * most automations need no tool; the agent opts in
   * to the tools needed at scheduling time (and the user confirms).
   */
  @Column({ type: 'jsonb', default: { mode: 'none' } })
  toolFilter: { mode: 'all' | 'names' | 'none'; names?: string[] };

  @CreateDateColumn()
  createdAt: Date;
}
