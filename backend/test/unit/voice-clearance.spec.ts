// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Sensitive actions by voice only for a recognised voice (voice-id/voice-clearance.ts): the policy, the decision, the
 * tool guard (a no-op outside voice turns or when off), targets told by a tool, and the sequences started in a voice
 * turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  DEFAULT_VOICE_CLEARANCE, decide, globMatch, guardTool, guardTools, markVoiceTargets, normalizePolicy, runWithVoiceClearance,
  setVoiceClearancePolicy, currentVoiceClearance, type VoiceClearance,
} from '../../src/voice-id/voice-clearance';
import { isActionTool, markActionTool, withReplyArg } from '../../src/agent/action-replies';
import { SequencesService } from '../../src/sequences/sequences.service';
import { DEFAULT_LIMITS } from '../../src/sequences/sequence-program';

const known = (score = 0.7, profileId = 'v-1'): VoiceClearance => ({ speaker: { profileId, name: 'Alex', score }, satellite: 'sat.kitchen' });
const stranger: VoiceClearance = { speaker: null, satellite: 'sat.kitchen' };

function tool(name: string, impl = vi.fn(async () => '{"ok":true}')) {
  const t = new DynamicStructuredTool({ name, description: name, schema: z.object({ x: z.string().optional() }), func: impl });
  return { t, impl };
}

/** A tool that tells its targets: `ids` from the args, sensitive when they start with `lock.` (like the HA rule). */
function targeted(name = 'home_call') {
  const impl = vi.fn(async () => '{"ok":true}');
  const t = new DynamicStructuredTool({ name, description: name, schema: z.object({ ids: z.array(z.string()) }), func: impl });
  markVoiceTargets(t, (args: any) => (args.ids ?? []).map((id: string) => ({ id, sensitive: id.startsWith('lock.') })));
  return { t, impl };
}

afterEach(() => setVoiceClearancePolicy(DEFAULT_VOICE_CLEARANCE));

describe('policy and decision', () => {
  it('normalises: off by default, score in 0–1, trimmed bounded lists, sensitive targets on unless turned off', () => {
    expect(normalizePolicy(null)).toEqual({ ...DEFAULT_VOICE_CLEARANCE, minScore: DEFAULT_VOICE_CLEARANCE.minScore });
    const p = normalizePolicy({ enabled: true, minScore: 3, tools: [' a ', '', 7 as any], entities: ['lock'], sensitiveTargets: false });
    expect(p).toMatchObject({ enabled: true, minScore: 1, tools: ['a'], entities: ['lock'], sensitiveTargets: false });
    expect(normalizePolicy({ minScore: -1 }).minScore).toBe(0);
  });

  it('matches globs case-insensitively, and an entity rule without a dot as a domain', () => {
    expect(globMatch('skill_mail_*', 'SKILL_MAIL_send')).toBe(true);
    expect(globMatch('ha_notify', 'ha_notify_x')).toBe(false);
    const p = normalizePolicy({ enabled: true, entities: ['lock', 'cover.garage*'], sensitiveTargets: false });
    expect(decide(p, stranger, 'any', [{ id: 'lock.front', sensitive: false }])).toMatchObject({ ok: false, protectedBy: 'lock.front' });
    expect(decide(p, stranger, 'any', [{ id: 'cover.garage_door', sensitive: false }]).ok).toBe(false);
    expect(decide(p, stranger, 'any', [{ id: 'cover.kitchen', sensitive: false }]).ok).toBe(true);
  });

  it('clears a protected call only for a recognised voice above the score, and one of the people if set', () => {
    const p = normalizePolicy({ enabled: true, minScore: 0.65, tools: ['gate_*'] });
    expect(decide(p, stranger, 'light_on', []).ok).toBe(true); // not protected: anyone
    expect(decide(p, stranger, 'gate_open', [])).toMatchObject({ ok: false, reason: 'not_recognised' });
    expect(decide(p, known(0.6), 'gate_open', [])).toMatchObject({ ok: false, reason: 'low_confidence' });
    expect(decide(p, known(0.7), 'gate_open', []).ok).toBe(true);
    const only = normalizePolicy({ ...p, people: ['v-2'] });
    expect(decide(only, known(0.9, 'v-1'), 'gate_open', [])).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(decide(only, known(0.9, 'v-2'), 'gate_open', []).ok).toBe(true);
  });
});

