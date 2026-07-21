/**
 * @file daemons.service.ts
 *
 * Manages the lifecycle of skill daemons:
 *   - Start:   resolves the configuration and asks the executor to start the process
 *   - Stop:    asks the executor to terminate the process
 *   - List:    shows the user's daemons with live state from the executor
 *   - Recovery: at backend startup, restarts the daemons with status='running'
 *
 * Daemons receive the configuration via stdin JSON at startup (identical to tasks),
 * then run indefinitely and communicate with the backend via PUSH_URL.
 *
 * PUSH_URL points to POST /internal/daemons/events — protected by InternalApiKeyGuard.
 * The events are then routed to the user via NotificationsGateway (Socket.IO).
 */
import {
  Injectable, Logger, NotFoundException, BadRequestException,
  ForbiddenException, OnModuleInit,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { SkillDaemon } from './skill-daemon.entity';
import { Skill } from '../skills/skill.entity';
import { SkillScript } from '../skills/skill-script.entity';
import { SkillsService } from '../skills/skills.service';
import { SkillExecutorClient, DaemonStatusEntry } from '../skills/skill-executor.client';
import { mintDaemonToken } from '../common/internal-token/internal-token';

@Injectable()
export class DaemonsService implements OnModuleInit {
  private readonly logger = new Logger(DaemonsService.name);

  constructor(
    @InjectRepository(SkillDaemon)
    private readonly daemonRepo:  Repository<SkillDaemon>,
    @InjectRepository(Skill)
    private readonly skillRepo:   Repository<Skill>,
    @InjectRepository(SkillScript)
    private readonly scriptRepo:  Repository<SkillScript>,
    private readonly skillsSvc:   SkillsService,
    private readonly executor:    SkillExecutorClient,
    private readonly cfg:         ConfigService,
  ) {}

  /**
   * Daemon reconciliation at backend boot.
   *
   * Strategy:
   *   1. Asks the executor for the list of processes actually alive
   *   2. For each DB daemon with status 'starting'|'running':
   *      - Already alive in the executor → confirm status='running' (no restart)
   *      - Not found in the executor → restart the process
   *   3. Logs zombie daemons in the executor without a DB record (no action —
   *      they will be removed by the cleanup in start() on the next call)
   *
   * This avoids launching duplicates when the executor has not restarted
   * (e.g. backend restarted but skill-executor container still active).
   */
  async onModuleInit(): Promise<void> {
    const dbDaemons = await this.daemonRepo.find({
      where: { status: In(['starting', 'running']) },
      relations: { skill: true },
    });

    if (dbDaemons.length === 0) return;

    this.logger.log(`Boot: checking ${dbDaemons.length} active daemons in the DB...`);

    // Get the live list from the executor
    const { liveMap, executorOk } = await this.fetchLiveDaemons();

    if (executorOk) {
      this.logger.log(`Executor reachable: ${liveMap.size} active processes`);
    } else {
      this.logger.warn('Executor unreachable — restarting all DB daemons');
    }

    for (const daemon of dbDaemons) {
      const live = liveMap.get(daemon.id);

      if (executorOk && live?.running) {
        // Already alive → update the PID (it may have changed) and confirm 'running'
        this.logger.log(
          `  ✓ Daemon ${daemon.id.slice(0, 8)} already active in the executor` +
          ` (PID=${live.pid}, skill: ${daemon.skill?.name})`,
        );
        await this.daemonRepo.update(daemon.id, { status: 'running', pid: live.pid });
      } else {
        // Not found or executor unreachable → restart
        this.logger.log(
          `  ↺ Daemon ${daemon.id.slice(0, 8)} not active — restarting` +
          ` (skill: ${daemon.skill?.name})`,
        );
        try {
          await this.doStart(daemon);
          this.logger.log(`    ✓ Restarted`);
        } catch (err: any) {
          this.logger.warn(`    ✗ Restart failed: ${err.message}`);
          await this.daemonRepo.update(daemon.id, {
            status:    'error',
            lastError: `Recovery failed at boot: ${err.message}`,
          });
        }
      }
    }

    // Report zombie daemons in the executor (alive but without a DB record)
    if (executorOk && liveMap.size > 0) {
      const dbIds = new Set(dbDaemons.map((d) => d.id));
      for (const [liveId, entry] of liveMap) {
        if (entry.running && !dbIds.has(liveId)) {
          this.logger.warn(
            `  ⚠ Zombie in the executor: daemon=${liveId.slice(0, 8)}` +
            ` skill=${entry.skill_id.slice(0, 8)} — no DB record` +
            ` (will be removed on the next start())`,
          );
        }
      }
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  /**
   * List the user's daemons with state reconciled from the executor.
   *
   * Before returning the records, sync the DB state with the executor's
   * reality for the current user:
   *   - DB='running' but executor='dead' → update to 'error'
   *   - DB='starting'/'running' and executor='alive' → confirm 'running' + updated PID
   *
   * This ensures that Settings → Background always show the real state,
   * even after a restart of the backend or the executor.
   */
  async findAll(userId: string): Promise<SkillDaemon[]> {
    await this.reconcileUser(userId).catch(() => { /* best-effort */ });
    return this.daemonRepo.find({
      where: { userId },
      relations: { skill: true },
      order: { createdAt: 'DESC' },
    });
  }

  /** Detail of a single daemon (owner only). */
  async findOne(id: string, userId: string): Promise<SkillDaemon> {
    const daemon = await this.daemonRepo.findOne({
      where: { id, userId },
      relations: { skill: true },
    });
    if (!daemon) throw new NotFoundException(
      I18nContext.current()?.t('daemons.notFound', { args: { id } }) ?? `Daemon ${id} not found`,
    );
    return daemon;
  }

  /**
   * Start a new daemon for the given skill/script.
   *
   * Checks:
   *   - The skill exists and is 'ready'
   *   - The script exists in the skill and has mode='daemon'
   *   - No running daemon already exists for the same userId+skill+script tuple
   */
  async start(userId: string, skillId: string, scriptFilename: string): Promise<SkillDaemon> {
    // Check skill — visibility (own / org-approved / team) is delegated to SkillsService
    const skill = await this.skillsSvc.findOne(skillId, userId).catch(() => null);
    if (!skill) throw new NotFoundException(
      I18nContext.current()?.t('daemons.skillNotFound', { args: { skillId } }) ?? `Skill ${skillId} not found`,
    );
    if (skill.status !== 'ready') {
      throw new BadRequestException(
        I18nContext.current()?.t('daemons.skillNotReady', { args: { name: skill.name, status: skill.status } }) ??
          `The skill "${skill.name}" is not ready (status: ${skill.status})`,
      );
    }

    // Check daemon script
    const script = await this.scriptRepo.findOne({
      where: { skillId, filename: scriptFilename },
    });
    if (!script) throw new NotFoundException(
      I18nContext.current()?.t('daemons.scriptNotFound', { args: { filename: scriptFilename } }) ??
        `Script "${scriptFilename}" not found in the skill`,
    );
    if ((script as any).mode !== 'daemon') {
      throw new BadRequestException(
        I18nContext.current()?.t('daemons.scriptNotDaemon', { args: { filename: scriptFilename, mode: (script as any).mode ?? 'task' } }) ??
          `The script "${scriptFilename}" is not a daemon (mode=${(script as any).mode ?? 'task'}). ` +
          `Declare mode: daemon in the runtime block of SKILL.md to start it as a background process.`,
      );
    }
    if (script.language === 'javascript') {
      throw new BadRequestException('daemons.jsNotSupported');
    }

    // No active daemon for the same tuple (DB check)
    const existing = await this.daemonRepo.findOne({
      where: { userId, skillId, scriptFilename, status: In(['starting', 'running']) },
    });
    if (existing) {
      throw new BadRequestException(
        I18nContext.current()?.t('daemons.alreadyRunning', { args: { filename: scriptFilename, id: existing.id } }) ??
          `An active daemon already exists for "${scriptFilename}" (id: ${existing.id})`,
      );
    }

    // Zombie cleanup: stop in the executor the live processes for the same
    // skill+script+user even if the DB record is already stopped/error (or has
    // been cascade-deleted with the skill). Avoids silent duplicates.
    try {
      const liveDaemons = await this.executor.listDaemons();
      const zombies = liveDaemons.filter(
        (d) =>
          d.skill_id === skillId &&
          d.filename  === scriptFilename &&
          d.user_id   === userId &&
          d.running,
      );
      if (zombies.length > 0) {
        this.logger.warn(
          `Found ${zombies.length} zombie daemons in the executor for ` +
          `skill=${skillId.slice(0, 8)} script=${scriptFilename} — forced termination`,
        );
        await Promise.allSettled(
          zombies.map((z) => this.executor.stopDaemon(z.daemon_id)),
        );
      }
    } catch (err: any) {
      // Executor unreachable — proceed anyway (the executor will handle conflicts)
      this.logger.warn(`Unable to check for zombie daemons: ${err.message}`);
    }

    // Create DB record
    const daemon = this.daemonRepo.create({
      userId,
      skillId,
      scriptFilename,
      status: 'starting',
    });
    const saved = await this.daemonRepo.save(daemon);

    // Start in the executor
    try {
      await this.doStart(saved);
    } catch (err: any) {
      await this.daemonRepo.update(saved.id, {
        status:    'error',
        lastError: err.message,
      });
      throw err;
    }

    return this.daemonRepo.findOne({ where: { id: saved.id }, relations: { skill: true } }) as Promise<SkillDaemon>;
  }

  /**
   * Stop a running daemon.
   * Only the owner can stop it.
   */
  async stop(id: string, userId: string): Promise<SkillDaemon> {
    const daemon = await this.findOne(id, userId);

    if (!['starting', 'running'].includes(daemon.status)) {
      throw new BadRequestException(
        I18nContext.current()?.t('daemons.alreadyStopped', { args: { status: daemon.status } }) ??
          `Daemon already in state "${daemon.status}"`,
      );
    }

    // Ask the executor to stop it (best-effort: it may already be dead)
    try {
      await this.executor.stopDaemon(daemon.id);
    } catch (err: any) {
      this.logger.warn(`Executor stop error for daemon ${daemon.id}: ${err.message}`);
    }

    await this.daemonRepo.update(id, { status: 'stopped', lastError: null });
    return this.findOne(id, userId);
  }

  /**
   * Restart a daemon (stop + start).
   */
  async restart(id: string, userId: string): Promise<SkillDaemon> {
    const daemon = await this.findOne(id, userId);

    // Stop if still running
    if (['starting', 'running'].includes(daemon.status)) {
      try {
        await this.executor.stopDaemon(daemon.id);
      } catch { /* best-effort */ }
    }

    await this.daemonRepo.update(id, {
      status:    'starting',
      lastError: null,
      pid:       null,
      startedAt: null,
    });

    const updated = await this.daemonRepo.findOne({
      where: { id },
      relations: { skill: true },
    }) as SkillDaemon;

    await this.doStart(updated);
    return this.findOne(id, userId);
  }

  /**
   * Delete a daemon record (only if stopped or error).
   */
  async remove(id: string, userId: string): Promise<void> {
    const daemon = await this.findOne(id, userId);

    if (['starting', 'running'].includes(daemon.status)) {
      throw new BadRequestException('daemons.stopBeforeDelete');
    }

    await this.daemonRepo.remove(daemon);
  }

  // ── Internal event handling ─────────────────────────────────────────────────

  /**
   * Update the timestamp of the last event received from the daemon.
   * Called by InternalDaemonsController when an event arrives.
   */
  async recordEvent(daemonId: string): Promise<void> {
    await this.daemonRepo.update(daemonId, { lastEventAt: new Date() });
  }

  /**
   * Update the state after an unexpected daemon exit.
   */
  async handleDaemonExit(daemonId: string, exitCode: number | null): Promise<void> {
    const daemon = await this.daemonRepo.findOne({ where: { id: daemonId } });
    if (!daemon) return;

    // If it was explicitly stopped (stopped), don't change state
    if (daemon.status === 'stopped') return;

    await this.daemonRepo.update(daemonId, {
      status:    'error',
      lastError: exitCode !== null ? `Process terminated with exit code ${exitCode}` : 'Process terminated',
    });
    this.logger.warn(`Daemon ${daemonId.slice(0, 8)} exited unexpectedly (code=${exitCode})`);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Retrieve the list of live daemons from the executor.
   * Returns a Map<daemonId, DaemonStatusEntry> and a reachability flag.
   */
  private async fetchLiveDaemons(): Promise<{
    liveMap: Map<string, DaemonStatusEntry>;
    executorOk: boolean;
  }> {
    try {
      const list = await this.executor.listDaemons();
      return {
        liveMap:    new Map(list.map((d) => [d.daemon_id, d])),
        executorOk: true,
      };
    } catch {
      return { liveMap: new Map(), executorOk: false };
    }
  }

  /**
   * Sync the DB state of a user's daemons with the executor's reality.
   * Called by findAll() — best-effort, does not throw exceptions.
   */
  private async reconcileUser(userId: string): Promise<void> {
    const { liveMap, executorOk } = await this.fetchLiveDaemons();
    if (!executorOk) return;

    const active = await this.daemonRepo.find({
      where: { userId, status: In(['starting', 'running']) },
    });

    for (const daemon of active) {
      const live = liveMap.get(daemon.id);
      if (live?.running) {
        // Update PID if changed (e.g. after an executor restart)
        if (daemon.pid !== live.pid || daemon.status !== 'running') {
          await this.daemonRepo.update(daemon.id, { status: 'running', pid: live.pid });
        }
      } else {
        // Process dead — update the DB state
        await this.daemonRepo.update(daemon.id, {
          status:    'error',
          lastError: 'Process not found in the executor (detected on sync)',
        });
        this.logger.warn(
          `Daemon ${daemon.id.slice(0, 8)} marked 'error': not found in the executor`,
        );
      }
    }
  }

  /**
   * Make the call to the executor to start the daemon process.
   * Updates the DB record with the PID and 'running' state on success.
   */
  private async doStart(daemon: SkillDaemon): Promise<void> {
    const config   = await this.skillsSvc.resolveConfig(daemon.skillId);
    const backendUrl = this.cfg.get<string>('BACKEND_INTERNAL_URL', 'http://localhost:3000');
    const pushUrl  = `${backendUrl}/internal/daemons/events`;

    const skill = await this.skillRepo.findOne({ where: { id: daemon.skillId } });
    const script = await this.scriptRepo.findOne({
      where: { skillId: daemon.skillId, filename: daemon.scriptFilename },
    });

    if (!skill || !script) {
      throw new Error(`Skill or script not found for daemon ${daemon.id}`);
    }

    const result = await this.executor.startDaemon({
      skill_id:  daemon.skillId,
      daemon_id: daemon.id,
      filename:  daemon.scriptFilename,
      language:  script.language as 'python' | 'node',
      config,
      user_id:   daemon.userId,
      push_url:  pushUrl,
      // Signed daemon token (no expiry): revocation happens by stopping the daemon.
      daemon_token: mintDaemonToken(daemon.userId, daemon.id),
    });

    await this.daemonRepo.update(daemon.id, {
      status:    'running',
      pid:       result.pid,
      startedAt: new Date(result.started_at),
      lastError: null,
    });
  }
}
