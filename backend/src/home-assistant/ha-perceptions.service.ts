// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ha-perceptions.service.ts
 *
 * What the house noticed, remembered (opt-in, admin settings): a state change of an entity the admin chose that is an
 * event (ha-perceptions.ts — a sensor on, the doorbell, a door opened, an alarm) is sent to the memory as a perception
 * (Recordare `perceive`), for the memory the presence goes to (the Wyoming user's). In that memory's language, with the
 * entity's name and room, never a person's name. At most one per entity every few minutes; nothing when the switch is
 * off, Recordare is not configured or that user's memory is off. Telling someone at once (a stranger at the door) is
 * the flows' job (trigger home-assistant): a perception is only the memory of it.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { RecordareInitiativesService } from '../recordare/recordare-initiatives.service';
import { HomeAssistantService } from './home-assistant.service';
import { PerceptionGate, entityChosen, perceptionOf } from './ha-perceptions';

@Injectable()
export class HaPerceptionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HaPerceptionsService.name);
  private readonly gate = new PerceptionGate();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly ha: HomeAssistantService,
    private readonly initiatives: RecordareInitiativesService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.ha.onStateChanged((id, from, to) => void this.onChange(id, from, to));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** A state change: sent as a perception when it is one. Returns whether it was sent. */
  async onChange(entityId: string, from: any | null, to: any | null, now = Date.now()): Promise<boolean> {
    const target = this.ha.perceptionTarget();
    if (!target || !entityChosen(target.entities, entityId)) return false;
    const language = (await this.users.findOne({ where: { id: target.userId }, select: { id: true, language: true } }))?.language ?? null;
    const perception = perceptionOf(entityId, from, to, {
      name: String(to?.attributes?.friendly_name ?? entityId), area: this.ha.areaOf(entityId), camera: this.ha.onCameraDevice(entityId), language,
    });
    if (!perception || !this.gate.pass(entityId, now)) return false;
    const res = await this.initiatives.perceive(target.userId, perception);
    if (res) this.logger.log(`perception from ${entityId} (${perception.sensor}${perception.place ? `, ${perception.place}` : ''})${res.duplicate ? ': duplicate' : ''}`);
    return !!res;
  }
}