describe('tool guard', () => {
  it('changes nothing outside a voice turn, or with the clearance off', async () => {
    setVoiceClearancePolicy({ enabled: true, tools: ['gate_open'] });
    const { t } = tool('gate_open');
    expect(guardTool(t)).toBe(t);
    setVoiceClearancePolicy({ enabled: false, tools: ['gate_open'] });
    runWithVoiceClearance(stranger, () => expect(guardTool(t)).toBe(t));
    const list = [t];
    runWithVoiceClearance(stranger, () => expect(guardTools(list)).toBe(list));
  });

  it('leaves alone a tool that cannot be protected, and wraps the others keeping name, schema and metadata', () => {
    setVoiceClearancePolicy({ enabled: true, tools: ['gate_*'] });
    const { t: light } = tool('light_on');
    const { t: gate } = tool('gate_open');
    markActionTool(gate);
    runWithVoiceClearance(stranger, () => {
      expect(guardTool(light)).toBe(light);
      const g = guardTool(gate) as any;
      expect(g).not.toBe(gate);
      expect(g.name).toBe('gate_open');
      expect(g.schema).toBe(gate.schema);
      expect(isActionTool(g)).toBe(true);
      expect(guardTool(g)).toBe(g); // idempotent
    });
  });

  it('refuses a protected call for a voice it does not recognise, without running it, and runs it for a known one', async () => {
    setVoiceClearancePolicy({ enabled: true, tools: ['gate_open'] });
    const { t, impl } = tool('gate_open');
    const refused = await runWithVoiceClearance(stranger, () => guardTool(t).invoke({}));
    expect(JSON.parse(refused as string)).toMatchObject({ error: 'voice_not_authorized', reason: 'not_recognised' });
    expect(impl).not.toHaveBeenCalled();
    const ok = await runWithVoiceClearance(known(0.8), () => guardTool(t).invoke({ x: 'a' }));
    expect(ok).toBe('{"ok":true}');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('checks what a call acts on: a sensitive target or an entity rule, however the call names it', async () => {
    setVoiceClearancePolicy({ enabled: true, entities: ['switch.gate'] });
    const { t, impl } = targeted();
    await runWithVoiceClearance(stranger, async () => {
      const g = guardTool(t);
      expect(await g.invoke({ ids: ['light.kitchen'] })).toBe('{"ok":true}');
      expect(JSON.parse(await g.invoke({ ids: ['light.kitchen', 'lock.front'] }) as string).error).toBe('voice_not_authorized');
      expect(JSON.parse(await g.invoke({ ids: ['switch.gate'] }) as string).error).toBe('voice_not_authorized');
    });
    expect(impl).toHaveBeenCalledTimes(1);
    setVoiceClearancePolicy({ enabled: true, sensitiveTargets: false });
    await runWithVoiceClearance(stranger, async () => expect(await guardTool(t).invoke({ ids: ['lock.front'] })).toBe('{"ok":true}'));
  });

  it('a refused tool that answers content and files answers with no files', async () => {
    setVoiceClearancePolicy({ enabled: true, tools: ['cam'] });
    const t = new DynamicStructuredTool({
      name: 'cam', description: 'cam', schema: z.object({}), responseFormat: 'content_and_artifact',
      func: async () => ['shot', { toolFiles: [] }] as any,
    });
    const out: any = await runWithVoiceClearance(stranger, () => guardTool(t).invoke({ id: '1', name: 'cam', args: {}, type: 'tool_call' }));
    expect(JSON.parse(out.content).error).toBe('voice_not_authorized');
  });

  it('the action-reply wrapper keeps the guard (the reply argument is dropped before the check runs the tool)', async () => {
    setVoiceClearancePolicy({ enabled: true, tools: ['gate_open'] });
    const { t, impl } = tool('gate_open');
    markActionTool(t);
    const out = await runWithVoiceClearance(stranger, () => withReplyArg(guardTool(t) as any).invoke({ reply: 'Fatto' }));
    expect(JSON.parse(out as string).error).toBe('voice_not_authorized');
    expect(impl).not.toHaveBeenCalled();
  });

  it('the clearance reaches work started in the turn and still running after it', async () => {
    let seen: VoiceClearance | null | undefined;
    await runWithVoiceClearance(stranger, async () => {
      setTimeout(() => { seen = currentVoiceClearance(); }, 5);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(stranger);
    expect(currentVoiceClearance()).toBeNull();
  });
});

describe('a sequence started in a voice turn', () => {
  it('cannot do by repetition what the voice may not do once', async () => {
    setVoiceClearancePolicy({ enabled: true, tools: ['gate_open'] });
    const { t: gate, impl } = tool('gate_open');
    const svc = new SequencesService(DEFAULT_LIMITS, null, null, null, null);
    await runWithVoiceClearance(stranger, async () => {
      const turnTools = guardTools([gate]) as any[];
      const r = svc.start({ steps: [{ call: { tool: 'gate_open', args: {} } }] }, { userId: 'u1', chatId: null, tools: turnTools });
      expect(r.ok).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(impl).not.toHaveBeenCalled();
  });
});
