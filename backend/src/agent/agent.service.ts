/**
 * @file agent.service.ts
 *
 * Core of the AI agent: orchestrates the Claude (Anthropic) model with a set of
 * specialized tools via LangGraph's ReAct architecture.
 *
 * ReAct architecture (Reasoning + Acting):
 *   Thought → Tool Call → Observation → Thought → … → Final Answer
 *
 * Registered tools:
 *   - database tools    → Text-to-SQL on the business management system (MySQL)
 *   - rag tool          → Semantic search over indexed documents (Qdrant)
 *   - pdf-gen tool      → PDF generation for reports and documents
 *   - completeness tool → Project completeness analysis and suggestions
 *
 * The service exposes two execution modes:
 *   - streamResponse()  → SSE/streaming for the chat interface (progressive response)
 *   - invoke()          → Synchronous response (used internally or for tests)
 */
import {Inject, Injectable, Logger, OnModuleInit, Optional} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage, trimMessages} from '@langchain/core/messages';
import {createReactAgent} from '@langchain/langgraph/prebuilt';
import {DynamicStructuredTool} from '@langchain/core/tools';
import {z} from 'zod';
import {isoWithOffset, DEFAULT_TIMEZONE} from '../common/datetime.util';
import {Message} from '../messages/messages.entity';
import {Chat} from '../chats/chats.entity';
import {CustomToolsService} from '../custom-tools/custom-tools.service';
import {McpServersService} from '../mcp-servers/mcp-servers.service';
import {SkillsService} from '../skills/skills.service';
import {AppConfigService} from '../app-config/app-config.service';
import {LlmProviderService} from '../app-config/llm-provider.service';
import {User} from '../users/users.entity';
import {Project} from '../projects/projects.entity';
import {ToolManifest, ToolSelectionService} from './tool-selection.service';
import {FeedbackService} from '../feedback/feedback.service';
import {UserMemoryService} from '../user-memory/user-memory.service';
import {FlowsService} from '../flows/flows.service';
import {
  GET_CURRENT_DATETIME_DESC, languageLine, userMemoryBlock, summaryBlock,
  feedbackBlock, memoryBlock, nowBlock, summarizerPrompt,
} from '../prompts/prompts';
import {MultiAgentService} from '../agents/multi-agent.service';
import {SchedulingService} from '../scheduling/scheduling.service';
import {SandboxService} from '../sandbox/sandbox.service';
import {LlmUsage, sumUsageFromMessages} from '../common/llm-usage.util';
import {runWithLlmCallContext} from '../usage/llm-call-context';

