/**
 * @file scheduling.service.ts
 *
 * Auto-Scheduling: engine for the **automations** scheduled by the user.
 *
 * - `buildScheduleTool()` → built-in tool `schedule_task` injected into the agent:
 *   the user asks in chat ("every morning at 8 check the mail and summarize")
 *   and the agent compiles instruction + cron/runAt and creates the task.
 * - Scheduler on **BullMQ + Redis** (recurring cron / one-shot), like Flows.
 * - On fire, a **headless runner** re-runs the agent with `instruction`
 *   (`AgentService.invoke`, resolved via ModuleRef to avoid cycles) and delivers
 *   the outcome via a **notification** (persisted + WebSocket push).
 *
 * Model B of the design (see "Auto-Scheduling (Design)" in PROJECT.md): the agent
 * re-reasons on each fire with all its tools → "schedule anything".
 */
import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { SCHEDULE_TASK_DESC, CONFIRM_SCHEDULED_TASK_DESC } from '../prompts/prompts';

import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { ScheduledTask } from './scheduled-task.entity';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';

const QUEUE_NAME = 'auto-scheduler';
const schedId = (id: string) => `task:${id}`;
const onceId = (id: string) => `task:${id}:once`;

// Cost/abuse guardrail — DEFAULTS, overridable via env
// (SCHED_MAX_TASKS_PER_USER / SCHED_MAX_ACTIVE_RECURRING / SCHED_MAX_TOKENS_PER_RUN).
const DEFAULT_MAX_TASKS_PER_USER = 25;     // total automations (pending+active) per user
const DEFAULT_MAX_ACTIVE_RECURRING = 10;   // active cron per user
const DEFAULT_MAX_TOKENS_PER_RUN = 200000; // beyond this, the task is disabled (0 = off)

// Cleanup of orphaned `pending`: a task prepared (schedule_task) but never confirmed
// stays `pending`, is NOT registered on BullMQ (won't fire) but clutters the UI. After
// this TTL it is deleted. Override via env SCHED_PENDING_TTL_MIN (0 = off).
const DEFAULT_PENDING_TTL_MIN = 30;
const PENDING_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // pass every 5 minutes

export interface CreateTaskInput {
  instruction: string;
  title?: string;
  cron?: string;
  runAt?: string;
  timezone?: string;
  projectId?: string | null;
  /** Origin chat: for one-shot tasks it becomes the outcome delivery chat. */
  chatId?: string | null;
  toolFilter?: { mode: 'all' | 'names' | 'none'; names?: string[] };
}

