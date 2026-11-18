// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Voice as a delivery channel of the automations (SchedulingService + VoiceDeliveryService): an automation asked for by
 * voice is said aloud by default; the run is told that its reply is the delivery; the outcome is said where the user is
 * confirmed present (the chat and the notification always carry it); a failed run is not said.
 */
import { describe, expect, it, vi } from 'vitest';
import { SchedulingService, whenOf } from '../../src/scheduling/scheduling.service';
import { VoiceDeliveryService, speakable, SPOKEN_MAX_CHARS } from '../../src/notifications/voice-delivery.service';
import { currentVoiceClearance, runWithVoiceClearance } from '../../src/voice-id/voice-clearance';

const WYOMING_CHAT = '11111111-1111-4111-8111-111111111111';
const WEB_CHAT = '22222222-2222-4222-8222-222222222222';

function makeService(opts: { reply?: string; fail?: boolean; spokenOn?: string | null } = {}) {
  const tasks = new Map<string, any>();
  const repo = {
    count: vi.fn(async () => 0),
    create: (x: any) => ({ id: 't1', ...x }),
    save: vi.fn(async (t: any) => { tasks.set(t.id, t); return t; }),
    findOne: vi.fn(async ({ where }: any) => tasks.get(where.id) ?? null),
  };
  const chats: Record<string, { id: string; userId: string; externalSource: string | null }> = {
    [WYOMING_CHAT]: { id: WYOMING_CHAT, userId: 'u1', externalSource: 'wyoming' },
    [WEB_CHAT]: { id: WEB_CHAT, userId: 'u1', externalSource: null },
  };
  const chatRepo = {
    findOne: vi.fn(async ({ where }: any) => {
      const c = chats[where.id];
      return c && (!where.userId || c.userId === where.userId) ? c : null;
    }),
    save: vi.fn(async (c: any) => ({ id: 'dedicated', ...c })),
    create: (x: any) => x,
    update: vi.fn(async () => undefined),
  };
  const messageRepo = { save: vi.fn(async (m: any) => m), create: (x: any) => x };
  const notifications = { create: vi.fn(async () => ({ id: 'n1' })) };
  const gateway = { emitToUser: vi.fn() };
  const voice = { deliver: vi.fn(async () => (opts.spokenOn === undefined ? 'assist_satellite.studio' : opts.spokenOn)) };
  const agent = {
    invokeWithUsage: vi.fn(async () => {
      if (opts.fail) throw new Error('model down');
      return { text: opts.reply ?? 'È ora di andare a prendere Sam.', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  };
  const config = { get: (_k: string, d?: any) => d };
  const svc = new SchedulingService(config as any, {} as any, repo as any, chatRepo as any, messageRepo as any,
    notifications as any, gateway as any, voice as any);
  vi.spyOn(svc as any, 'agentService').mockReturnValue(agent);
  return { svc, tasks, voice, agent, notifications };
}

describe('automations: voice delivery', () => {
  it('asked for by voice → voice on; from a web chat → off; explicit wins; a foreign or non-chat origin is dropped', async () => {
    const { svc } = makeService();
    const base = { instruction: 'x', runAt: new Date(Date.now() + 60_000).toISOString() };
    expect(await svc.createTask('u1', { ...base, chatId: WYOMING_CHAT })).toMatchObject({ voice: true, chatId: WYOMING_CHAT });
    expect(await svc.createTask('u1', { ...base, chatId: WEB_CHAT })).toMatchObject({ voice: false, chatId: WEB_CHAT });
    expect(await svc.createTask('u1', { ...base, chatId: WEB_CHAT, voice: true })).toMatchObject({ voice: true });
    expect(await svc.createTask('u1', { ...base, chatId: WYOMING_CHAT, voice: false })).toMatchObject({ voice: false });
    expect(await svc.createTask('u2', { ...base, chatId: WYOMING_CHAT })).toMatchObject({ voice: false, chatId: null });
    expect(await svc.createTask('u1', { ...base, chatId: 'wyoming:192.168.1.10' })).toMatchObject({ voice: false, chatId: null });
  });

  it('asked for in a voice turn before its chat exists: voice on; the chat it is confirmed in becomes the delivery chat', async () => {
    const { svc } = makeService();
    const task = await svc.createTask('u1', { instruction: 'x', runAt: new Date(Date.now() + 60_000).toISOString(), chatId: 'wyoming:conv-1', fromVoice: true });
    expect(task).toMatchObject({ voice: true, chatId: null });
    (svc as any).registerJob = vi.fn(async () => undefined);
    expect(await svc.activate('t1', 'u1', WYOMING_CHAT)).toMatchObject({ status: 'active', chatId: WYOMING_CHAT });
  });

  it('the schedule tool reads the voice origin from the run\'s context', async () => {
    const { svc } = makeService();
    (svc as any).enabled = true;
    const { runWithLlmCallContext } = await import('../../src/usage/llm-call-context');
    const [schedule] = svc.buildSchedulingTools('u1', undefined, 'wyoming:conv-1');
    const runAt = new Date(Date.now() + 60_000).toISOString();
    await runWithLlmCallContext({ origin: 'voice' }, () => schedule.invoke({ instruction: 'x', runAt }));
    const voiced = await (svc as any).repo.findOne({ where: { id: 't1' } });
    expect(voiced.voice).toBe(true);
    await runWithLlmCallContext({ origin: 'chat' }, () => schedule.invoke({ instruction: 'y', runAt }));
    expect((await (svc as any).repo.findOne({ where: { id: 't1' } })).voice).toBe(false);
  });

  it('a voice automation: the run is told it is the delivery, the outcome is said in the chat\'s name and noted', async () => {
    const t = makeService();
    await t.svc.createTask('u1', { instruction: 'Ricorda di prendere Sam alle 18.30', runAt: new Date(Date.now() + 60_000).toISOString(), chatId: WYOMING_CHAT });
    await (t.svc as any).runTask('t1');
    const input = t.agent.invokeWithUsage.mock.calls[0][0] as string;
    expect(input).toMatch(/said aloud/);
    expect(input).toMatch(/never answer that you cannot deliver it or cannot speak/);
    expect(input.endsWith('Ricorda di prendere Sam alle 18.30')).toBe(true);
    expect(t.voice.deliver).toHaveBeenCalledWith('u1', 'È ora di andare a prendere Sam.', WYOMING_CHAT);
    expect(t.notifications.create.mock.calls[0][0].payload).toMatchObject({ chatId: WYOMING_CHAT, spoken: true });
  });

  it('nobody present: not said, the chat and the notification carry it; a plain automation is never said', async () => {
    const absent = makeService({ spokenOn: null });
    await absent.svc.createTask('u1', { instruction: 'x', runAt: new Date(Date.now() + 60_000).toISOString(), chatId: WYOMING_CHAT });
    await (absent.svc as any).runTask('t1');
    expect(absent.notifications.create.mock.calls[0][0].payload).toMatchObject({ spoken: false });

    const plain = makeService();
    await plain.svc.createTask('u1', { instruction: 'x', runAt: new Date(Date.now() + 60_000).toISOString(), chatId: WEB_CHAT });
    await (plain.svc as any).runTask('t1');
    expect(plain.voice.deliver).not.toHaveBeenCalled();
    expect(plain.agent.invokeWithUsage.mock.calls[0][0]).not.toMatch(/aloud/);
  });

  it('a failed run is not said', async () => {
    const t = makeService({ fail: true });
    await t.svc.createTask('u1', { instruction: 'x', runAt: new Date(Date.now() + 60_000).toISOString(), chatId: WYOMING_CHAT });
    await (t.svc as any).runTask('t1');
    expect(t.voice.deliver).not.toHaveBeenCalled();
  });
});

describe('VoiceDeliveryService', () => {
  it('says through the registered channel: to the user\'s own person, or where asked; nothing without a channel', async () => {
    const ds = { query: vi.fn(async () => [{ haPerson: 'person.sam' }]) };
    const v = new VoiceDeliveryService(ds as any);
    expect(await v.deliver('u1', 'ciao', 'c1')).toBeNull();
    const channel = { sayWherePresent: vi.fn(async () => 'assist_satellite.x'), placeArea: () => null };
    v.setChannel(channel);
    expect(await v.deliver('u1', '**Ciao** [Sam](http://x)', 'c1')).toBe('assist_satellite.x');
    expect(channel.sayWherePresent).toHaveBeenCalledWith('u1', 'Ciao Sam', 'c1', { person: 'person.sam' });
    // A room or a person asked for: as asked, no look-up of the user's own person.
    await v.deliver('u1', 'ciao', 'c1', { areaId: 'cucina' });
    expect(channel.sayWherePresent).toHaveBeenLastCalledWith('u1', 'ciao', 'c1', { areaId: 'cucina' });
    expect(ds.query).toHaveBeenCalledTimes(1);
    channel.sayWherePresent.mockRejectedValueOnce(new Error('HA down'));
    expect(await v.deliver('u1', 'ciao', 'c1')).toBeNull();
  });

  it('speakable: no markdown, no links, cut at a sentence end', () => {
    expect(speakable('# Titolo\n- uno\n- **due** `tre`\nvedi https://x.y/z')).toBe('Titolo uno due tre vedi');
    const long = 'Frase breve. '.repeat(100);
    const s = speakable(long);
    expect(s.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(s.endsWith('.')).toBe(true);
  });
});

describe('whenOf', () => {
  it('a one-shot in its own zone beside the instant; a cron as is; no zone: UTC', () => {
    const runAt = new Date('2026-11-10T14:02:00Z');
    expect(whenOf({ scheduleType: 'scheduled', cron: null, runAt, timezone: 'Europe/Rome' } as any))
      .toBe('on Tue, 10/11/2026, 15:02 local time (Europe/Rome) = 2026-11-10T14:02:00.000Z');
    expect(whenOf({ scheduleType: 'scheduled', cron: null, runAt, timezone: null } as any)).toBe('on 2026-11-10T14:02:00.000Z (UTC)');
    expect(whenOf({ scheduleType: 'cron', cron: '0 8 * * *', runAt: null, timezone: 'Europe/Rome' } as any)).toBe('cron "0 8 * * *" (Europe/Rome)');
    expect(whenOf({ scheduleType: 'scheduled', cron: null, runAt, timezone: 'Not/AZone' } as any)).toBe('on 2026-11-10T14:02:00.000Z');
  });
});

describe('automations asked for by voice: voice clearance', () => {
  const runAt = () => new Date(Date.now() + 60_000).toISOString();
  const stranger = { speaker: null, satellite: 'sat.ingresso' };

  it('keep who spoke and run as that turn did; one made in the app keeps none and runs unchecked', async () => {
    const t = makeService();
    let during: unknown = 'unset';
    t.agent.invokeWithUsage.mockImplementation(async () => { during = currentVoiceClearance(); return { text: 'ok', usage: null } as any; });
    const voiced = await runWithVoiceClearance(stranger, () => t.svc.createTask('u1', { instruction: 'apri il cancello', runAt: runAt(), fromVoice: true }));
    expect(voiced.voiceClearance).toEqual(stranger);
    await (t.svc as any).runTask('t1', true);
    expect(during).toEqual(stranger);

    const app = await t.svc.createTask('u1', { instruction: 'x', runAt: runAt() });
    expect(app.voiceClearance).toBeNull();
    await (t.svc as any).runTask('t1', true);
    expect(during).toBeNull();
  });

  it('changing what it does in the app clears it; changing it by voice takes the new speaker', async () => {
    const t = makeService();
    await runWithVoiceClearance(stranger, () => t.svc.createTask('u1', { instruction: 'x', runAt: runAt(), fromVoice: true }));
    (t.svc as any).removeJobs = vi.fn(async () => undefined);
    (t.svc as any).registerJob = vi.fn(async () => undefined);
    (t.svc as any).repo.findOne = vi.fn(async () => t.tasks.get('t1'));
    const known = { speaker: { profileId: 'v-1', name: 'Alex', score: 0.8 }, satellite: 'sat.cucina' };
    await runWithVoiceClearance(known, () => t.svc.update('t1', 'u1', false, { instruction: 'y' }));
    expect(t.tasks.get('t1').voiceClearance).toEqual(known);
    await t.svc.update('t1', 'u1', false, { title: 'only the title' });
    expect(t.tasks.get('t1').voiceClearance).toEqual(known);
    await t.svc.update('t1', 'u1', false, { instruction: 'z' });
    expect(t.tasks.get('t1').voiceClearance).toBeNull();
  });
});

