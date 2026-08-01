// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file openai-compat.controller.ts
 *
 * OpenAI-compatible chat endpoint over the standard agent pipeline. Built for
 * external conversation clients (voice satellites, third-party frontends) that
 * speak the chat-completions wire format and keep the conversation window on
 * their side.
 *
 * Contract:
 *  - STATELESS: no chat rows are created and no compaction runs (chatId is
 *    never passed) — the caller resends the window in `messages[]` each turn.
 *  - Incoming system messages are discarded (the pipeline has its own layered
 *    prompt); tool events stay internal and never map to OpenAI tool_calls.
 *  - `model` selects the pipeline: 'arkimede' (default) runs the user's
 *    standard pipeline; an agent slug runs it with that agent's instructions,
 *    tool filter and iteration cap (see GET /models).
 *  - Auth: standard Bearer JWT — disabling the user cuts the caller off at the
 *    next request.
 */
import {
  Body, Controller, Get, HttpCode, HttpStatus, Post, Res, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AgentService, StreamResponseOptions } from '../agent/agent.service';
import { AgentsService } from '../agents/agents.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  agentSlug, chunkFrame, completionBody, errorBody, mapOpenAiMessages,
  OpenAiChatRequest, toOpenAiUsage, usageFrame,
} from './openai-mapper';

/** Default model id exposed for the user's standard pipeline. */
const DEFAULT_MODEL_ID = 'arkimede';

@ApiTags('openai-compat')
@ApiBearerAuth()
@Controller('api/openai/v1')
@UseGuards(JwtAuthGuard)
export class OpenAiCompatController {
  constructor(
    private readonly agentService: AgentService,
    private readonly agentsService: AgentsService,
  ) {}

  /**
   * GET /api/openai/v1/models — the user's standard pipeline plus their agents
   * as selectable "models" (clients use this to populate their model picker).
   */
  @Get('models')
  @ApiOperation({ summary: 'OpenAI-compatible model list (default pipeline + user agents)' })
  async models(@CurrentUser() user: any) {
    const agents = await this.agentsService.findAll(user.id);
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: [
        { id: DEFAULT_MODEL_ID, object: 'model', created, owned_by: 'arkimede' },
        ...agents.map((a) => ({
          id: agentSlug(a.name),
          object: 'model',
          created: Math.floor(new Date(a.createdAt as any).getTime() / 1000) || created,
          owned_by: 'arkimede-agent',
        })),
      ],
    };
  }

  /**
   * POST /api/openai/v1/chat/completions — stateless turn over the agent
   * pipeline; SSE deltas when `stream: true`, full body otherwise.
   */
  @Post('chat/completions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OpenAI-compatible chat completions (stateless, streaming)' })
  async completions(
    @Body() body: OpenAiChatRequest,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const { userInput, history } = mapOpenAiMessages(body?.messages ?? []);
    if (!userInput.trim()) {
      res.status(400).json(errorBody('The last message must be a non-empty user message.'));
      return;
    }

    let opts: StreamResponseOptions;
    let modelId = (body?.model || DEFAULT_MODEL_ID).trim();
    try {
      opts = await this.resolveModelOptions(modelId, user.id);
    } catch {
      res.status(404).json(errorBody(`Model "${modelId}" not found.`, 'model_not_found'));
      return;
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Client-side disconnect (e.g. the satellite aborted) stops the agent run.
    const abort = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) abort.abort(); });

    const historyMessages = history.map((h) => ({ role: h.role, content: h.content })) as any[];

    if (body?.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      // OpenAI opens the stream with the role delta.
      res.write(chunkFrame(id, created, modelId, { role: 'assistant' }));

      try {
        const usage = await this.agentService.streamResponse(
          userInput, user.id, undefined, undefined, historyMessages,
          [], [], [],
          (chunk) => res.write(chunkFrame(id, created, modelId, { content: chunk })),
          () => undefined,          // tool calls stay internal
          abort.signal,
          undefined,                // tool results stay internal
          opts,
        );
        res.write(chunkFrame(id, created, modelId, {}, 'stop'));
        if (body?.stream_options?.include_usage) {
          res.write(usageFrame(id, created, modelId, toOpenAiUsage(usage)));
        }
        res.write('data: [DONE]\n\n');
      } catch (err: any) {
        // Headers are already out: surface the error as an SSE event and close.
        res.write(`data: ${JSON.stringify(errorBody(err?.message ?? 'Internal error', 'server_error'))}\n\n`);
      } finally {
        finished = true;
        res.end();
      }
      return;
    }

    // Non-streaming: buffer the deltas and return the complete body.
    try {
      let text = '';
      const usage = await this.agentService.streamResponse(
        userInput, user.id, undefined, undefined, historyMessages,
        [], [], [],
        (chunk) => { text += chunk; },
        () => undefined,
        abort.signal,
        undefined,
        opts,
      );
      finished = true;
      res.json(completionBody(id, created, modelId, text, toOpenAiUsage(usage)));
    } catch (err: any) {
      finished = true;
      res.status(500).json(errorBody(err?.message ?? 'Internal error', 'server_error'));
    }
  }

  /**
   * Resolves the requested model id: the default id runs the plain pipeline,
   * an agent slug applies that agent's instructions/tool filter/iteration cap.
   * Throws when the slug matches none of the user's agents.
   */
  private async resolveModelOptions(modelId: string, userId: string): Promise<StreamResponseOptions> {
    const base: StreamResponseOptions = { origin: 'voice' };
    if (!modelId || modelId === DEFAULT_MODEL_ID) return base;
    const agents = await this.agentsService.findAll(userId);
    const agent = agents.find((a) => agentSlug(a.name) === modelId);
    if (!agent) throw new Error('model not found');
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
}
