// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * A sequence program: timed, repeated, parallel or random tool calls that the model writes in one tool call and a
 * deterministic engine runs without a model in the loop (specs/RUN_SEQUENCE.md).
 *
 * Domain-free: a step calls a tool by name with its arguments, whatever the tool does. This file holds the schema, the
 * bounds and the check made before a program starts (tools allowed, sizes, duration, call count, restart key).
 */
import { z } from 'zod';

/** Step kinds (v1). Each step is an object with exactly one of these keys. */
export interface CallStep { call: { tool: string; args?: Record<string, unknown> } }
export interface WaitStep { wait: { seconds: number; jitterSeconds?: number } }
export interface RepeatStep { repeat: { count?: number; forSeconds?: number; steps: SequenceStep[] } }
export interface ParallelStep { parallel: SequenceStep[] }
export interface ChooseStep { choose: { random: SequenceStep[] } }
export type SequenceStep = CallStep | WaitStep | RepeatStep | ParallelStep | ChooseStep;

export interface SequenceProgram {
  title?: string;
  /** What the sequence acts on: a new sequence of the same user with the same key replaces the running one. */
  key?: string;
  steps: SequenceStep[];
  /** Run at the end, also when stopped or failed (restore what the steps changed). */
  finally?: SequenceStep[];
  /** Stop at the first failed call (default: record it and go on). */
  stopOnError?: boolean;
  /** The memory's procedure (or one step of it) the sequence carries out: its outcome is reported there at the end. */
  procedure?: { id: string; step?: number };
}

export interface SequenceLimits {
  maxSeconds: number;
  maxCalls: number;
  maxDepth: number;
  maxParallel: number;
  minWaitSeconds: number;
  maxPerUser: number;
  /** How long `finally` may run once the steps ended. */
  finallySeconds: number;
}

export const DEFAULT_LIMITS: SequenceLimits = {
  maxSeconds: 600, maxCalls: 1000, maxDepth: 4, maxParallel: 8, minWaitSeconds: 0.2, maxPerUser: 3, finallySeconds: 30,
};

/** The limits, from the environment where set (RUN_SEQUENCE_MAX_SECONDS, _MAX_CALLS, _MAX_PER_USER). */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): SequenceLimits {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    ...DEFAULT_LIMITS,
    maxSeconds: num(env.RUN_SEQUENCE_MAX_SECONDS, DEFAULT_LIMITS.maxSeconds),
    maxCalls: num(env.RUN_SEQUENCE_MAX_CALLS, DEFAULT_LIMITS.maxCalls),
    maxPerUser: num(env.RUN_SEQUENCE_MAX_PER_USER, DEFAULT_LIMITS.maxPerUser),
  };
}

/**
 * Tools a sequence never calls: what runs a model or for long (agents, teams, flows, the sandbox), what schedules or
 * starts other work, memory. A sequence is quick, timed actions.
 */
const DENIED_NAMES = new Set([
  'run_sequence', 'stop_sequences', 'schedule_task', 'confirm_scheduled_task', 'run_in_sandbox', 'get_tool_instructions',
]);
const DENIED_PATTERN = /^(agent_|team_|flow_)|memory|schedul/;

export function isDeniedTool(name: string): boolean {
  return DENIED_NAMES.has(name) || DENIED_PATTERN.test(name);
}

/** Argument names by which a tool takes the user's confirmation: a sequence never gives it on the user's behalf. */
const CONFIRM_ARGS = ['confirmed', 'confirm'];

// Typed loosely: the backend compiles without strictNullChecks, where zod infers every property as optional.
const stepSchema: z.ZodTypeAny = z.lazy(() => z.union([
  z.object({ call: z.object({ tool: z.string().min(1), args: z.record(z.unknown()).optional() }).strict() }).strict(),
  z.object({ wait: z.object({ seconds: z.number().nonnegative(), jitterSeconds: z.number().nonnegative().optional() }).strict() }).strict(),
  z.object({
    repeat: z.object({
      count: z.number().int().positive().optional(),
      forSeconds: z.number().positive().optional(),
      steps: z.array(stepSchema).min(1),
    }).strict(),
  }).strict(),
  z.object({ parallel: z.array(stepSchema).min(1) }).strict(),
  z.object({ choose: z.object({ random: z.array(stepSchema).min(1) }).strict() }).strict(),
]));

export const programSchema: z.ZodTypeAny = z.object({
  title: z.string().max(120).optional(),
  key: z.string().min(1).max(120).optional(),
  steps: z.array(stepSchema).min(1),
  finally: z.array(stepSchema).optional(),
  stopOnError: z.boolean().optional(),
  procedure: z.object({
    id: z.string().min(1).max(200),
    step: z.number().int().min(1).optional(),
  }).strict().optional(),
}).strict();

/** What a program needs, computed before it starts. */
export interface ProgramPlan {
  /** Nominal duration in seconds (waits without jitter; calls count as instant). */
  plannedSeconds: number;
  /** Upper bound of the tool calls the steps make (finally included). */
  maxCalls: number;
  /** The tools called. */
  tools: string[];
  /** Restart key: the program's own, else its calls (tool + arguments). */
  key: string;
}

export type CheckResult = { ok: true; program: SequenceProgram; plan: ProgramPlan } | { ok: false; errors: string[] };

