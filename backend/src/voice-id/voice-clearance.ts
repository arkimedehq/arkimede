// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file voice-clearance.ts
 *
 * Sensitive actions by voice only for a recognised voice (admin setting, off by default).
 *
 * A voice turn runs as the satellite's account, whoever speaks. With the clearance on, a tool the admin marks as
 * protected — by its name, or by what it acts on (a Home Assistant entity) — runs in a voice turn only when the voice
 * was recognised with at least the configured similarity score (and, if a list is set, is one of its people). Otherwise it
 * does nothing and tells the model why, so the agent says so.
 *
 * - The turn's clearance (who spoke) travels in an AsyncLocalStorage set around the voice turn: the tools of the turn,
 *   the agents it delegates to, the sequences it starts and the work that goes on after the hub stops waiting all see
 *   it. An automation created in a voice turn keeps it and runs under it.
 * - Outside a voice turn (chat, API, automations made elsewhere) there is no clearance and nothing is checked.
 * - The policy is held here (set by VoiceIdService from app_config), so the agent code needs no Nest dependency.
 * - A tool tells what it acts on through `markVoiceTargets` (the Home Assistant service call: the entities a name or an
 *   area resolves to, each with its own sensitivity), so a protected entity is caught however it is named.
 *
 * The check is in code, not in the prompt: a model that ignores the instructions still cannot act.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { voiceNotAuthorized } from '../prompts/prompts';
import { STRONG_THRESHOLD } from './voice-match';

/** Who spoke in a voice turn: the recognised voice, or null (not recognised, recognition off, being learned). */
export interface VoiceClearance {
  speaker: { profileId: string; name: string; score: number } | null;
  /** The satellite the turn came from (for the log). */
  satellite: string | null;
}

/** What is protected and who may do it (app_config.voiceClearance). */
export interface VoiceClearancePolicy {
  enabled: boolean;
  /** Lowest voice similarity score (0–1, as the recognitions list shows it) that clears a protected action. */
  minScore: number;
  /** Voice profiles allowed; empty = any recognised voice. */
  people: string[];
  /** Tool names protected, `*` allowed (e.g. `skill_gmail_*`, `ha_notify`). */
  tools: string[];
  /** Entities protected, by id or domain, `*` allowed (e.g. `lock`, `cover.garage*`, `switch.gate`). */
  entities: string[];
  /** Also protect what the integration itself deems sensitive (locks, alarms, garage doors, gates). */
  sensitiveTargets: boolean;
}

export const DEFAULT_VOICE_CLEARANCE: VoiceClearancePolicy = {
  enabled: false,
  minScore: STRONG_THRESHOLD,
  people: [],
  tools: [],
  entities: [],
  sensitiveTargets: true,
};

/** Bounds of the stored policy (admin input). */
export const VOICE_CLEARANCE_MAX_RULES = 100;

/** A target a tool call acts on: its id (e.g. a Home Assistant entity id) and whether the integration deems it sensitive. */
export interface VoiceTarget {
  id: string;
  sensitive: boolean;
}

const logger = new Logger('VoiceClearance');
const als = new AsyncLocalStorage<VoiceClearance>();
let policy: VoiceClearancePolicy = DEFAULT_VOICE_CLEARANCE;

/** Normalises a stored or submitted policy: defaults for what is missing, bounded lists, a confidence in 0–1. */
export function normalizePolicy(raw: Partial<VoiceClearancePolicy> | null | undefined): VoiceClearancePolicy {
  const list = (v: unknown) => (Array.isArray(v) ? v : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, VOICE_CLEARANCE_MAX_RULES);
  const min = Number(raw?.minScore);
  return {
    enabled: raw?.enabled === true,
    minScore: Number.isFinite(min) ? Math.min(1, Math.max(0, min)) : DEFAULT_VOICE_CLEARANCE.minScore,
    people: list(raw?.people),
    tools: list(raw?.tools),
    entities: list(raw?.entities),
    sensitiveTargets: raw?.sensitiveTargets !== false,
  };
}

/** The policy in force (VoiceIdService keeps it current). */
export function voiceClearancePolicy(): VoiceClearancePolicy {
  return policy;
}

export function setVoiceClearancePolicy(next: Partial<VoiceClearancePolicy> | null | undefined): void {
  policy = normalizePolicy(next);
}

/** Runs `fn` as a voice turn with `clearance` (who spoke). */
export function runWithVoiceClearance<T>(clearance: VoiceClearance, fn: () => T): T {
  return als.run(clearance, fn);
}

/** The clearance of the voice turn running now, or null outside one. */
export function currentVoiceClearance(): VoiceClearance | null {
  return als.getStore() ?? null;
}

/** `*` matches any run of characters; case-insensitive. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(value);
}

/** An entity rule matches its id, or its domain when the rule has no dot (`lock` = every `lock.*`). */
function entityMatch(rule: string, id: string): boolean {
  return rule.includes('.') ? globMatch(rule, id) : globMatch(rule, id.split('.')[0] ?? '');
}

