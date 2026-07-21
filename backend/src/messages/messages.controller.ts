import {Body, Controller, Delete, Get, Inject, Logger, Param, Post, Req, Res, UseGuards,} from '@nestjs/common';
import {Request, Response} from 'express';
import {join, resolve, relative, sep, basename} from 'path';
import {existsSync} from 'fs';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {IsArray, IsOptional, IsString} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {MessagesService} from './messages.service';
import {ChatsService} from '../chats/chats.service';
import {AgentService} from '../agent/agent.service';
import {MultiAgentService} from '../agents/multi-agent.service';
import {FilesService} from '../files/files.service';
import {UserMemoryService} from '../user-memory/user-memory.service';

class SendMessageDto {
  @IsString() content: string;
  @IsOptional() @IsArray() attachments?: { name: string; fileId: string; mimeType: string; mode?: 'embed' | 'inline' | 'attachment' }[];
}


@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/chats/:chatId/messages')
export class MessagesController {
  constructor(
    @Inject(MessagesService) private readonly messagesService: MessagesService,
    @Inject(ChatsService) private readonly chatsService: ChatsService,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(MultiAgentService) private readonly multiAgent: MultiAgentService,
    @Inject(FilesService) private readonly filesService: FilesService,
    @Inject(UserMemoryService) private readonly userMemoryService: UserMemoryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Messages of a chat' })
  async findAll(@Param('chatId') chatId: string, @CurrentUser() user: any) {
    await this.chatsService.findOne(chatId, user.id);
    return this.messagesService.findByChat(chatId);
  }

  @Delete(':messageId')
  @ApiOperation({ summary: 'Truncate/rewind: deletes the message and all following ones' })
  async truncate(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: any,
  ) {
    // Same gate as sending: the chat's author or a collaborator/owner of the
    // shared project. Viewer and non-members → 403.
    await this.chatsService.findOneForWrite(chatId, user.id);
    const deletedIds = await this.messagesService.truncateFrom(chatId, messageId);
    await this.chatsService.clearStaleMarkers(chatId, deletedIds);
    await this.chatsService.touch(chatId);
    return { deletedCount: deletedIds.length };
  }

  @Post('stream')
  @ApiOperation({ summary: 'Send message — SSE streaming response' })
  async streamMessage(
    @Param('chatId') chatId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // SSE headers — sent immediately before any processing
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.flushHeaders();

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      // force flush on Node.js HTTP
      (res as any).flush?.();
    };

    // AbortController tied to the lifetime of the SSE connection.
    // When the client closes the tab/navigates away, 'close' fires
    // and the signal interrupts LangGraph + the LLM call.
    const abortCtrl = new AbortController();
    req.on('close', () => {
      if (!abortCtrl.signal.aborted) abortCtrl.abort();
    });

    // Immediate heartbeat — confirms that the SSE channel is open
    send({ type: 'connected' });

    try {
      // Write: the chat's author OR a collaborator/owner of the project
      // the chat belongs to (shared threads). Viewer and non-members → 403.
      const chat = await this.chatsService.findOneForWrite(chatId, user.id);

      // Load the history BEFORE saving the current message: this way `history`
      // contains only the previous turns and the current message (dto.content)
      // is passed only once as `userInput` to streamResponse — avoiding
      // sending it to the model twice.
      const history = await this.messagesService.findByChat(chatId);

      await this.messagesService.save({
        chatId,
        role: 'user',
        content: dto.content,
        attachments: dto.attachments || [],
        authorId: user.id, // who wrote the turn (shared threads)
      });

      // The title auto-derived from the first message is set only by the chat's
      // author (updateTitle is author-only → this avoids a spurious 403 if a
      // collaborator were the first to write).
      if (chat.title === 'Nuova chat' && chat.userId === user.id) {
        await this.chatsService.updateTitle(chatId, user.id, dto.content.slice(0, 60));
      }

      // ── Multi-Agent branch: if the chat has a team, run it and return ────────
      // Isolated from the single-agent path: emits the per-agent steps as SSE,
      // then the final response as a chunk. (MA-4: non-streaming run; the team's
      // token usage is not tracked — future improvement.)
      if (chat.agentTeamId) {
        send({ type: 'agent_team_start', teamId: chat.agentTeamId });
        try {
          const result = await this.multiAgent.runTeamById(
            chat.agentTeamId, user.id, dto.content, chat.projectId ?? undefined,
          );
          for (const step of result.steps) {
            send({ type: 'agent_step', agent: step.agent, role: step.role, output: step.output });
          }
          send({ type: 'chunk', content: result.final });
          const assistantMsg = await this.messagesService.save({
            chatId, role: 'assistant', content: result.final || '_(no response)_',
            inputTokens:      result.usage?.inputTokens      ?? null,
            outputTokens:     result.usage?.outputTokens     ?? null,
            cacheReadTokens:  result.usage?.cacheReadTokens  ?? null,
            cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
            provider: result.provider ?? null,
            model:    result.model    ?? null,
          });
          await this.chatsService.touch(chatId);
          send({
            type: 'done', messageId: assistantMsg.id,
            inputTokens: result.usage?.inputTokens ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
          });
        } catch (teamErr: any) {
          send({ type: 'error', message: teamErr?.message ?? 'Team execution error' });
        }
        res.end();
        return;
      }

      const inlineContents: { name: string; content: string }[] = [];
      const attachmentBlocks: { name: string; mimeType: string; base64: string }[] = [];

      // MIME types natively supported by Claude as a content block
      const CLAUDE_NATIVE_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

      // Enriches each attachment with an absolute storagePath (resolved only once).
      // This lets the LLM pass file_path to skills without extra tools.
      const enrichedAttachments: any[] = [];
      for (const att of dto.attachments ?? []) {
        if (att.mode === 'inline') {
          const file = await this.filesService.findOneReadable(att.fileId, user.id);
          const text = await this.filesService.extractText(file);
          inlineContents.push({ name: att.name, content: text });
          enrichedAttachments.push(att);
        } else if (att.mode === 'attachment') {
          const file  = await this.filesService.findOneReadable(att.fileId, user.id);
          const absPath = resolve(file.storagePath); // absolute path accessible from skills
          // Reads base64 only for types natively supported by Claude (images + PDF)
          if (CLAUDE_NATIVE_MIMES.includes(att.mimeType)) {
            const base64 = this.filesService.readAsBase64(file);
            attachmentBlocks.push({ name: att.name, mimeType: att.mimeType, base64 });
          }
          enrichedAttachments.push({ ...att, storagePath: absPath });
        } else {
          enrichedAttachments.push(att);
        }
      }

      let fullContent = '';

      const uploadDir = resolve(process.env.UPLOAD_DIR ?? './uploads');
      // Roots allowed for download (must match FilesController.getAllowedDirs).
      // The SSE 'file' event emits a path RELATIVE to one of these roots (?rel=),
      // never an absolute path (download via ?path= has been removed).
      const downloadRoots = [
        uploadDir,
        resolve(process.env.SKILLS_OUTPUT_DIR ?? './uploads/skills-output'),
      ];

      // ── Collecting tool calls for the history/debug ─────────────────────────
      // We pair each onToolCall (LLM request) with the subsequent
      // onToolResult (LangGraph runs the tools in sequence → match by name+order).
      // The array is then persisted on Message.toolCalls.
      type ToolCallRecord = {
        name: string;
        input: any;
        output?: any;
        ok?: boolean;
        startedAt: number;
        durationMs?: number;
      };
      const toolCallRecords: ToolCallRecord[] = [];
      // Generated output files (skills/sandbox) tracked during this turn → appended to
      // the assistant message's attachments so they surface in the chat/project file
      // panel (findByChatId reads message.attachments), even for chats without a project.
      const outputAttachments: { name: string; fileId: string; mimeType: string }[] = [];
      const outputTracking: Promise<void>[] = [];
      const seenOutputIds = new Set<string>();
      const mimeForName = (n: string): string => {
        const ext = n.toLowerCase().split('.').pop() ?? '';
        const map: Record<string, string> = {
          pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown',
          csv: 'text/csv', json: 'application/json', html: 'text/html', zip: 'application/zip',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
        return map[ext] ?? 'application/octet-stream';
      };
      const MAX_TOOL_OUTPUT = 8 * 1024; // ~8KB per output, avoids bloating the DB

      const truncateOutput = (val: any): any => {
        let str: string;
        try { str = typeof val === 'string' ? val : JSON.stringify(val); }
        catch { str = String(val); }
        if (str.length > MAX_TOOL_OUTPUT) {
          return str.slice(0, MAX_TOOL_OUTPUT) + `… [truncated — ${str.length} total characters]`;
        }
        return val; // within the limit: preserve the original shape (object/string)
      };

      const usage = await this.agentService.streamResponse(
        dto.content,
        user.id,           // userId  — loads custom tools + user prompt
        chat.projectId,    // projectId — loads project prompt (null if chat without project)
        chatId,            // chatId — for history compaction (persisted rolling summary)
        history,
        enrichedAttachments,
        inlineContents,
        attachmentBlocks,
        (chunk: string) => {
          fullContent += chunk;
          send({ type: 'chunk', content: chunk });
        },
        (toolCall: any) => {
          toolCallRecords.push({ name: toolCall?.name ?? '', input: toolCall?.input, startedAt: Date.now() });
          send({ type: 'tool_call', toolCall });
        },
        abortCtrl.signal,
        // onToolResult — (1) records output/status on the corresponding tool call,
        // (2) recursively scans the result to emit SSE 'file' events.
        // For each string that resolves to an existing file inside UPLOAD_DIR
        // an SSE event { type: 'file', name, absPath } is emitted.
        (toolName: string, result: any, status?: 'success' | 'error', input?: any) => {
          // Pairs with the first record of the same tool still without output
          const record = toolCallRecords.find(r => r.name === toolName && r.output === undefined);
          if (record) {
            record.output = truncateOutput(result);
            record.ok = status !== 'error';
            record.durationMs = Date.now() - record.startedAt;
            // The complete input is only known when the call ends (the args arrive
            // as stream deltas): it replaces the {} captured at tool_call time.
            if (input !== undefined) record.input = truncateOutput(input);
          }
          send({ type: 'tool_result', name: toolName, ok: status !== 'error', ...(input !== undefined ? { input: truncateOutput(input) } : {}) });

          const seen = new Set<string>();
          // Captures for output tracking (C2 access-aware download): `this`
          // is not the controller inside the walk function.
          const filesSvc      = this.filesService;
          const outUserId     = user.id;
          const outProjectId  = chat.projectId ?? null;
          const skillsOutBase = resolve(process.env.SKILLS_OUTPUT_DIR ?? join(uploadDir, 'skills-output'));
          // Skill outputs are materialized in the caller's OWN per-user subdir (broker copy-out).
          const userOutDir    = join(skillsOutBase, outUserId || '_shared');

          // Tracks a downloadable output as a File (owner = user, chat's project) — so it
          // is access-aware AND shows up in the project's files — and emits an SSE 'file'
          // event. The ROBUST link is `downloadUrl` (by File id: access-aware, shareable
          // with team/project members via canAccessFile); `rel` is the legacy owner-only
          // ?rel= link, valid within the caller's own subdir.
          const emit = (abs: string): void => {
            if (seen.has(abs) || !existsSync(abs)) return;
            seen.add(abs);
            const name = basename(abs);
            let rel: string | undefined;
            if (abs === userOutDir || abs.startsWith(userOutDir + sep)) rel = relative(userOutDir, abs);
            else if (abs.startsWith(uploadDir + sep))                   rel = relative(uploadDir, abs);
            const tracked = filesSvc.trackOutput(outUserId, outProjectId, abs)
              .then((fileId) => {
                // Attach the tracked file to the assistant message (dedup by File id):
                // this is what makes it appear in the chat/project file panel.
                if (fileId && !seenOutputIds.has(fileId)) {
                  seenOutputIds.add(fileId);
                  outputAttachments.push({ name, fileId, mimeType: mimeForName(name) });
                }
                send({
                  type: 'file', name,
                  ...(rel ? { rel } : {}),
                  ...(fileId ? { fileId, downloadUrl: `/api/files/${fileId}/download` } : {}),
                });
              })
              .catch(() => { /* best-effort, non-blocking */ });
            outputTracking.push(tracked);
          };

          // Maps a bare output name into the caller's own skills-output subdir (guarded).
          const emitFromName = (rawName: string): void => {
            const abs = resolve(join(userOutDir, basename(rawName)));
            if (abs === userOutDir || abs.startsWith(userOutDir + sep)) emit(abs);
          };

          /**
           * Candidate names for a captured `?rel=<x>`. These links are emitted both BARE
           * (`- f: /api/files/raw?rel=f`) and inside a markdown link/image
           * (`[f](/api/files/raw?rel=f)`), so the capture may carry a trailing markdown
           * terminator — but a filename can legitimately end with one too, since
           * encodeURIComponent does not escape `)` (e.g. `report(1).pdf`). The two cases
           * are lexically indistinguishable, so we try both: emit() only surfaces names
           * that resolve to an existing file, and dedups.
           */
          const relCandidates = (captured: string): string[] => {
            let decoded: string;
            try { decoded = decodeURIComponent(captured); } catch { decoded = captured; }
            const trimmed = decoded.replace(/[)\]>]+$/, '');
            return trimmed && trimmed !== decoded ? [decoded, trimmed] : [decoded];
          };

          function walk(value: any): void {
            if (typeof value === 'string') {
              // (a) a ?rel=<x> in one of OUR download URLs → surface the output it points to
              const relMatches = [...value.matchAll(/[?&]rel=([^&\s'"]+)/g)];
              if (relMatches.length) {
                for (const rm of relMatches) {
                  for (const name of relCandidates(rm[1])) emitFromName(name);
                }
                return;
              }
              if (!value.includes('/') || value.startsWith('http') || value.startsWith('/api/')) return;
              // (b) raw path: an on-disk output under a download root (tools) → track directly;
              //     otherwise map its basename under the caller's skills-output subdir (broker skills)
              const direct = value.startsWith('/') ? resolve(value) : resolve(join(uploadDir, value));
              const root = downloadRoots.find((r) => direct === r || direct.startsWith(r + sep));
              if (root && existsSync(direct)) emit(direct);
              else emitFromName(value);
            } else if (Array.isArray(value)) {
              for (const item of value) walk(item);
            } else if (value && typeof value === 'object') {
              for (const v of Object.values(value)) walk(v as any);
            }
          }

          walk(result);
        },
      );

      // Let the output-tracking (trackOutput → File) settle so the generated files
      // are attached to the assistant message (→ visible in the file panel).
      await Promise.allSettled(outputTracking);

      const assistantMsg = await this.messagesService.save({
        chatId,
        role: 'assistant',
        content: fullContent || '_(no response)_',
        toolCalls: toolCallRecords.length ? toolCallRecords : null,
        attachments: outputAttachments.length ? outputAttachments : null,
        inputTokens:  usage?.inputTokens  ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens:  usage?.cacheReadTokens  ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        provider: usage?.provider ?? null,
        model:    usage?.model    ?? null,
      });

      await this.chatsService.touch(chatId);

      // ── Persistent user memory: automatic threshold-based extraction ────────────
      // If the user has enabled memory and enough new turns have accumulated,
      // it extracts durable facts and proposes inline confirmation (SSE).
      // Best-effort: any error must not compromise the chat response.
      try {
        const fullHistory = await this.messagesService.findByChat(chatId);
        const proposals = await this.userMemoryService.maybeExtractOnTurn(user.id, chat, fullHistory);
        if (proposals.length) {
          send({ type: 'memory_proposal', proposals });
        }
      } catch (memErr) {
        new Logger('MessagesController').warn(
          `User memory extraction failed (chat=${chatId}): ${memErr?.message ?? memErr}`,
        );
      }

      send({
        type: 'done',
        messageId:    assistantMsg.id,
        inputTokens:  usage?.inputTokens  ?? null,
        outputTokens: usage?.outputTokens ?? null,
      });

    } catch (err) {
      // Log server-side for debugging (e.g. 400 out of credits, 429 rate limit, etc.)
      new Logger('MessagesController').error(
        `streamMessage error (chat=${chatId}): ${err?.message ?? err}`,
      );

      // Classify the error: readable message + type for the frontend
      const raw: string = err?.message ?? String(err);
      let userMessage: string;
      let errorCode: string;

      if (raw.includes('credit balance is too low') || raw.includes('insufficient_quota')) {
        userMessage = 'API credits exhausted. Top up your balance at console.anthropic.com to continue.';
        errorCode   = 'billing';
      } else if (raw.includes('rate_limit') || raw.includes('429')) {
        userMessage = 'Too many requests in a short time. Try again in a few seconds.';
        errorCode   = 'rate_limit';
      } else if (raw.includes('401') || raw.includes('authentication')) {
        userMessage = 'Invalid or missing API key. Check the configuration in Settings.';
        errorCode   = 'auth';
      } else if (raw.includes('timeout') || raw.includes('AbortError')) {
        userMessage = 'Timeout: the model took too long to respond.';
        errorCode   = 'timeout';
      } else {
        userMessage = raw.slice(0, 300);   // show the raw but truncated
        errorCode   = 'unknown';
      }

      // Save the error message to the DB — so it stays visible in the history
      try {
        const errMsg = await this.messagesService.save({
          chatId,
          role:    'assistant',
          content: `⚠️ ${userMessage}`,
        });
        await this.chatsService.touch(chatId);
        // Dedicated error event + done with real messageId → the frontend reloads
        send({ type: 'error', code: errorCode, message: userMessage });
        send({ type: 'done',  messageId: errMsg.id });
      } catch {
        // Fallback if the save also fails (e.g. invalid chatId)
        send({ type: 'error', code: errorCode, message: userMessage });
        send({ type: 'done',  messageId: null });
      }
    } finally {
      res.end();
    }
  }

}
