// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ha-triggers.service.ts
 *
 * Home Assistant starts Arkimede's flows: a flow whose trigger is `home-assistant` runs, as its owner, when the entity
 * it names changes state — "when the doorbell rings", "when Chloé gets home", "when the washing machine finishes". Only
 * entities exposed to Assist, only for owners allowed the Home Assistant tools, only real changes (a new state, not an
 * attribute), at most once per flow every `cooldownSeconds` (30). The flows are read again every minute (a flow saved
 * or switched off is followed within a minute).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FlowsService } from '../flows/flows.service';
import type { Flow } from '../flows/flow.entity';
import { HomeAssistantService } from './home-assistant.service';

const RELOAD_MS = 60_000;
const DEFAULT_COOLDOWN_S = 30;

/** Whether an entity id matches a trigger's pattern (`*` = any characters). */
export function entityMatches(pattern: string, entityId: string): boolean {
  const p = pattern.trim();
  if (!p.includes('*')) return p === entityId;
  const re = new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(entityId);
}

@Injectable()
export class HaTriggersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HaTriggersService.name);
  private flows: Flow[] = [];
  private readonly lastRun = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ha: HomeAssistantService, private readonly flowsService: FlowsService) {}

  onModuleInit(): void {
    this.unsubscribe = this.ha.onStateChanged((id, from, to) => void this.onChange(id, from, to));
    void this.reload();
    this.timer = setInterval(() => void this.reload(), RELOAD_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    try {
      this.flows = await this.flowsService.homeAssistantFlows();
    } catch (err) {
      this.logger.warn(`Home Assistant flows not read: ${(err as Error).message}`);
    }
  }

  /** A state change: the flows it starts. Returns how many were started. */
  async onChange(entityId: string, from: any | null, to: any | null, now = Date.now()): Promise<number> {
    if (!to || from?.state === to.state || !this.ha.isExposed(entityId)) return 0;
    let started = 0;
    for (const flow of this.flows) {
      const t = flow.trigger?.ha;
      if (!t?.entityId || !entityMatches(t.entityId, entityId)) continue;
      if (t.to !== undefined && t.to !== '' && t.to !== to.state) continue;
      if (t.from !== undefined && t.from !== '' && t.from !== from?.state) continue;
      if (!flow.userId || !this.ha.toolsFor(flow.userId)) continue;
      const cooldownMs = (t.cooldownSeconds ?? DEFAULT_COOLDOWN_S) * 1000;
      if (now - (this.lastRun.get(flow.id) ?? 0) < cooldownMs) continue;
      this.lastRun.set(flow.id, now);
      started++;
      const input = {
        entity_id: entityId, name: to.attributes?.friendly_name ?? entityId, area: this.ha.areaOf(entityId),
        from: from?.state ?? null, to: to.state, at: new Date(now).toISOString(),
      };
      this.logger.log(`Home Assistant: ${entityId} ${from?.state ?? '?'} → ${to.state} starts flow "${flow.name}"`);
      void this.flowsService.runByHomeAssistant(flow, input)
        .catch((err) => this.logger.warn(`flow "${flow.name}" (Home Assistant trigger) failed: ${(err as Error).message}`));
    }
    return started;
  }
}