@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);

  /**
   * Built-in tools loaded at boot. Immutable — they serve as the base
   * onto which the user's custom tools are appended on every request.
   */
  private builtInTools: any[];

  /**
   * Providers whose model exposes a reliable GPT tokenizer (tiktoken via
   * @langchain): for these `trimMessages` uses the model's token count.
   * For all others it falls back to the portable ~4 char/token estimate.
   */
  private static readonly TIKTOKEN_PROVIDERS = new Set([
    'openai', 'openai-compatible', 'deepseek', 'lmstudio',
  ]);

  /**
   * LangGraph graph step limit (library default: 25). With createReactAgent
   * each round consumes 2 steps (agent node + tools node), so 50 ≈ 25 LLM calls:
   * enough for long DB/tool explorations without infinite loops.
   * Override via env `AGENT_RECURSION_LIMIT` (minimum 10 so as not to break every run).
   */
  private static readonly AGENT_RECURSION_LIMIT =
    Math.max(10, parseInt(process.env.AGENT_RECURSION_LIMIT ?? '', 10) || 50);

  /**
   * Cap (in characters) on the output of each tool-call re-injected into the history
   * (replay in buildMessages). The full value is only needed in the original turn;
   * in the replay the gist is enough — without a cap a single turn with huge SQL/schema
   * output overflows the history budget and the trim throws away the entire history.
   * Override via env `REPLAY_TOOL_OUTPUT_MAX_CHARS` (minimum 500).
   */
  private static readonly REPLAY_TOOL_OUTPUT_MAX_CHARS =
    Math.max(500, parseInt(process.env.REPLAY_TOOL_OUTPUT_MAX_CHARS ?? '', 10) || 3000);

  constructor(
    @Inject(CustomToolsService)         private readonly customToolsService: CustomToolsService,
    @Inject(McpServersService)          private readonly mcpServersService:  McpServersService,
    @Inject(AppConfigService)           private readonly appConfigService:   AppConfigService,
    @Inject(LlmProviderService)         private readonly llmProviderService: LlmProviderService,
    @Inject(SkillsService)              private readonly skillsService:      SkillsService,
    @Inject(ToolSelectionService)       private readonly toolSelection:      ToolSelectionService,
    @InjectRepository(User)             private readonly userRepo:           Repository<User>,
    @InjectRepository(Project)          private readonly projectRepo:        Repository<Project>,
    @InjectRepository(Chat)             private readonly chatRepo:           Repository<Chat>,
    @Optional() @Inject(FeedbackService) private readonly feedbackService:   FeedbackService | null,
    @Optional() @Inject(UserMemoryService) private readonly userMemoryService: UserMemoryService | null,
    @Inject(FlowsService)               private readonly flowsService:       FlowsService,
    @Inject(MultiAgentService)          private readonly multiAgentService:  MultiAgentService,
    @Inject(SchedulingService)          private readonly schedulingService:  SchedulingService,
    @Inject(SandboxService)             private readonly sandboxService:     SandboxService,
  ) {}

  /**
   * Initializes the model and the built-in tools at module boot.
   *
   * Run by NestJS after all module providers have been injected. It no longer
   * creates a static agent: the base prompt is loaded from AppConfigService on
   * every request (with in-memory cache — no overhead). This lets the admin
   * edit the prompt from the UI without a redeploy.
   */
  onModuleInit() {
    // The RAG tool is no longer built-in: it is handled as a custom tool of type 'rag',
    // so every user/admin can create RAG tools over different collections.
    this.builtInTools = [
      // "Fresh" date/time on-demand: useful for relative times during a long
      // reasoning process and for the headless automations runner. The
      // reference is injected into the system prompt anyway (see resolveAgent);
      // this tool is needed when the up-to-date time is required mid-execution.
      new DynamicStructuredTool({
        name: 'get_current_datetime',
        description: GET_CURRENT_DATETIME_DESC,
        schema: z.object({
          timezone: z.string().optional().describe(`IANA timezone, e.g. "Europe/Rome". Default: ${DEFAULT_TIMEZONE}.`),
        }),
        func: async ({ timezone }: { timezone?: string }) => {
          const tz = timezone || DEFAULT_TIMEZONE;
          return `${isoWithOffset(new Date(), tz)} (${tz})`;
        },
      }),
    ];

    this.logger.log(`Agent initialized with ${this.builtInTools.length} built-in tools (LLM: dynamic via LlmProviderService)`);
  }

  /**
   * Runs the agent in streaming mode and sends the text chunks to the caller.
   *
   * Uses LangGraph `streamMode: 'messages'` which emits each message (or fragment)
   * as soon as it is available, enabling progressive UI updates.
   *
   * The method distinguishes three content types in the stream:
   * 1. Plain string → onChunk directly
   * 2. Array of content blocks:
   *    - block.type === 'text'     → onChunk with the text
   *    - block.type === 'tool_use' → onToolCall (e.g. to show "Searching…" in the UI)
   * 3. ToolMessage (raw tool result) → ignored (not shown to the user)
   *
   * @param userInput        - The user's message
   * @param userId           - User ID to load custom tools (optional)
   * @param projectId
   * @param history          - Conversation history
   * @param attachments      - The user's attachments
   * @param inlineContents   - Files passed inline in the text
   * @param attachmentBlocks - Binary files for multimodality
   * @param onChunk          - Callback invoked for each fragment of AI text
   * @param onToolCall       - Callback invoked when the AI calls a tool
   * @param signal
   */
  async streamResponse(
    userInput: string,
    userId: string | undefined,
    projectId: string | undefined,
    chatId: string | undefined,
    history: Message[],
    attachments: any[],
    inlineContents: { name: string; content: string }[],
    attachmentBlocks: { name: string; mimeType: string; base64: string }[],
    onChunk: (chunk: string) => void,
    onToolCall: (tool: any) => void,
    signal?: AbortSignal,
    onToolResult?: (toolName: string, result: any, status?: 'success' | 'error', input?: any) => void,
  ): Promise<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; provider: string; model: string | null } | null> {
    this.logger.log(`Chat: "${userInput}"`);
    const isReasoning = await this.llmProviderService.isReasoningModel();
    const { agent, contextBreakdown, effectiveMaxHistoryTokens, model, effectiveHistory, provider, modelName } = await this.resolveAgent(userId, projectId, userInput, history, chatId);
    const messages = await this.buildMessages(userInput, effectiveHistory, attachments, inlineContents, attachmentBlocks, isReasoning, effectiveMaxHistoryTokens, model, provider);

    // ── Context breakdown log ─────────────────────────────────────────────────
    this.logger.debug(
      `Context: system=${contextBreakdown.systemTok}tok ` +
      `skills=${contextBreakdown.skillsTok}tok ` +
      `tools=${contextBreakdown.toolsTok}tok(×${contextBreakdown.toolsCount}) ` +
      `history=${contextBreakdown.historyTok}tok(×${history.length}msg) ` +
      `query=${contextBreakdown.queryTok}tok ` +
      `≈${contextBreakdown.systemTok + contextBreakdown.skillsTok + contextBreakdown.toolsTok + contextBreakdown.historyTok + contextBreakdown.queryTok}tok total`,
    );

    let totalInputTokens  = 0;
    let totalOutputTokens = 0;
    let totalCacheRead    = 0;
    let totalCacheWrite   = 0;

    // ── Per-step tracking ─────────────────────────────────────────────────────
    // Whenever usage_metadata has values > 0 it marks the end of an LLM call.
    // _metadata.langgraph_step and langgraph_node identify the graph step.
    type StepLog = { stepIdx: number; node: string; inTok: number; outTok: number; tool?: string; cacheRead: number; cacheWrite: number };
    const stepLogs: StepLog[] = [];
    let lastToolCalled: string | undefined;
    let stepCount = 0;

    // ── Tool args accumulator ─────────────────────────────────────────────────
    // At chunk level (streamMode 'messages') the COMPLETE tool input never appears
    // in one place: Anthropic emits tool_use blocks with input={} (args follow as
    // input_json_delta), OpenAI-compatible providers split args across chunks.
    // The deltas are standardized by LangChain in message.tool_call_chunks: we
    // accumulate them per chunk index and resolve them by tool_call_id when the
    // ToolMessage arrives, so onToolResult can expose the real input.
    const toolArgsAcc = new Map<number | string, { id?: string; args: string }>();
    const takeToolArgs = (callId: string | undefined): any => {
      if (!callId) return undefined;
      for (const [key, acc] of toolArgsAcc) {
        if (acc.id === callId) {
          toolArgsAcc.delete(key); // consumed: frees the index for the next step
          try { return JSON.parse(acc.args || '{}'); } catch { return undefined; }
        }
      }
      return undefined;
    };

    try {
      // Scheduling class + attribution (P1-F2): the whole graph consumption runs
      // inside the call context — the dispatcher and the metrics handler read it
      // when each model call actually fires during the iteration below.
      await runWithLlmCallContext({ priority: 'interactive', userId, origin: 'chat' }, async () => {
      const stream = await agent.stream(
        { messages },
        {
          streamMode: 'messages', signal, recursionLimit: AgentService.AGENT_RECURSION_LIMIT,
          // LangGraph does NOT fire the model's instance callbacks (verified on
          // langgraph 1.4/core 1.1): the serving-metrics handler attached by
          // buildModelForConfig must be re-passed via config. Direct invokes
          // (flows, custom tools, …) fire it from the instance instead — the
          // two paths are mutually exclusive, so each call is recorded once.
          callbacks: Array.isArray((model as any).callbacks) ? (model as any).callbacks : undefined,
        },
      );

      for await (const [message, _metadata] of stream) {
        // If the client has closed the connection, break out of the loop
        if (signal?.aborted) break;

        // Accumulate streamed tool-call argument deltas (see toolArgsAcc above).
        const tcChunks = (message as any).tool_call_chunks as
          Array<{ name?: string; args?: string; id?: string; index?: number }> | undefined;
        if (tcChunks?.length) {
          for (const c of tcChunks) {
            const key = c.index ?? c.id ?? 0;
            const acc = toolArgsAcc.get(key) ?? { args: '' };
            if (c.id) acc.id = c.id;
            if (c.args) acc.args += c.args;
            toolArgsAcc.set(key, acc);
          }
        }

        // ToolMessages contain the raw results returned by the tools:
        // they have already been processed by the agent and must not be exposed to the user.
        // If the onToolResult callback is present, we invoke it before skipping
        // (used e.g. by the SSE controller to emit 'file' events to the daemon clients).
        if (message._getType() === 'tool') {
          if (onToolResult) {
            const toolName = (message as any).name ?? '';
            // status: 'error' when the tool threw an exception (handled by LangGraph),
            // otherwise 'success'. Lets the caller mark the tool call ✓/✗.
            const status = (message as any).status === 'error' ? 'error' : 'success';
            let result: any = null;
            try {
              const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
              result = JSON.parse(raw);
            } catch { result = message.content; }
            const input = takeToolArgs((message as any).tool_call_id);
            onToolResult(toolName, result, status, input);
          }
          continue;
        }

        // ── 1. Process the content blocks BEFORE reading usage ────────────────
        // With Anthropic, tool_use arrives as a block in the content array.
        // With DeepSeek/OpenAI-compatible providers, tool calls arrive in message.tool_calls
        // (not in the content blocks). We handle both formats.
        if (typeof message.content === 'string') {
          if (message.content) onChunk(message.content);
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              onChunk(block.text);
            } else if (block.type === 'tool_use') {
              // Anthropic format: tool call as a content block
              lastToolCalled = block.name;
              onToolCall({ name: block.name, input: block.input });
            }
          }
        }

        // OpenAI-compatible format (DeepSeek, OpenAI, etc.): tool calls in message.tool_calls.
        // Populated when the tool call is complete (same chunk as usage_metadata).
        // We only check if it was not already captured from the content blocks (avoids duplicates with Anthropic).
        if (!lastToolCalled) {
          const tcs = (message as any).tool_calls as Array<{ name: string; args?: any }> | undefined;
          if (tcs?.length) {
            for (const tc of tcs) {
              if (tc.name) {
                lastToolCalled = tc.name;
                onToolCall({ name: tc.name, input: tc.args ?? {} });
              }
            }
          }
        }

        // ── 2. Accumulate tokens and log the step ─────────────────────────────
        // usage_metadata appears on the last chunk of every LLM response → 1 step.
        const usage = (message as any).usage_metadata;
        if (usage && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
          const inTok       = usage.input_tokens  ?? 0;
          const outTok      = usage.output_tokens ?? 0;
          // Cache hit: Anthropic → input_token_details.cache_read
          //            OpenAI   → input_token_details.cache_read (from prompt_tokens_details.cached_tokens)
          //            Gemini   → input_token_details.cache_read (from cachedContentTokenCount)
          //            DeepSeek → logged separately in the fetch interceptor
          const cacheRead   = usage.input_token_details?.cache_read     ?? 0;
          const cacheWrite  = usage.input_token_details?.cache_creation ?? 0;
          totalInputTokens  += inTok;
          totalOutputTokens += outTok;
          totalCacheRead    += cacheRead;
          totalCacheWrite   += cacheWrite;

          const node = (_metadata as any)?.langgraph_node ?? 'agent';
          stepLogs.push({ stepIdx: ++stepCount, node, inTok, outTok, tool: lastToolCalled, cacheRead, cacheWrite });
          lastToolCalled = undefined;  // reset: the next step starts clean
        }
      }
      }); // end runWithLlmCallContext
    } catch (err: any) {
      // AbortError = intentional interruption by the client → not an error
      if (err?.name === 'AbortError' || signal?.aborted) {
        this.logger.log(`Stream interrupted by the user (${userId})`);
        return null;
      }
      throw err;
    }

    // ── Per-step log ──────────────────────────────────────────────────────────
    if (stepLogs.length > 0) {
      const lines = stepLogs.map((s) => {
        let line = `    [call ${s.stepIdx}/${s.node}] in=${s.inTok} out=${s.outTok}`;
        if (s.cacheRead > 0 || s.cacheWrite > 0) {
          line += ` cache(r=${s.cacheRead} w=${s.cacheWrite})`;
        }
        line += s.tool ? ` → tool:${s.tool}` : ' → final response';
        return line;
      });
      this.logger.debug(`Tokens per LLM call:\n${lines.join('\n')}`);

      const cacheSuffix =
        totalCacheRead > 0 || totalCacheWrite > 0
          ? ` | cache: read=${totalCacheRead} write=${totalCacheWrite}`
          : '';
      this.logger.log(
        `Tokens used: input=${totalInputTokens} output=${totalOutputTokens}` +
        cacheSuffix +
        ` (${stepLogs.length} LLM call${stepLogs.length > 1 ? 's' : ''})`,
      );
    }

    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      return {
        inputTokens:      totalInputTokens,
        outputTokens:     totalOutputTokens,
        cacheReadTokens:  totalCacheRead,
        cacheWriteTokens: totalCacheWrite,
        provider,
        model: modelName,
      };
    }
    return null;
  }

  /**
   * Runs the agent in synchronous (non-streaming) mode and returns the complete response.
   *
   * Useful for:
   * - Batch processing or background jobs
   * - Integration tests
   * - Internal invocations from other services (e.g. completeness tool)
   *
   * @param userInput - Message to process
   * @param history   - Conversation history (default: empty)
   * @returns The agent's final text response
   */
  async invoke(userInput: string, history: Message[] = [], userId?: string, projectId?: string): Promise<string> {
    return (await this.invokeWithUsage(userInput, history, userId, projectId)).text;
  }

  /**
   * Like invoke() but also returns the tokens consumed and provider/model — used
   * by **headless** runs (automations) to account for costs.
   */
  async invokeWithUsage(
    userInput: string, history: Message[] = [], userId?: string, projectId?: string,
    toolFilter?: { mode: 'all' | 'names' | 'none'; names?: string[] },
  ): Promise<{ text: string; usage: LlmUsage; provider: string | null; model: string | null }> {
    const isReasoning = await this.llmProviderService.isReasoningModel();
    // invoke() is a one-off path with no persisted chat → resolveAgent does not
    // receive chatId, so no compaction: effectiveHistory === history.
    const { agent, effectiveMaxHistoryTokens, model, effectiveHistory, provider, modelName } = await this.resolveAgent(userId, projectId, userInput, history, undefined, toolFilter);
    const messages = await this.buildMessages(userInput, effectiveHistory, [], [], [], isReasoning, effectiveMaxHistoryTokens, model, provider);
    // Headless runs (automations) never compete with interactive traffic (P1-F2).
    const result   = await runWithLlmCallContext({ priority: 'background', userId, origin: 'automation' }, () =>
      agent.invoke({ messages }, {
        recursionLimit: AgentService.AGENT_RECURSION_LIMIT,
        // Same LangGraph quirk as streamResponse: instance callbacks don't fire
        // inside the graph → re-pass the serving-metrics handler via config.
        callbacks: Array.isArray((model as any).callbacks) ? (model as any).callbacks : undefined,
      }));
    const lastMsg  = result.messages[result.messages.length - 1];
    const text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
    return { text, usage: sumUsageFromMessages(result.messages), provider: provider ?? null, model: modelName ?? null };
  }

  /**
   * Builds the list of messages to pass to the agent, combining:
   * - The recent conversation history (last 20 messages)
   * - The text of the current message, with an optional mention of the RAG attachments
   * - Contents of files passed inline (e.g. text extracted from small PDFs)
   * - Binary attachments as multimodal content blocks (images, native PDFs)
   *
   * LangChain uses the OpenAI multimodal format for content blocks:
   *   - Images: { type: 'image_url', image_url: { url: 'data:...' } }
   *   - PDF: { type: 'document', source: { type: 'base64', ... } }
   *
   * @param userInput        - Text of the user's message
   * @param history          - Previous messages in the conversation
   * @param attachments      - Uploaded attachments (with a mode field: 'embed' | 'inline' | 'direct')
   * @param inlineContents   - Texts extracted from files in inline mode
   * @param attachmentBlocks - Binary files (images/PDF) to send as content blocks
   * @returns Array of messages in the LangChain format
   */
  private async buildMessages(
    userInput: string,
    history: Message[],
    attachments: any[],
    inlineContents: { name: string; content: string }[] = [],
    attachmentBlocks: { name: string; mimeType: string; base64: string }[] = [],
    /**
     * If true, the model uses a reasoning/thinking mode (e.g. DeepSeek-R1, OpenAI o1)
     * and requires the AI messages in the history to have the `reasoning_content` field.
     * Since we do not keep it in the DB, we inject it as an empty string to satisfy
     * the API constraint and avoid the 400 "reasoning_content must be passed back".
     */
    isReasoningModel = false,
    /**
     * Token budget for the conversation history. 0 or negative = no limit.
     * Trimming is delegated to `trimMessages` (@langchain/core): "last" window,
     * token count with the model's tokenizer (GPT providers) or ~4 char/token estimate
     * (other providers); it does not break human/AI pairs.
     */
    maxHistoryTokens = 30000,
    /** Model used as tokenCounter by `trimMessages` (local count via tiktoken). */
    model?: any,
    /** LLM provider: decides whether to use the model's tokenizer or the ~4 char/token estimate. */
    provider?: string,
  ): Promise<BaseMessage[]> {
    // Convert the ENTIRE history into LangChain messages; the trim happens afterwards.
    // For user messages with attachments, we rebuild the metadata annotations
    // so the LLM keeps visibility over the fileIds — essential for tool calls
    // on subsequent turns.
    const historyMessages: BaseMessage[] = [];
    for (const msg of history) {
      if (msg.role === 'user') {
        let content = msg.content;
        if (msg.attachments?.length) {
          const embed  = msg.attachments.filter((a) => a.mode === 'embed' || !a.mode);
          const inline = msg.attachments.filter((a) => a.mode === 'inline');
          const native = msg.attachments.filter((a) => a.mode === 'attachment');
          if (embed.length)
            content += `\n\n[Attachments indexed in RAG: ${embed.map((a) => `${a.name} (id: ${a.fileId})`).join(', ')}]`;
          if (inline.length)
            content += `\n\n[Inline attached files: ${inline.map((a) => `${a.name} (id: ${a.fileId})`).join(', ')}]`;
          if (native.length)
            content += `\n\n[Native attachments: ${native.map((a) => `${a.name} (id: ${a.fileId})`).join(', ')}]`;
        }
        historyMessages.push(new HumanMessage(content));
      } else if (msg.role === 'assistant') {
        // Reasoning models (DeepSeek-R1, OpenAI o1) require every AIMessage in the
        // history to include `reasoning_content`. We do not keep it in the DB, so
        // we inject it as an empty string: the API is satisfied and the history is valid.
        const aiKwargs = isReasoningModel ? { reasoning_content: '' } : undefined;
        const mkAI = (content: string, tool_calls?: any[]) =>
          new AIMessage({ content, ...(tool_calls ? { tool_calls } : {}), ...(aiKwargs ? { additional_kwargs: aiKwargs } : {}) });

        // ── Replay of the tool-calls in the history ────────────────────────────
        // The tool-calls made to generate this turn are persisted on
        // Message.toolCalls. Without re-presenting them, on the next turn the model
        // does not "remember" having used them (e.g. the id returned by schedule_task)
        // → it repeats them (duplicates) or denies having made them. We reconstruct
        // them in the form valid for ALL providers:
        //   AIMessage(tool_calls=[…]) → ToolMessage(result) × N → AIMessage(final text)
        // INVARIANT: every tool_call must have its ToolMessage (even if the output
        // is missing), otherwise Anthropic rejects the orphan `tool_use` (400).
        if (msg.toolCalls?.length) {
          const calls = msg.toolCalls.map((tc, i) => ({
            type: 'tool_call' as const,
            id:   `call_${msg.id}_${i}`,
            name: tc.name || 'tool',
            args: tc.input && typeof tc.input === 'object' ? tc.input : {},
          }));
          historyMessages.push(mkAI('', calls));
          for (let i = 0; i < calls.length; i++) {
            const out = msg.toolCalls[i].output;
            const full = out === undefined || out === null
              ? '(no result)'
              : (typeof out === 'string' ? out : JSON.stringify(out));
            const cap = AgentService.REPLAY_TOOL_OUTPUT_MAX_CHARS;
            const content = full.length > cap
              ? `${full.slice(0, cap)}\n…[output truncated in replay: ${full.length} total characters]`
              : full;
            historyMessages.push(new ToolMessage({ content, tool_call_id: calls[i].id, name: calls[i].name }));
          }
          // The final response to the user, produced after the tool results.
          if (msg.content?.trim()) historyMessages.push(mkAI(msg.content));
        } else {
          historyMessages.push(mkAI(msg.content));
        }
      }
    }

    // ── Trim the history to the budget (safety net) ──────────────────────────
    // Compaction has already reduced the history within the budget; this trim is the
    // final safety net. The summary is NOT here: it lives in the system prompt
    // (the only cross-provider location), so it does not affect this budget.
    const estTok = (s: string) => Math.ceil((s ?? '').length / 4);
    const charEstimator = (msgs: BaseMessage[]) =>
      msgs.reduce((a, m) => a + estTok(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);

    // The token count via the model (tiktoken in @langchain) is reliable only
    // for providers with a GPT tokenizer. For all others (anthropic, gemini,
    // ollama, …) we use the portable ~4 char/token estimate: cross-provider and
    // without depending on the model's correct tokenizer.
    const tokenCounter = (model && provider && AgentService.TIKTOKEN_PROVIDERS.has(provider))
      ? model
      : charEstimator;

    const trimmedHistory = maxHistoryTokens > 0
      ? await trimMessages(historyMessages, {
          maxTokens:   maxHistoryTokens,
          tokenCounter,
          strategy:    'last',
          startOn:     'human',   // do not start with an orphan AIMessage
          allowPartial: false,
        })
      : historyMessages;

    if (trimmedHistory.length < historyMessages.length) {
      this.logger.debug(
        `History trimmed: ${historyMessages.length} → ${trimmedHistory.length} msg (budget=${maxHistoryTokens}tok)`,
      );
    }

    // ── Final composition: [...history, current message] ──────────────────────
    const messages: BaseMessage[] = [];
    messages.push(...trimmedHistory);

    // Build the base text of the current message
    let textContent = userInput;

    // Attachments in 'embed' mode have been indexed in the RAG: we inform the model
    // of their presence (with fileId) so it can use the rag_tool to query them
    // and confirm to the user the ID with which to retrieve the document later.
    const embedAttachments = attachments?.filter((a) => a.mode === 'embed' || !a.mode);
    if (embedAttachments?.length) {
      const list = embedAttachments.map((a) => `${a.name} (id: ${a.fileId})`).join(', ');
      textContent += `\n\n[Attachments indexed in RAG: ${list}]`;
    }

    // Inline files are passed directly in the text (suitable for small files).
    // The fileId is included in the header so the LLM can confirm it to the user.
    for (const att of (attachments ?? []).filter((a) => a.mode === 'inline')) {
      const match = inlineContents.find((f) => f.name === att.name);
      if (!match) continue;
      textContent +=
        `\n\n--- File content: ${att.name} (id: ${att.fileId}) ---\n${match.content}\n--- End of file ---`;
    }

    // Attachments in 'attachment' mode: we always mention them in the text with
    // name, fileId and — if available — the absolute path on disk.
    // The file_path lets skills (e.g. dxf-analyzer) open the file
    // directly without a separate path-resolution tool.
    const directAttachments = (attachments ?? []).filter((a) => a.mode === 'attachment');
    if (directAttachments.length) {
      const list = directAttachments.map((a) => {
        let entry = `${a.name} (id: ${a.fileId}`;
        if (a.storagePath) entry += `, file_path: ${a.storagePath}`;
        return entry + ')';
      }).join(', ');
      textContent += `\n\n[Attachments: ${list}]`;
    }

    if (attachmentBlocks.length === 0) {
      // Simple text message (most common case, including non-native binary files like DXF)
      messages.push(new HumanMessage(textContent));
    } else {
      // Multimodal message: text + binary content blocks (native Claude images/PDFs).

      const contentBlocks: any[] = [{ type: 'text', text: textContent }];

      for (const block of attachmentBlocks) {
        if (block.mimeType.startsWith('image/')) {
          // Images: base64 data URI in the LangChain/OpenAI image_url format
          contentBlocks.push({
            type: 'image_url',
            image_url: { url: `data:${block.mimeType};base64,${block.base64}` },
          });
        } else if (block.mimeType === 'application/pdf') {
          // Native PDFs: Claude supports reading PDFs directly as documents
          contentBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: block.base64 },
          });
        }
      }
      messages.push(new HumanMessage({ content: contentBlocks }));
    }

    return messages;
  }

  /**
   * Combines the four prompt levels into a single system message.
   * Each non-empty layer is separated by a blank line.
   *
   * Priority order (the most specific goes last):
   *   1. basePrompt     — global identity and rules (from the DB, editable by the admin)
   *   2. userPrompt     — the user's preferences / communication style
   *   3. projectPrompt  — project-specific context (client, budget, etc.)
   *   4. skillsPrompt   — available skill metadata (Level 1) + SKILL.md instructions (Level 2)
   */
  private buildSystemPrompt(
    basePrompt:     string,
    userPrompt?:    string | null,
    projectPrompt?: string | null,
    skillsPrompt?:  string | null,
    userMemory?:    string[] | null,
    language?:      string | null,
  ): string {
    const parts: string[] = [basePrompt];
    // The user's response language (cross-provider: stays in the single system prompt).
    const langName = language === 'en' ? 'English' : language === 'it' ? 'Italian' : null;
    if (langName) parts.push(languageLine(langName));
    if (userPrompt?.trim())    parts.push(userPrompt.trim());
    // Persistent user memory: confirmed, stable facts → they stay in the cached
    // prefix (they change only when the user confirms/deletes a fact).
    if (userMemory?.length) {
      parts.push(userMemoryBlock(userMemory));
    }
    if (projectPrompt?.trim()) parts.push(projectPrompt.trim());
    if (skillsPrompt?.trim())  parts.push(skillsPrompt.trim());
    return parts.join('\n\n');
  }

  /**
   * History compaction: when the history exceeds the budget, it summarizes the
   * older turns (rolling summary persisted on the Chat) instead of discarding them.
   *
   * - If the global toggle is off or the chatId is missing → no-op: the full history
   *   is returned and it will be `buildMessages`/`trimMessages` that truncate it (trimming only).
   * - Otherwise it works on the "fresh" messages (those after `summaryUpToMessageId`):
   *   if `summary + fresh` fits the budget it does nothing; if it overflows, it keeps the
   *   last ~40% of the budget verbatim and summarizes the rest, updating the incremental
   *   summary on the Chat.
   *
   * @returns current summary + "effective" history to pass to buildMessages.
   */
  private async compactHistory(
    chatId: string | undefined,
    history: Message[],
    maxHistoryTokens: number,
    enabled: boolean,
    thresholdPct: number,
  ): Promise<{ summary: string | null; effectiveHistory: Message[] }> {
    if (!enabled || !chatId || maxHistoryTokens <= 0) {
      return { summary: null, effectiveHistory: history };
    }

    const chat = await this.chatRepo.findOne({ where: { id: chatId } });
    if (!chat) return { summary: null, effectiveHistory: history };

    const est = (s: string) => Math.ceil((s ?? '').length / 4);
    // Real weight of the message in the history: content + toolCalls payload, which in
    // buildMessages is re-expanded into AIMessage(tool_calls)+ToolMessage and can
    // weigh orders of magnitude more than the text (e.g. SQL/schema output).
    const msgTok = (m: Message) =>
      est(m.content) + (m.toolCalls?.length ? est(JSON.stringify(m.toolCalls)) : 0);

    // "Fresh" messages = those not yet incorporated into the summary.
    let fresh = history;
    if (chat.summaryUpToMessageId) {
      const idx = history.findIndex((m) => m.id === chat.summaryUpToMessageId);
      if (idx >= 0) fresh = history.slice(idx + 1);
    }

    const summaryTok = chat.summary ? est(chat.summary) : 0;
    const freshTok   = fresh.reduce((a, m) => a + msgTok(m), 0);

    // Configurable trigger threshold (% of the budget). Below threshold → no-op.
    const pct        = Math.min(95, Math.max(50, thresholdPct || 80)) / 100;
    const triggerTok = Math.floor(maxHistoryTokens * pct);
    if (summaryTok + freshTok <= triggerTok) {
      return { summary: chat.summary, effectiveHistory: fresh };
    }

    // Above threshold: keep half the threshold verbatim (so after compaction we
    // stay comfortably below the trigger and avoid thrashing), summarize the rest.
    const keepBudget = Math.floor(triggerTok * 0.5);
    let keepTok = 0;
    let keepFrom = fresh.length;
    for (let i = fresh.length - 1; i >= 0; i--) {
      const t = msgTok(fresh[i]);
      if (keepTok + t > keepBudget && keepFrom < fresh.length) break;
      keepTok += t;
      keepFrom = i;
    }

    const toSummarize = fresh.slice(0, keepFrom);
    const toKeep      = fresh.slice(keepFrom);

    // Nothing to summarize (e.g. a single huge turn) → let the trim decide.
    if (toSummarize.length === 0) {
      return { summary: chat.summary, effectiveHistory: fresh };
    }

    let newSummary: string;
    try {
      newSummary = await this.summarize(chat.summary, toSummarize);
    } catch (err: any) {
      // If summarization fails we do not block the chat: fall back to trimming only.
      this.logger.warn(`History compaction failed (chat ${chatId}): ${err?.message ?? err}`);
      return { summary: chat.summary, effectiveHistory: fresh };
    }

    chat.summary              = newSummary;
    chat.summaryUpToMessageId = toSummarize[toSummarize.length - 1].id;
    chat.summaryTokens        = est(newSummary);
    await this.chatRepo.save(chat);

    this.logger.log(
      `History compaction (chat ${chatId}): summarized ${toSummarize.length} msg ` +
      `→ summary ~${chat.summaryTokens}tok, ${toKeep.length} recent msg kept verbatim`,
    );

    return { summary: newSummary, effectiveHistory: toKeep };
  }

  /**
   * Generates the incremental summary: combines the existing summary (if present)
   * with the new turns to compress, using the designated summarizer model
   * (config `isSummarizer`, falling back to the default).
   */
  private async summarize(previousSummary: string | null, turns: Message[]): Promise<string> {
    const model = await this.llmProviderService.getSummarizerModel();

    const transcript = turns
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n');

    const prompt = summarizerPrompt(previousSummary, transcript);

    // Compaction never competes with interactive traffic (P1-F2).
    const res = await runWithLlmCallContext({ priority: 'background', origin: 'system' }, () => model.invoke(prompt));
    const text = typeof res.content === 'string'
      ? res.content
      : Array.isArray(res.content)
        ? res.content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('')
        : String(res.content ?? '');
    return text.trim();
  }

  /**
   * Resolves the agent to use for a request.
   *
   * Two-phase flow:
   *
   * ── Phase 1 (parallel) ──────────────────────────────────────────────────────
   *   Loads everything that does not depend on tool selection:
   *   base prompt, LLM model, custom/MCP/skill tools, user/project config.
   *
   * ── Phase 2 (serial) ─────────────────────────────────────────────────────────
   *   1. RAG selection → knows the selected tools
   *   2. buildSkillSystemPromptSelective with the selected tools
   *      → SKILL.md loaded ONLY for skills with at least one selected tool
   *      → savings: from ~9k tok (all SKILL.md) to ~4k tok (gmail only)
   *
   * Note: for the always_inject_all strategy all SKILL.md are included
   * (selectedToolNames = null → no filter).
   *
   * 4-level system prompt:
   *   1. base (admin)  2. user  3. project  4. skills (metadata + selective SKILL.md)
   */
  private async resolveAgent(
    userId?: string,
    projectId?: string,
    userInput?: string,
    history: Message[] = [],
    chatId?: string,
    toolOverride?: { mode: 'all' | 'names' | 'none'; names?: string[] },
  ): Promise<{ agent: any; contextBreakdown: ContextBreakdown; effectiveMaxHistoryTokens: number; model: any; effectiveHistory: Message[]; provider: string; modelName: string | null }> {
    // ── Phase 1: parallel loads ──────────────────────────────────────────────
    const [basePrompt, model, customTools, mcpTools, skillTools, flowTools, agentTools, user, project, globalToolConfig, providerModel, feedbackEnabled] = await Promise.all([
      this.appConfigService.getSystemPrompt(),
      this.llmProviderService.getModel(),
      userId ? this.customToolsService.loadToolsForUser(userId, projectId, { flatOnly: true }) : Promise.resolve([]),
      userId ? this.mcpServersService.loadToolsForUser(userId, { flatOnly: true })    : Promise.resolve([]),
      userId ? this.skillsService.loadToolsForUser(userId, projectId, { flatOnly: true }) : Promise.resolve([]),
      userId ? this.flowsService.loadToolsForUser(userId, projectId, { flatOnly: true }) : Promise.resolve([]),
      userId ? this.multiAgentService.loadToolsForUser(userId, projectId) : Promise.resolve([]),
      userId
        ? this.userRepo.findOne({
            where: { id: userId },
            select: { id: true, role: true, systemPrompt: true, language: true, toolLoadingStrategy: true, toolLoadingMaxTools: true, toolSchemaFormat: true, maxHistoryTokens: true, autoMemoryEnabled: true },
          })
        : Promise.resolve(null),
      projectId
        ? this.projectRepo.findOne({ where: { id: projectId }, select: { id: true, systemPrompt: true } })
        : Promise.resolve(null),
      this.appConfigService.getToolLoadingConfig(),
      this.llmProviderService.getProviderAndModel(),
      this.appConfigService.getFeedbackMemoryEnabled(),
    ]);
    const provider  = providerModel.provider;
    const modelName = providerModel.model;

    // ── Resolve tool loading configuration (user override > global default) ───
    const effectiveConfig = {
      strategy:     user?.toolLoadingStrategy ?? globalToolConfig.toolLoadingStrategy,
      maxTools:     user?.toolLoadingMaxTools ?? globalToolConfig.toolLoadingMaxTools,
      schemaFormat: user?.toolSchemaFormat    ?? globalToolConfig.toolSchemaFormat,
    };
    const effectiveMaxHistoryTokens = user?.maxHistoryTokens ?? globalToolConfig.maxHistoryTokens;

    // ── History compaction (persisted rolling summary) ───────────────────────
    // Done here because the summary must be merged into the system prompt (see below):
    // every provider allows only one system/systemInstruction, so this is the
    // only safe cross-provider location — no extra messages nor non-alternating
    // roles. With compaction off or without a chatId it is a no-op.
    const { summary, effectiveHistory } = await this.compactHistory(
      chatId, history, effectiveMaxHistoryTokens,
      globalToolConfig.historyCompactionEnabled, globalToolConfig.historyCompactionThreshold,
    );

    // ── Convert tools into manifests for ToolSelectionService ─────────────────
    const fullManifests: ToolManifest[] = [
      ...customTools.map(t => ({ name: t.name, description: t.description ?? '', tool: t })),
      ...mcpTools.map(t    => ({ name: t.name, description: t.description ?? '', tool: t })),
      ...skillTools.map(t  => ({ name: t.name, description: t.description ?? '', tool: t })),
      ...flowTools.map(t   => ({ name: t.name, description: t.description ?? '', tool: t })),
      ...agentTools.map(t  => ({ name: t.name, description: t.description ?? '', tool: t })),
    ];

    // Override of the tool set (e.g. headless run of an automation with a fixed
    // subset). `none` → no extra tools; `names` → only the listed ones; `all`/null
    // → standard behavior (semantic/strategy selection).
    const allExtraManifests: ToolManifest[] = !toolOverride || toolOverride.mode === 'all'
      ? fullManifests
      : toolOverride.mode === 'none'
        ? []
        : fullManifests.filter((m) => (toolOverride.names ?? []).includes(m.name));

    // ── Phase 2a: tool selection + schema format ──────────────────────────────
    // Short follow-ups ("retry", "yes, go ahead") carry no semantic signal for
    // the per-message tool selection: without context the top-K would drop the
    // tools elected in the previous turn. Enrich the SELECTION query (only —
    // the model input is untouched) with the last substantial user message.
    const MIN_SELECTION_SIGNAL = 40;
    let selectionQuery = userInput ?? '';
    if (selectionQuery.trim().length < MIN_SELECTION_SIGNAL) {
      const prevUser = [...history].reverse().find(
        (m) => m.role === 'user' && (m.content ?? '').trim().length >= MIN_SELECTION_SIGNAL,
      );
      if (prevUser) selectionQuery = `${prevUser.content}\n${selectionQuery}`;
    }

    // applyStrategy returns:
    //   tools         → effective tools for createReactAgent
    //   selectedNames → RAG-selected names for the SKILL.md filter (null = all)
    //   toolListText  → <available_tools>…</available_tools> (non-null only if deferred)
    const { tools: optimizedExtraTools, selectedNames: selectedToolNames, toolListText, excludedListText } =
      await this.toolSelection.applyStrategy(
        allExtraManifests,
        selectionQuery,
        effectiveConfig,
      );

    // ── Phase 2b: skills system prompt / tool list ────────────────────────────
    let skillsPrompt: string;
    let deferredMetaTool: DynamicStructuredTool | null = null;

    if (effectiveConfig.schemaFormat === 'deferred') {
      // In deferred mode the SKILL.md is NOT pre-loaded into the system prompt.
      // In its place the list of available tools is injected (toolListText).
      // The get_tool_instructions meta-tool serves the SKILL.md on-demand when the
      // LLM decides to use a specific tool.
      skillsPrompt = toolListText ?? '';
      if (userId) {
        const skillMdMap = await this.skillsService.getSkillMdMap(
          userId, projectId, selectedToolNames,
        );
        // For non-skill tools (custom/MCP) fall back to the full description
        for (const m of allExtraManifests) {
          if (!skillMdMap.has(m.name) && (!selectedToolNames || selectedToolNames.has(m.name))) {
            if (m.description?.trim()) skillMdMap.set(m.name, m.description);
          }
        }
        deferredMetaTool = this.buildGetToolInstructions(skillMdMap);

        // DESCRIPTIVE skills (agentskills.io) are not tools → absent from the tool list
        // and meta-tool. They must be injected anyway (instructions run via sandbox).
        const descr = await this.skillsService.buildDescriptiveSkillsPrompt(userId, projectId);
        if (descr) skillsPrompt = skillsPrompt ? `${skillsPrompt}\n\n${descr}` : descr;
      }
    } else {
      // Normal mode: SKILL.md pre-loaded into the system prompt (selective via RAG)
      skillsPrompt = userId
        ? await this.skillsService.buildSkillSystemPromptSelective(userId, projectId, selectedToolNames)
        : '';

      // COMPRESSED loses everything past the first sentence of each tool
      // description. Skills keep their SKILL.md in the system prompt, but
      // custom/MCP/flow/agent tools have no other doc channel: expose the
      // same get_tool_instructions meta-tool serving the FULL original
      // descriptions on demand (the compressed description points at it).
      if (effectiveConfig.schemaFormat === 'compressed') {
        const fullDescMap = new Map<string, string>();
        for (const m of allExtraManifests) {
          if (!selectedToolNames || selectedToolNames.has(m.name)) {
            if (m.description?.trim()) fullDescMap.set(m.name, m.description);
          }
        }
        if (fullDescMap.size) deferredMetaTool = this.buildGetToolInstructions(fullDescMap);
      }
    }

    // Catalog of the tools filtered out by top-K selection: without it the
    // model denies capabilities that exist but were not loaded for this message.
    if (excludedListText) {
      skillsPrompt = skillsPrompt ? `${skillsPrompt}\n\n${excludedListText}` : excludedListText;
    }

    const userPrompt    = user?.systemPrompt;
    const projectPrompt = project?.systemPrompt;

    // ── Persistent user memory (A-MEM F2) ─────────────────────────────────────
    // Only the PINNED notes live in the cached prefix (stable, they change
    // rarely). The rest of the memory enters per-query via hybrid retrieval,
    // in the NON-cached blocks below — injecting everything here would both
    // bloat the prompt and (if per-query) invalidate the stable-prefix cache.
    let userMemory: string[] | null = null;
    if (user?.autoMemoryEnabled && userId && this.userMemoryService) {
      try {
        userMemory = await this.userMemoryService.getPinnedContents(userId);
      } catch (err: any) {
        this.logger.warn(`Failed to load user memory: ${err?.message ?? err}`);
      }
    }

    const systemPrompt  = this.buildSystemPrompt(basePrompt, userPrompt, projectPrompt, skillsPrompt, userMemory, user?.language);

    // The conversation summary (history compaction) goes in the system prompt:
    // it is the only place accepted by ALL providers (a single system message).
    // Kept separate from the base block so that, for Anthropic, it does not invalidate
    // the stable-prefix cache (the summary changes only when compaction triggers).
    const summaryTextBlock = summary?.trim() ? summaryBlock(summary) : null;

    // ── Feedback-memory (corrections from past feedback) ──────────────────────
    // If memory is enabled, retrieve the most similar feedback (own personal +
    // approved shared) and inject it as a separate, NON-cached block (it changes
    // on every query, like the summary). Best-effort: errors do not block the chat.
    let feedbackTextBlock: string | null = null;
    if (feedbackEnabled && userId && userInput?.trim() && this.feedbackService) {
      const hits = await this.feedbackService.searchMemory(userId, userInput, 3);
      if (hits.length) {
        feedbackTextBlock = feedbackBlock(hits);
        this.logger.debug(`Feedback-memory: ${hits.length} corrections injected`);
      }
    }

    // ── Retrieved memory notes (A-MEM F2) ─────────────────────────────────────
    // Hybrid FTS+vector retrieval over the confirmed notes, driven by the current
    // message (+ the tail of the rolling summary, so short replies like "yes, go
    // ahead" still carry topical signal). Per-query → NON-cached block. Pinned
    // notes are excluded here: they already sit in the stable prefix.
    let memoryTextBlock: string | null = null;
    if (user?.autoMemoryEnabled && userId && userInput?.trim() && this.userMemoryService) {
      try {
        const query = summary?.trim()
          ? `${userInput}\n${summary.trim().slice(-400)}`
          : userInput;
        const notes = await this.userMemoryService.retrieve(userId, query);
        if (notes.length) {
          memoryTextBlock = memoryBlock(notes);
          this.logger.debug(`Memory: ${notes.length} retrieved notes injected`);
        }
      } catch (err: any) {
        this.logger.warn(`Memory retrieval failed: ${err?.message ?? err}`);
      }
    }

    // ── Current date/time ─────────────────────────────────────────────────────
    // Absolute time reference: without it the model does not know "what time it is
    // now" and for relative requests ("in 3 minutes") it hallucinates a timestamp,
    // often in the past → automations that never fire. It goes in the NON-cached
    // blocks because it changes on every request (like summary/feedback).
    const nowTextBlock = nowBlock(isoWithOffset(new Date(), DEFAULT_TIMEZONE), DEFAULT_TIMEZONE);

    // Extra non-cached blocks (change per request): date/time + summary + feedback + memory.
    const extraBlocks = [nowTextBlock, summaryTextBlock, feedbackTextBlock, memoryTextBlock].filter((b): b is string => !!b);

    // ── Prompt caching: build the messageModifier based on the provider ───────
    //
    // Anthropic — explicit cache via `cache_control: { type: "ephemeral" }`.
    //   The marker tells the provider to cache all content up to that
    //   point (system + skills + tool descriptions). Cache TTL: 5 min.
    //   Cost: write × 1.25, read × 0.10 → ~90% savings on cache-reads.
    //
    // OpenAI / Gemini — automatic cache on the stable prefix (no marker).
    //   LangChain already maps `cached_tokens` / `cachedContentTokenCount`
    //   into `usage_metadata.input_token_details.cache_read` → logged in streamResponse.
    //
    // DeepSeek — automatic cache; `prompt_cache_hit_tokens` intercepted
    //   in LlmProviderService's fetch interceptor.
    const messageModifier: string | SystemMessage =
      provider === 'anthropic'
        ? new SystemMessage({
            content: [
              {
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral' },
              } as any,
              // Separate, NON-cached extra blocks (summary + feedback-memory):
              // they change per request and must not invalidate the stable-prefix cache.
              ...extraBlocks.map((b) => ({ type: 'text', text: b } as any)),
            ],
          })
        : extraBlocks.length
          ? `${systemPrompt}\n\n${extraBlocks.join('\n\n')}`
          : systemPrompt;

    // Always-available built-in tools: automation scheduling (Auto-Scheduling),
    // with a confirmation flow (schedule_task prepares → confirm_scheduled_task activates).
    // Origin chatId: for one-shots it becomes the delivery chat of the result.
    const schedulingTools = userId ? this.schedulingService.buildSchedulingTools(userId, projectId, chatId) : [];

    // Memory (A-MEM F5): save_memory / search_memory, gated by the same toggle
    // that governs automatic memory. save_memory only proposes (pending).
    const memoryTools = user?.autoMemoryEnabled && userId && this.userMemoryService
      ? this.userMemoryService.buildMemoryTools(userId, chatId)
      : [];

    // Sandbox (arbitrary code/shell): gated per-request built-in. When enabled
    // for the user/project/team it is always present (bypasses the RAG); otherwise absent.
    const sandboxTools = userId && await this.sandboxService.isEnabledFor(userId, projectId, (user as any)?.role === 'admin')
      ? this.sandboxService.buildSandboxTools(userId, projectId, chatId)
      : [];

    const allTools = [
      ...this.builtInTools,
      ...optimizedExtraTools,
      ...schedulingTools,
      ...memoryTools,
      ...sandboxTools,
      ...(deferredMetaTool ? [deferredMetaTool] : []),
    ];

    // ── Context breakdown (token estimates) ──────────────────────────────────
    const est = (s: string) => Math.ceil(s.length / 4);
    const toolsEstimate = allTools.reduce((acc, t) => {
      const schemaStr = JSON.stringify(t.schema?.shape ?? t.inputSchema ?? {});
      return acc + est((t.description ?? '') + schemaStr);
    }, 0);
    const historyEstimate = history.slice(-20).reduce((acc, m) => acc + est(m.content), 0);

    const contextBreakdown: ContextBreakdown = {
      systemTok:  est(systemPrompt) - est(skillsPrompt),
      skillsTok:  est(skillsPrompt),
      toolsTok:   toolsEstimate,
      toolsCount: allTools.length,
      historyTok: historyEstimate,
      queryTok:   est(userInput ?? ''),
    };

    this.logger.log(
      `Agente [${effectiveConfig.strategy}/${effectiveConfig.schemaFormat}]: ` +
      `${customTools.length} custom + ${mcpTools.length} MCP + ${skillTools.length} skill ` +
      `→ ${optimizedExtraTools.length} effective tools for user ${userId}` +
      (deferredMetaTool ? ' + get_tool_instructions' : ''),
    );

    return {
      agent: createReactAgent({
        llm:             model,
        tools:           allTools,
        messageModifier,
      }),
      contextBreakdown,
      effectiveMaxHistoryTokens,
      model,
      effectiveHistory,
      provider,
      modelName,
    };
  }

  /**
   * Builds the `get_tool_instructions` meta-tool for deferred mode.
   *
   * The LLM can call this tool before using a specific one to obtain
   * the SKILL.md (or the description) on-demand, without it being pre-loaded
   * into the system prompt.
   *
   * @param instructionsMap  Map<toolName, instructions> pre-built from:
   *   - SkillsService.getSkillMdMap() for skill tools (per-script SKILL.md)
   *   - the manifest's full description for custom/MCP tools (fallback)
   */
  private buildGetToolInstructions(instructionsMap: Map<string, string>): DynamicStructuredTool {
    const availableNames = [...instructionsMap.keys()];
    return new DynamicStructuredTool({
      name: 'get_tool_instructions',
      description:
        'Returns detailed instructions for using a specific tool. ' +
        'Call it before a tool for which you need more information about parameters or behavior.',
      schema: z.object({
        tool_name: z.string().describe('Exact name of the tool you want instructions for'),
      }),
      func: async ({ tool_name }) => {
        const instructions = instructionsMap.get(tool_name);
        if (!instructions) {
          return (
            `No specific instructions for "${tool_name}". ` +
            `Tools with available instructions: ${availableNames.join(', ')}`
          );
        }
        this.logger.debug(`[DEFERRED] get_tool_instructions("${tool_name}") → ${instructions.length} char`);
        return instructions;
      },
    });
  }
}

// ── Internal types ──────────────────────────────────────────────────────────────

interface ContextBreakdown {
  systemTok:  number;   // tok estimate: basePrompt + userPrompt + projectPrompt
  skillsTok:  number;   // tok estimate: SKILL.md and skill metadata
  toolsTok:   number;   // tok estimate: injected tool schemas
  toolsCount: number;   // number of injected tools
  historyTok: number;   // tok estimate: message history (slice -20)
  queryTok:   number;   // tok estimate: current message
}
