/**
 * @file agent.types.ts
 *
 * Multi-Agent types (Level 2): the user defines reusable **agents** and
 * composes them into **teams** with a topology. See the "Multi-Agent (Design —
 * Livello 2)" section in PROJECT.md.
 *
 * An agent = system prompt + one LlmConfig + a subset of tools (filter).
 * A team   = N agents + topology (supervisor | sequential | parallel).
 */

/** Visibility/management scope, identical to custom tools / skills / flows. */
export type AgentScope = 'personal' | 'team' | 'org';

/** Collaboration topology of an agent team. */
export type TeamTopology = 'supervisor' | 'sequential' | 'parallel';

/**
 * Filter of the tools an agent may use (subset of the user's tools:
 * custom/mcp/skill/flow). `all` = all; `names` = only those listed;
 * `none` = no tools (a "pure" agent, e.g. a writer).
 */
export interface AgentToolFilter {
  mode: 'all' | 'names' | 'none';
  /** Names of the allowed tools (only for mode='names'). */
  names?: string[];
}

/** Role of a member in the team (free-form label, e.g. "researcher", "writer"). */
export type AgentMemberRole = string;
