/**
 * @file activity.service.ts
 *
 * "Ongoing Activity" dashboard: aggregates into a single view everything that is
 * running or scheduled for the user — skill daemons, automations
 * (Auto-Scheduling), flows with cron/scheduled triggers, and the latest runs.
 * Read-only: reuses the existing services + the flow_runs repo.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DaemonsService } from '../daemons/daemons.service';
import { FlowsService } from '../flows/flows.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { FlowRun } from '../flows/flow-run.entity';

@Injectable()
export class ActivityService {
  constructor(
    private readonly daemons: DaemonsService,
    private readonly flows: FlowsService,
    private readonly scheduling: SchedulingService,
    @InjectRepository(FlowRun) private readonly runRepo: Repository<FlowRun>,
  ) {}

  async getActivity(userId: string) {
    const [daemons, flows, tasks, runs] = await Promise.all([
      this.daemons.findAll(userId),
      this.flows.findAll(userId),
      this.scheduling.list(userId),
      this.runRepo.find({ where: { userId }, order: { startedAt: 'DESC' }, take: 15 }),
    ]);

    const activeDaemons = daemons
      .filter((d) => d.status === 'running' || d.status === 'starting')
      .map((d) => ({ id: d.id, skillId: d.skillId, script: d.scriptFilename, status: d.status, startedAt: d.startedAt, lastEventAt: d.lastEventAt }));

    const scheduledFlows = flows
      .filter((f) => (f.trigger?.type === 'cron' || f.trigger?.type === 'scheduled') && f.enabled)
      .map((f) => ({ id: f.id, name: f.name, type: f.trigger.type, cron: f.trigger.cron ?? null, runAt: f.trigger.runAt ?? null }));

    const automations = tasks.map((t) => ({
      id: t.id, title: t.title, scheduleType: t.scheduleType, cron: t.cron, runAt: t.runAt,
      status: t.status, enabled: t.enabled, lastRunAt: t.lastRunAt,
      lastTokens: (t.lastInputTokens ?? 0) + (t.lastOutputTokens ?? 0), totalTokens: t.totalTokens,
    }));

    const recentRuns = runs.map((r) => ({
      id: r.id, flowName: r.flowName, status: r.status, triggeredBy: r.triggeredBy,
      startedAt: r.startedAt, finishedAt: r.finishedAt,
    }));

    return {
      counts: {
        daemons: activeDaemons.length,
        automationsActive: automations.filter((a) => a.status === 'active').length,
        automationsPending: automations.filter((a) => a.status === 'pending').length,
        scheduledFlows: scheduledFlows.length,
      },
      daemons: activeDaemons,
      automations,
      scheduledFlows,
      recentRuns,
    };
  }
}