/** JSON with sorted keys: the same arguments give the same text. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

interface Measure {
  /** Nominal seconds. */
  nominal: number;
  /** Shortest possible seconds (waits at their lowest). */
  min: number;
  /** Upper bound of calls. */
  calls: number;
}

/**
 * Checks RAW (the model's arguments) against the schema, the tools available in the turn (AVAILABLE) and LIMITS.
 * The errors are written for the model, to fix and call again.
 */
export function checkProgram(raw: unknown, available: Iterable<string>, limits: SequenceLimits = DEFAULT_LIMITS): CheckResult {
  const parsed = programSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'program'}: ${i.message}`) };
  }
  const program = parsed.data as SequenceProgram;
  const tools = new Set(available);
  const errors: string[] = [];
  const called = new Set<string>();
  const callKeys = new Set<string>();

  const measureAll = (steps: SequenceStep[], path: string, depth: number): Measure => {
    let m: Measure = { nominal: 0, min: 0, calls: 0 };
    steps.forEach((s, i) => {
      const r = measure(s, `${path}[${i}]`, depth);
      m = { nominal: m.nominal + r.nominal, min: m.min + r.min, calls: m.calls + r.calls };
    });
    return m;
  };

  const measure = (step: SequenceStep, path: string, depth: number): Measure => {
    if (depth > limits.maxDepth) {
      errors.push(`${path}: nested deeper than ${limits.maxDepth} levels`);
      return { nominal: 0, min: 0, calls: 0 };
    }
    if ('call' in step) {
      const { tool, args } = step.call;
      if (!tools.has(tool)) errors.push(`${path}: tool "${tool}" is not one of your tools`);
      else if (isDeniedTool(tool)) errors.push(`${path}: "${tool}" cannot run in a sequence (only quick actions: no agents, teams, flows, sandbox, scheduling or memory)`);
      for (const k of CONFIRM_ARGS) {
        if (args && args[k]) errors.push(`${path}: a sequence never confirms on the user's behalf ("${k}"); ask the user and call the tool yourself`);
      }
      called.add(tool);
      callKeys.add(stable({ tool, args: args ?? {} }));
      return { nominal: 0, min: 0, calls: 1 };
    }
    if ('wait' in step) {
      const { seconds, jitterSeconds = 0 } = step.wait;
      if (seconds < limits.minWaitSeconds) errors.push(`${path}: a wait is at least ${limits.minWaitSeconds} s`);
      if (jitterSeconds > seconds) errors.push(`${path}: jitterSeconds cannot exceed seconds`);
      return { nominal: seconds, min: Math.max(limits.minWaitSeconds, seconds - jitterSeconds), calls: 0 };
    }
    if ('repeat' in step) {
      const { count, forSeconds, steps } = step.repeat;
      if ((count === undefined) === (forSeconds === undefined)) {
        errors.push(`${path}: a repeat takes either count or forSeconds`);
        return { nominal: 0, min: 0, calls: 0 };
      }
      const body = measureAll(steps, `${path}.repeat.steps`, depth + 1);
      if (count !== undefined) {
        return { nominal: body.nominal * count, min: body.min * count, calls: body.calls * count };
      }
      if (body.min <= 0) {
        errors.push(`${path}: a repeat forSeconds needs a wait in its steps`);
        return { nominal: forSeconds!, min: forSeconds!, calls: 0 };
      }
      const rounds = Math.ceil(forSeconds! / body.min);
      return { nominal: forSeconds!, min: forSeconds!, calls: body.calls * rounds };
    }
    if ('parallel' in step) {
      if (step.parallel.length > limits.maxParallel) errors.push(`${path}: at most ${limits.maxParallel} parallel branches`);
      const branches = step.parallel.map((s, i) => measure(s, `${path}.parallel[${i}]`, depth + 1));
      return {
        nominal: Math.max(...branches.map((b) => b.nominal)),
        min: Math.max(...branches.map((b) => b.min)),
        calls: branches.reduce((n, b) => n + b.calls, 0),
      };
    }
    const options = step.choose.random.map((s, i) => measure(s, `${path}.choose.random[${i}]`, depth + 1));
    return {
      nominal: Math.max(...options.map((o) => o.nominal)),
      min: Math.min(...options.map((o) => o.min)),
      calls: Math.max(...options.map((o) => o.calls)),
    };
  };

  const main = measureAll(program.steps, 'steps', 1);
  const end = program.finally ? measureAll(program.finally, 'finally', 1) : { nominal: 0, min: 0, calls: 0 };
  if (main.nominal > limits.maxSeconds) {
    errors.push(`the sequence lasts ${Math.round(main.nominal)} s, more than ${limits.maxSeconds} s: for longer work use schedule_task`);
  }
  if (end.nominal > limits.finallySeconds) errors.push(`finally lasts more than ${limits.finallySeconds} s`);
  const calls = main.calls + end.calls;
  if (calls > limits.maxCalls) errors.push(`up to ${calls} tool calls, more than ${limits.maxCalls}: space them out or shorten it`);
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 10) };

  return {
    ok: true,
    program,
    plan: {
      plannedSeconds: main.nominal,
      maxCalls: calls,
      tools: [...called].sort(),
      key: program.key ? `key:${program.key}` : `calls:${[...callKeys].sort().join('|')}`,
    },
  };
}
