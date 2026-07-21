/**
 * @file binding-resolver.ts
 *
 * Resolution of bindings between nodes: "who converts the data from one node to another".
 *
 * Each node declares its own inputs as `{{ ... }}` expressions on the run state.
 * The resolver evaluates them BEFORE executing the node, so the node receives its
 * arguments ready to use. Two namespaces:
 *   - {{ input.<path> }}             → flow start variables
 *   - {{ nodes.<id>.output.<path> }} → output of an upstream node (or .status)
 *
 * "Light" conversion (pick a field, interpolate a string, coercion). Heavy
 * conversions are done with `transform`/`llm` nodes (Slice 2+).
 *
 * Note: no JS code eval here — only lookup by path. Arbitrary JS expressions
 * are allowed only in the `transform` node (isolated-vm sandbox).
 */
import { FlowRunState } from './flow.types';

/** `{{ expression }}` — captures the inner content, tolerant of whitespace. */
const BINDING_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Reads a value by dot/array path from an object.
 * E.g.: getByPath(state, "nodes.n1.output.righe.0.nome").
 */
export function getByPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: any = root;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Resolves a single binding expression against the state.
 *
 * - If the string is EXACTLY a single `{{ expr }}`, returns the resolved RAW
 *   value (may be object/number/array) → preserves the type.
 * - Otherwise interpolates all occurrences in the string (non-string values
 *   are serialized) → always returns a string.
 * - If `expr` is not a string (e.g. already a number in the JSON), returns it unchanged.
 */
export function resolveBinding(expr: unknown, state: FlowRunState): unknown {
  if (typeof expr !== 'string') return expr;

  const single = expr.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (single) {
    return getByPath(state, single[1]);
  }

  if (!expr.includes('{{')) return expr;

  return expr.replace(BINDING_RE, (_m, path) => {
    const v = getByPath(state, String(path));
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Resolves an input map (arg → expression) into arguments ready for the node. */
export function resolveInputs(
  inputs: Record<string, string> | undefined,
  state: FlowRunState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!inputs) return out;
  for (const [key, expr] of Object.entries(inputs)) {
    out[key] = resolveBinding(expr, state);
  }
  return out;
}
