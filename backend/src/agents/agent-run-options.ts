// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Maps an Agent record onto the pipeline overrides of AgentService.streamResponse.
 * Shared by every external entry point that runs "an agent as a model" (the
 * OpenAI-compatible shim, the Wyoming conversation program) so the semantics
 * stay identical: instructions, tool filter, LLM config and the iteration cap.
 */
import type { Agent } from './agent.entity';
import type { StreamResponseOptions } from '../agent/agent.service';

export function agentRunOptions(
  agent: Agent | null | undefined,
  origin: StreamResponseOptions['origin'],
): StreamResponseOptions {
  const base: StreamResponseOptions = { origin };
  if (!agent) return base;
  return {
    ...base,
    ...(agent.systemPrompt?.trim() ? { agentPromptOverride: agent.systemPrompt } : {}),
    ...(agent.toolFilter ? { toolOverride: agent.toolFilter } : {}),
    ...(agent.llmConfigId ? { llmConfigId: agent.llmConfigId } : {}),
    // Agent.maxIterations counts ReAct TOOL ROUNDS (user-facing semantics);
    // the LangGraph recursion limit counts graph super-steps — each round is
    // agent + tool (2 steps) plus the final agent step.
    ...(agent.maxIterations ? { maxIterations: agent.maxIterations * 2 + 1 } : {}),
  };
}