/** Declares what a call of `tool` acts on, from its arguments (the guard checks those targets). */
export function markVoiceTargets<T extends { metadata?: Record<string, unknown> }>(
  tool: T, targets: (args: Record<string, unknown>) => VoiceTarget[] | Promise<VoiceTarget[]>,
): T {
  tool.metadata = { ...(tool.metadata ?? {}), voiceTargets: targets };
  return tool;
}

function targetsHook(tool: any): ((args: Record<string, unknown>) => VoiceTarget[] | Promise<VoiceTarget[]>) | null {
  const fn = tool?.metadata?.voiceTargets;
  return typeof fn === 'function' ? fn : null;
}

export type ClearanceDecision =
  | { ok: true }
  | { ok: false; reason: 'not_recognised' | 'low_confidence' | 'not_allowed'; protectedBy: string };

/** What protects this call, if anything: the tool's name, or a target (by a rule or by its own sensitivity). */
export function protectionOf(p: VoiceClearancePolicy, toolName: string, targets: VoiceTarget[]): string | null {
  const byName = p.tools.find((r) => globMatch(r, toolName));
  if (byName) return `tool ${toolName}`;
  for (const t of targets) {
    if (p.sensitiveTargets && t.sensitive) return t.id;
    if (p.entities.some((r) => entityMatch(r, t.id))) return t.id;
  }
  return null;
}

/** Whether `clearance` may make this call under policy `p`. */
export function decide(p: VoiceClearancePolicy, clearance: VoiceClearance, toolName: string, targets: VoiceTarget[]): ClearanceDecision {
  const protectedBy = protectionOf(p, toolName, targets);
  if (!protectedBy) return { ok: true };
  const s = clearance.speaker;
  if (!s) return { ok: false, reason: 'not_recognised', protectedBy };
  if (s.score < p.minScore) return { ok: false, reason: 'low_confidence', protectedBy };
  if (p.people.length && !p.people.includes(s.profileId)) return { ok: false, reason: 'not_allowed', protectedBy };
  return { ok: true };
}

const GUARDED = Symbol('voiceGuarded');

/** Whether the tool may be protected at all under `p` (by its name, or because it tells its targets). */
function mayBeProtected(p: VoiceClearancePolicy, tool: any): boolean {
  if (p.tools.some((r) => globMatch(r, tool.name))) return true;
  return !!targetsHook(tool) && (p.sensitiveTargets || p.entities.length > 0);
}

/**
 * The tool, guarded for the current voice turn: a protected call is refused unless the voice clears it. Outside a
 * voice turn, with the clearance off, or for a tool that cannot be protected, the tool itself (nothing changes).
 * The clearance is the one of the turn the tools are built for (captured now): the sequences and the background work
 * started from the turn are checked against it too.
 */
export function guardTool<T extends { name: string }>(tool: T): T | DynamicStructuredTool<any> {
  const clearance = currentVoiceClearance();
  const p = policy;
  const t = tool as any;
  if (!clearance || !p.enabled || t[GUARDED] || !mayBeProtected(p, t)) return tool;
  const hook = targetsHook(t);
  const guarded = new DynamicStructuredTool<any>({
    name: t.name,
    description: t.description,
    schema: t.schema,
    responseFormat: t.responseFormat,
    metadata: t.metadata,
    func: async (args: Record<string, unknown>, runManager?: any, config?: any) => {
      let targets: VoiceTarget[] = [];
      if (hook) {
        try { targets = await hook(args ?? {}); } catch { targets = []; }
      }
      const d = decide(voiceClearancePolicy(), clearance, t.name, targets);
      if (d.ok === false) {
        logger.warn(`Voice clearance: ${t.name} refused (${d.reason}, ${d.protectedBy}) — speaker ${clearance.speaker ? `${clearance.speaker.name} ${clearance.speaker.score}` : 'not recognised'}, satellite ${clearance.satellite ?? '-'}`);
        const refusal = JSON.stringify({ error: 'voice_not_authorized', reason: d.reason, message: voiceNotAuthorized(d.reason) });
        // A tool that answers content and an artifact (files) answers the refusal with no artifact.
        return t.responseFormat === 'content_and_artifact' ? [refusal, undefined] : refusal;
      }
      return typeof t.func === 'function' ? t.func(args, runManager, config) : t.invoke(args, config);
    },
  });
  (guarded as any)[GUARDED] = true;
  return guarded;
}

/** guardTool over a list (the same list when nothing needs guarding). */
export function guardTools<T extends { name: string }>(tools: T[]): Array<T | DynamicStructuredTool<any>> {
  if (!currentVoiceClearance() || !policy.enabled) return tools;
  return tools.map((t) => guardTool(t));
}