@Injectable()
export class SchedulingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulingService.name);
  private readonly connection: ConnectionOptions;
  private readonly maxTasksPerUser: number;
  private readonly maxActiveRecurring: number;
  private readonly maxTokensPerRun: number;
  private readonly pendingTtlMin: number;
  private queue?: Queue;
  private worker?: Worker;
  private sweepTimer?: NodeJS.Timeout;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
    @InjectRepository(ScheduledTask) private readonly repo: Repository<ScheduledTask>,
    @InjectRepository(Chat) private readonly chatRepo: Repository<Chat>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
  ) {
    this.connection = this.parseRedisUrl(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'));
    this.maxTasksPerUser = Number(this.config.get('SCHED_MAX_TASKS_PER_USER')) || DEFAULT_MAX_TASKS_PER_USER;
    this.maxActiveRecurring = Number(this.config.get('SCHED_MAX_ACTIVE_RECURRING')) || DEFAULT_MAX_ACTIVE_RECURRING;
    const capEnv = this.config.get('SCHED_MAX_TOKENS_PER_RUN');
    this.maxTokensPerRun = capEnv !== undefined && capEnv !== '' ? Number(capEnv) : DEFAULT_MAX_TOKENS_PER_RUN;
    const ttlEnv = this.config.get('SCHED_PENDING_TTL_MIN');
    this.pendingTtlMin = ttlEnv !== undefined && ttlEnv !== '' ? Number(ttlEnv) : DEFAULT_PENDING_TTL_MIN;
  }

  async onModuleInit(): Promise<void> {
    try {
      this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: this.connection });
      this.worker.on('failed', (job, err) => this.logger.error(`Task job ${job?.id} failed: ${err?.message}`));
      this.worker.on('error', (err) => this.logger.warn(`Worker error: ${err?.message}`));
      this.enabled = true;
      await this.syncAll();
      // Cleanup orphaned pending: pass at boot + periodic sweep.
      if (this.pendingTtlMin > 0) {
        await this.sweepStalePending();
        this.sweepTimer = setInterval(() => {
          this.sweepStalePending().catch((err) => this.logger.warn(`Pending sweep failed: ${err?.message}`));
        }, PENDING_SWEEP_INTERVAL_MS);
        this.sweepTimer.unref?.(); // doesn't keep the process alive
      }
      this.logger.log('SchedulingService started (BullMQ).');
    } catch (err: any) {
      this.enabled = false;
      this.logger.warn(`SchedulingService disabled (Redis unreachable?): ${err?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  /**
   * Deletes `pending` tasks (prepared but never confirmed) older than the TTL.
   * Safe: pending tasks are not registered on BullMQ, so it's a single DB delete.
   */
  private async sweepStalePending(): Promise<void> {
    const cutoff = new Date(Date.now() - this.pendingTtlMin * 60_000);
    const res = await this.repo.delete({ status: 'pending', createdAt: LessThan(cutoff) });
    if (res.affected) this.logger.log(`Orphaned pending cleanup: removed ${res.affected} unconfirmed tasks (TTL ${this.pendingTtlMin}min).`);
  }

  // ── Built-in tools for the agent ──────────────────────────────────────────────

  /**
   * The two built-in tools to inject into the agent. Confirmation flow (Option 2):
   *   1. `schedule_task` → creates the automation in `pending` state (does NOT fire) and
   *      returns a summary; the agent must show it and ASK for confirmation.
   *   2. `confirm_scheduled_task` → the user accepts/rejects → activate or delete.
   * Safe by default: a pending task is never executed.
   */
  buildSchedulingTools(userId: string, projectId?: string, chatId?: string): DynamicStructuredTool[] {
    const scheduleTool = new DynamicStructuredTool({
      name: 'schedule_task',
      description: SCHEDULE_TASK_DESC,
      schema: z.object({
        instruction: z.string().describe('Complete, self-contained instruction to run at fire time.'),
        title: z.string().optional().describe('Short label for the automation.'),
        cron: z.string().optional().describe('5-field cron expression (for recurring).'),
        runAt: z.string().optional().describe('ISO 8601 date/time (for one-time execution).'),
        timezone: z.string().optional().describe('IANA timezone, e.g. "Europe/Rome".'),
        tools: z.array(z.string()).optional().describe('Exact names of the tools the automation may use at fire time. Omit if no tool is needed (default).'),
      }),
      func: async (args: any) => {
        if (!args.cron && !args.runAt) return 'Error: specify "cron" (recurring) or "runAt" (one-time).';
        if (!this.enabled) return 'The scheduler is not available (Redis unreachable).';
        // Guard: an invalid or past runAt would produce a phantom task that
        // is never registered (delay <= 0). Better to reject immediately with a
        // clear message so the model rechecks the current time and recalculates.
        if (args.runAt) {
          const when = new Date(args.runAt);
          if (isNaN(when.getTime())) {
            return `Error: "runAt" (${args.runAt}) is not a valid ISO 8601 date. Use the format with offset, e.g. "2026-06-08T18:54:00+02:00".`;
          }
          if (when.getTime() <= Date.now()) {
            return `Error: "runAt" (${args.runAt}) is in the past (now is ${new Date().toISOString()}). ` +
              `Check the current date/time and provide a future instant.`;
          }
        }
        try {
          const toolFilter = Array.isArray(args.tools) && args.tools.length
            ? { mode: 'names' as const, names: args.tools }
            : { mode: 'none' as const };
          const task = await this.createTask(userId, {
            instruction: args.instruction, title: args.title, cron: args.cron,
            runAt: args.runAt, timezone: args.timezone, projectId: projectId ?? null,
            chatId: chatId ?? null, toolFilter,
          });
          const when = task.scheduleType === 'cron' ? `cron "${task.cron}"` : `on ${task.runAt?.toISOString()}`;
          const tools = toolFilter.mode === 'none' ? 'no tools' : `tools: ${toolFilter.names.join(', ')}`;
          return `PREPARED (awaiting confirmation) — id=${task.id} · "${task.title}" · ${when} · ${tools}. ` +
            `Summarize for the user (including which tools it will have access to) and ask for confirmation, then call confirm_scheduled_task with taskId="${task.id}".`;
        } catch (err: any) {
          return `Unable to prepare the automation: ${err?.message ?? err}`;
        }
      },
    });

    const confirmTool = new DynamicStructuredTool({
      name: 'confirm_scheduled_task',
      description: CONFIRM_SCHEDULED_TASK_DESC,
      schema: z.object({
        taskId: z.string().describe('id returned by schedule_task.'),
        confirm: z.boolean().describe('true = activate, false = cancel.'),
      }),
      func: async (args: any) => {
        if (!args.confirm) {
          await this.remove(args.taskId, userId);
          return 'Automation cancelled.';
        }
        const task = await this.activate(args.taskId, userId);
        if (!task) return 'Automation not found.';
        return `Automation ACTIVATED (id=${task.id}). I will run it and notify you of the outcome.`;
      },
    });

    return [scheduleTool, confirmTool];
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  /** Creates the automation in `pending` state (doesn't fire until activated). */
  async createTask(userId: string, data: CreateTaskInput): Promise<ScheduledTask> {
    // Guardrail: maximum number of automations per user.
    const total = await this.repo.count({ where: { userId } });
    if (total >= this.maxTasksPerUser) {
      throw new Error(`Limit of ${this.maxTasksPerUser} automations per user reached. Delete the ones you no longer need.`);
    }
    const scheduleType = data.cron ? 'cron' : 'scheduled';
    const task = this.repo.create({
      userId,
      instruction: data.instruction,
      title: data.title ?? data.instruction.slice(0, 120),
      scheduleType,
      cron: data.cron ?? null,
      runAt: data.runAt ? new Date(data.runAt) : null,
      timezone: data.timezone ?? null,
      projectId: data.projectId ?? null,
      // Outcome delivery: one-shot → origin chat (a single message, doesn't grow);
      // recurring → null ⇒ DEDICATED chat created on the first run (origin untouched).
      chatId: scheduleType === 'scheduled' ? (data.chatId ?? null) : null,
      toolFilter: data.toolFilter ?? { mode: 'none' },
      enabled: true,
      status: 'pending', // awaits confirmation
    });
    return this.repo.save(task);
  }

  /** Activates a pending task: registers the BullMQ job (with recurring guardrail). */
  async activate(id: string, userId: string): Promise<ScheduledTask | null> {
    const task = await this.repo.findOne({ where: { id, userId } });
    if (!task) return null;
    if (task.scheduleType === 'cron') {
      const activeCron = await this.repo.count({ where: { userId, scheduleType: 'cron', status: 'active' } });
      if (activeCron >= this.maxActiveRecurring) {
        throw new Error(`Limit of ${this.maxActiveRecurring} active recurring automations reached.`);
      }
    }
    task.status = 'active';
    task.enabled = true;
    await this.repo.save(task);
    await this.registerJob(task);
    return task;
  }

  async list(userId: string): Promise<ScheduledTask[]> {
    return this.repo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async setEnabled(id: string, userId: string, enabled: boolean): Promise<ScheduledTask | null> {
    const task = await this.repo.findOne({ where: { id, userId } });
    if (!task) return null;
    task.enabled = enabled;
    if (enabled && task.status !== 'done') await this.registerJob(task);
    else await this.removeJobs(task.id);
    await this.repo.save(task);
    return task;
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.removeJobs(id);
    await this.repo.delete({ id, userId });
  }

  /**
   * "Run now": enqueues an immediate run of the automation, out of schedule.
   * Goes through the same BullMQ worker as a scheduled fire, so the run is
   * identical (agent + tool subset, chat delivery, notification, token guardrail)
   * and the HTTP request doesn't stay open for the whole run: the outcome reaches
   * the user via notification, as usual.
   *
   * Unlike a scheduled fire, a manual run works whatever the state is (pending,
   * disabled, done) — it's the way to try an automation out — and does NOT alter
   * `status`, so the programming stays exactly as it was.
   */
  async runNow(id: string, userId: string): Promise<{ queued: true }> {
    const task = await this.repo.findOne({ where: { id, userId }, select: { id: true } });
    if (!task) throw new NotFoundException('Automation not found.');
    if (!this.enabled || !this.queue) {
      throw new ServiceUnavailableException('The scheduler is not available (Redis unreachable).');
    }
    await this.queue.add(
      'run',
      { taskId: id, manual: true },
      { removeOnComplete: true, removeOnFail: 50 },
    );
    return { queued: true };
  }

  // ── Scheduler (BullMQ) ──────────────────────────────────────────────────────

  private async registerJob(task: ScheduledTask): Promise<void> {
    if (!this.enabled || !this.queue) return;
    await this.removeJobs(task.id);
    if (!task.enabled || task.status !== 'active') return; // pending/done/error → not registered

    if (task.scheduleType === 'cron' && task.cron?.trim()) {
      await this.queue.upsertJobScheduler(
        schedId(task.id),
        { pattern: task.cron.trim(), tz: task.timezone || undefined },
        { name: 'run', data: { taskId: task.id }, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      );
    } else if (task.scheduleType === 'scheduled' && task.runAt) {
      const delay = new Date(task.runAt).getTime() - Date.now();
      if (delay > 0) {
        await this.queue.add('run', { taskId: task.id }, {
          delay, jobId: onceId(task.id), removeOnComplete: true, removeOnFail: 50,
        });
      }
    }
  }

  private async removeJobs(taskId: string): Promise<void> {
    if (!this.queue) return;
    await this.queue.removeJobScheduler(schedId(taskId)).catch(() => undefined);
    const once = await this.queue.getJob(onceId(taskId)).catch(() => undefined);
    await once?.remove().catch(() => undefined);
  }

  private async syncAll(): Promise<void> {
    const tasks = await this.repo.find({ where: { enabled: true, status: 'active' } });
    for (const t of tasks) await this.registerJob(t);
    if (tasks.length) this.logger.log(`Synced ${tasks.length} automations at boot.`);
  }

  // ── Worker: headless agent run + delivery ─────────────────────────────

  private async process(job: Job): Promise<void> {
    const { taskId, manual } = job.data as { taskId: string; manual?: boolean };
    await this.runTask(taskId, manual === true);
  }

  /**
   * Single run of an automation. `manual` = triggered by the user from the UI
   * ("run now") instead of by the scheduler: it runs regardless of enabled/status
   * and leaves `status` untouched (see `runNow`).
   */
  private async runTask(taskId: string, manual = false): Promise<void> {
    const task = await this.repo.findOne({ where: { id: taskId } });
    if (!task) return;
    if (!manual && (!task.enabled || task.status === 'done')) return;

    let result: string;
    let inTok: number | null = null;
    let outTok: number | null = null;
    let failed = false;
    try {
      // AgentService resolved at runtime (dynamic require) → no module cycle.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AgentService } = require('../agent/agent.service');
      const agent = this.moduleRef.get(AgentService, { strict: false });
      // Tool-subset decided at scheduling time (default: none → cheap run).
      const r = await agent.invokeWithUsage(task.instruction, [], task.userId, task.projectId ?? undefined, task.toolFilter);
      result = r.text;
      inTok = r.usage?.inputTokens ?? null;
      outTok = r.usage?.outputTokens ?? null;
    } catch (err: any) {
      result = `Error during execution: ${err?.message ?? String(err)}`;
      failed = true;
    }

    const runTokens = (inTok ?? 0) + (outTok ?? 0);
    task.lastRunAt = new Date();
    task.lastResult = (result ?? '').slice(0, 8000);
    task.lastInputTokens = inTok;
    task.lastOutputTokens = outTok;
    task.totalTokens = (Number(task.totalTokens) || 0) + runTokens;

    // Cost guardrail: beyond the per-run cap → disable the automation.
    let disabledByCost = false;
    if (this.maxTokensPerRun > 0 && runTokens > this.maxTokensPerRun) {
      task.enabled = false;
      disabledByCost = true;
      await this.removeJobs(task.id);
    }
    // A manual run must not consume/alter the programming: a one-shot stays scheduled
    // (it isn't marked `done`) and a failure doesn't put the automation in `error`.
    if (!manual) {
      if (task.scheduleType === 'scheduled') task.status = failed ? 'error' : 'done';
      else if (failed) task.status = 'error';
    }

    const title = task.title ?? task.instruction.slice(0, 80);

    // ── Outcome delivery in chat (best-effort) ─────────────────────────────
    // one-shot → origin chat; recurring → dedicated chat (created on the 1st run).
    // Relative links in the text (e.g. skills-output/…/file.pdf) stay clickable:
    // the chat UI rewrites them into authenticated downloads (/api/files/raw).
    let chatId: string | null = null;
    try {
      chatId = await this.deliverToChat(task, result, title);
      task.chatId = chatId; // persisted with the save below (reused on subsequent runs)
    } catch (err: any) {
      this.logger.warn(`Chat outcome delivery failed (task ${task.id}): ${err?.message ?? err}`);
    }
    await this.repo.save(task);

    // Delivery: persisted notification + WebSocket push (with chatId to open the chat).
    const eventType = disabledByCost ? 'scheduled_task_disabled' : 'scheduled_task';
    const payload = { title, result, taskId: task.id, chatId, tokens: runTokens, disabledByCost };
    if (disabledByCost) {
      payload.result = `⚠️ Automation disabled: the run exceeded the limit of ${this.maxTokensPerRun} tokens (${runTokens}). Outcome: ${result}`;
    }
    const notif = await this.notifications.create({
      userId: task.userId, source: 'auto_scheduler', sourceId: task.id, eventType, payload,
    });
    // id = notification DB id → the frontend can dismiss/mark-read even live.
    this.gateway.emitToUser(task.userId, 'notification', { id: notif.id, eventType, taskId: task.id, title, ...payload });
  }

  /**
   * Writes the run outcome as an `assistant` message in a chat and marks it unread.
   * Resolves the delivery chat: uses `task.chatId` if the chat still exists (one-shot →
   * origin; recurring → dedicated already created on previous runs), otherwise creates a
   * dedicated chat. Does NOT set tokens on the message (already accounted on the task →
   * avoids double counting in the chat dashboard). Returns the delivery chat id.
   */
  private async deliverToChat(task: ScheduledTask, result: string, title: string): Promise<string> {
    let chatId = task.chatId ?? null;
    if (chatId) {
      const exists = await this.chatRepo.findOne({ where: { id: chatId }, select: { id: true } });
      if (!exists) chatId = null; // origin chat deleted → fallback to dedicated
    }
    if (!chatId) {
      const chat = await this.chatRepo.save(this.chatRepo.create({
        userId: task.userId,
        projectId: task.projectId ?? null,
        title: `🤖 ${title}`.slice(0, 120),
        unread: true,
      }));
      chatId = chat.id;
    }
    const stamp = new Date().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    const content = `⏰ **Automation «${title}»** — ${stamp}\n\n${result}`;
    await this.messageRepo.save(this.messageRepo.create({ chatId, role: 'assistant', content }));
    await this.chatRepo.update(chatId, { unread: true, updatedAt: new Date() });
    return chatId;
  }

  private parseRedisUrl(url: string): ConnectionOptions {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || 'localhost',
        port: Number(u.port || 6379),
        ...(u.password ? { password: u.password } : {}),
        ...(u.username ? { username: u.username } : {}),
      };
    } catch {
      return { host: 'localhost', port: 6379 };
    }
  }
}
