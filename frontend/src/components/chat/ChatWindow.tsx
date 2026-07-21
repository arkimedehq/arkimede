import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Check, X, Brain, Eye, Network } from 'lucide-react';
import { messagesApi } from '../../api/messages';
import { chatsApi } from '../../api/chats';
import { agentTeamsApi } from '../../api/agents';
import { feedbackApi } from '../../api/feedback';
import { userMemoryApi, type MemoryProposal } from '../../api/userMemory';
import { useStore, type Message } from '../../store/useStore';
import MessageBubble, { sandboxSkillName } from './MessageBubble';
import MessageInput from './MessageInput';
import FilePanel from '../files/FilePanel';
import { downloadWithAuth } from '../../utils/downloadWithAuth';

interface Props {
  chatId: string;
}

interface SkillFile {
  name: string;
  rel?: string;              // legacy owner-only ?rel= link (within the caller's subdir)
  downloadUrl?: string;      // access-aware by-id link (shareable with team/project members)
}

/** Merges new proposals avoiding duplicates by id. */
function mergeProposals(prev: MemoryProposal[], next: MemoryProposal[]): MemoryProposal[] {
  const seen = new Set(prev.map((p) => p.id));
  return [...prev, ...next.filter((p) => !seen.has(p.id))];
}

function SkillFileChip({ name, rel, downloadUrl }: SkillFile) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  const handleDownload = async () => {
    if (state === 'loading') return;
    setState('loading');
    try {
      // Prefer the access-aware by-id link (works for team/project members too);
      // fall back to the legacy owner-only ?rel= link.
      const href = downloadUrl ?? `/api/files/raw?rel=${encodeURIComponent(rel ?? '')}`;
      await downloadWithAuth(href, name);
      setState('idle');
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  };

  return (
    <button
      onClick={handleDownload}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors
        ${state === 'error'
          ? 'bg-red-950/40 border-red-700/50 text-red-400'
          : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-blue-500/50 hover:text-blue-300'}`}
      title={rel}
    >
      {state === 'loading'
        ? <><Loader2 size={11} className="animate-spin" /> Download…</>
        : state === 'error'
          ? '⚠ Error'
          : <><Download size={11} /> {name}</>}
    </button>
  );
}

export default function ChatWindow({ chatId }: Props) {
  const { t } = useTranslation('chat');
  const qc = useQueryClient();
  const bottomRef   = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const [streamError, setStreamError] = useState<{ message: string; code?: string } | null>(null);
  const [skillFiles, setSkillFiles]   = useState<SkillFile[]>([]);
  const [memoryProposals, setMemoryProposals] = useState<MemoryProposal[]>([]);
  const [memoryBusy, setMemoryBusy]   = useState(false);
  const [agentSteps, setAgentSteps]   = useState<{ agent: string; role?: string | null; output: string }[]>([]);
  const { isStreaming, streamingContent, setIsStreaming, setStreamingContent, appendStreamingContent, clearToolCalls, addToolCall, resolveToolCall, pendingToolCalls, filesPanelOpen, registerStopFn } = useStore();

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['messages', chatId],
    queryFn: () => messagesApi.list(chatId),
    enabled: !!chatId,
  });

  // Chat metadata: we need the author to determine whether this is a colleague's chat in
  // a shared project → in that case the conversation is read-only (v1).
  const currentUserId = useStore((s) => s.user?.id);
  const { data: chatMeta } = useQuery({
    queryKey: ['chat-meta', chatId],
    queryFn: () => chatsApi.get(chatId),
    enabled: !!chatId,
  });
  // Read-only only if the backend denies writing (viewer / non-member).
  // Project collaborators can write in the same thread (Phase 3).
  const readOnly = !!chatMeta && chatMeta.canWrite === false;

  // Available agent teams (Multi-Agent) for the "run with a team" selector.
  const { data: agentTeams = [] } = useQuery({
    queryKey: ['agent-teams'], queryFn: agentTeamsApi.list, staleTime: 30_000, enabled: !!chatId,
  });
  const setChatTeam = async (agentTeamId: string | null) => {
    await chatsApi.setAgentTeam(chatId, agentTeamId);
    qc.invalidateQueries({ queryKey: ['chat-meta', chatId] });
  };

  // Feedback-memory state (global toggle) + feedback already given in this chat
  const { data: feedbackConfig } = useQuery({
    queryKey: ['feedback-config'],
    queryFn: () => feedbackApi.getConfig(),
    staleTime: 60_000,
  });
  const feedbackEnabled = feedbackConfig?.enabled ?? false;

  const { data: chatFeedback = [] } = useQuery({
    queryKey: ['feedback', chatId],
    queryFn: () => feedbackApi.listForChat(chatId),
    enabled: !!chatId && feedbackEnabled,
  });
  const feedbackByMessage = new Map(chatFeedback.map((f) => [f.messageId, f]));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setStreamingContent('');
    clearToolCalls();
  };

  // Register the stop function in the global store (for GlobalHeader)
  useEffect(() => {
    registerStopFn(stopStreaming);
    return () => registerStopFn(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = async (
    content: string,
    attachments: { name: string; fileId: string; mimeType: string; mode?: 'embed' | 'inline' | 'attachment' }[],
  ) => {
    if (isStreaming || readOnly) return;

    // Optimistic update — show the user message immediately
    const tempUserMsg: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      attachments,
      createdAt: new Date().toISOString(),
    };
    qc.setQueryData(['messages', chatId], (old: Message[] = []) => [...old, tempUserMsg]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsStreaming(true);
    setStreamingContent('');
    setStreamError(null);
    setSkillFiles([]);
    setAgentSteps([]);
    clearToolCalls();

    const cleanup = () => {
      abortRef.current = null;
      setIsStreaming(false);
      setStreamingContent('');
      setStreamError(null);
    };

    try {
      await messagesApi.stream(
        chatId,
        content,
        attachments,
        appendStreamingContent,
        addToolCall,
        (_messageId, inputTokens, outputTokens) => {
          // Done — update the cache with the received tokens before reloading
          if (_messageId && (inputTokens != null || outputTokens != null)) {
            qc.setQueryData(['messages', chatId], (old: Message[] = []) =>
              old.map((m) =>
                m.id === _messageId
                  ? { ...m, inputTokens: inputTokens ?? null, outputTokens: outputTokens ?? null }
                  : m,
              ),
            );
          }
          qc.invalidateQueries({ queryKey: ['messages', chatId] });
          qc.invalidateQueries({ queryKey: ['chats'] });
          qc.invalidateQueries({ queryKey: ['files', 'chat', chatId] });
          cleanup();
        },
        (errMsg, errCode) => {
          // Dedicated error event: show the banner until done reloads the list
          console.error('Stream error:', errCode, errMsg);
          setStreamError({ message: errMsg, code: errCode });
          // We don't call cleanup() here: the done event right after handles it
        },
        ctrl.signal,
        (name, rel, downloadUrl) => {
          setSkillFiles((prev) => {
            const key = downloadUrl ?? rel;
            if (prev.some((f) => (f.downloadUrl ?? f.rel) === key)) return prev;
            return [...prev, { name, rel, downloadUrl }];
          });
        },
        // onToolResult — update the live indicator: ⚙ running → ✓/✗ when the result is received.
        // The full input (tool args) is only known now → pass it so run_in_sandbox can show the skill.
        (name, ok, input) => resolveToolCall(name, ok, input),
        // onMemoryProposal — the agent proposes new facts to store (inline confirmation)
        (proposals) => setMemoryProposals((prev) => mergeProposals(prev, proposals)),
        // onAgentStep — intermediate steps of an agent team (Multi-Agent)
        (step) => setAgentSteps((prev) => [...prev, step]),
      );
    } catch (err: any) {
      // AbortError = intentional stop → not an error to log
      if (err?.name !== 'AbortError') console.error(err);
      cleanup();
    }
  };

  // ── Truncate/rewind: delete a message and all the following ones ──────────────
  const truncateFrom = async (messageId: string) => {
    if (isStreaming || readOnly) return;
    if (!window.confirm(t('truncate.confirm'))) return;
    try {
      await messagesApi.truncateFrom(chatId, messageId);
      qc.invalidateQueries({ queryKey: ['messages', chatId] });
      qc.invalidateQueries({ queryKey: ['chats'] });
      qc.invalidateQueries({ queryKey: ['feedback', chatId] });
    } catch (err) {
      console.error('Truncate failed', err);
    }
  };

  // ── User memory: confirm / reject proposals ─────────────────────────────
  const confirmMemory = async (ids: string[]) => {
    if (!ids.length || memoryBusy) return;
    setMemoryBusy(true);
    try {
      await userMemoryApi.confirm(ids);
      setMemoryProposals((prev) => prev.filter((p) => !ids.includes(p.id)));
    } catch (err) {
      console.error('Memory confirmation failed', err);
    } finally {
      setMemoryBusy(false);
    }
  };

  const dismissMemory = async (ids: string[]) => {
    if (!ids.length || memoryBusy) return;
    setMemoryBusy(true);
    try {
      // Rejected pending items are deleted so they aren't left hanging
      await Promise.allSettled(ids.map((id) => userMemoryApi.remove(id)));
      setMemoryProposals((prev) => prev.filter((p) => !ids.includes(p.id)));
    } catch (err) {
      console.error('Memory dismissal failed', err);
    } finally {
      setMemoryBusy(false);
    }
  };

  // On-demand extraction from the current conversation
  const extractMemoryNow = async () => {
    if (memoryBusy || isStreaming) return;
    setMemoryBusy(true);
    try {
      const { proposals } = await userMemoryApi.extract(chatId);
      if (proposals.length) {
        setMemoryProposals((prev) => mergeProposals(prev, proposals));
      }
    } catch (err) {
      console.error('Memory extraction failed', err);
    } finally {
      setMemoryBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              authorLabel={
                msg.role === 'user' && msg.authorId && currentUserId && msg.authorId !== currentUserId
                  ? (msg.authorName ?? t('colleagueFallback'))
                  : null
              }
              feedbackEnabled={feedbackEnabled}
              feedback={feedbackByMessage.get(msg.id)}
              onFeedbackChange={() => qc.invalidateQueries({ queryKey: ['feedback', chatId] })}
              onTruncate={readOnly ? undefined : truncateFrom}
            />
          ))}

          {/* Tool calls indicator */}
          {isStreaming && pendingToolCalls.length > 0 && (
            <div className="flex justify-start">
              <div className="bg-gray-800 rounded-xl px-4 py-2 text-sm text-gray-400 space-y-1">
                {pendingToolCalls.map((tc, i) => {
                  const skill = tc.name === 'run_in_sandbox' ? sandboxSkillName(tc.input) : null;
                  const label = skill ? `run_in_sandbox:${skill}` : tc.name;
                  return (
                  <div key={i} className="flex items-center gap-2">
                    {tc.ok === undefined ? (
                      <>
                        <Loader2 size={13} className="text-yellow-400 animate-spin flex-shrink-0" />
                        <span>{t('toolCall.runningPre')} <strong>{label}</strong>…</span>
                      </>
                    ) : tc.ok ? (
                      <>
                        <Check size={13} className="text-emerald-400 flex-shrink-0" />
                        <span><strong>{label}</strong> {t('toolCall.donePost')}</span>
                        {tc.durationMs != null && (
                          <span className="text-[11px] text-gray-500 font-mono">{tc.durationMs}ms</span>
                        )}
                      </>
                    ) : (
                      <>
                        <X size={13} className="text-red-400 flex-shrink-0" />
                        <span><strong>{label}</strong> {t('toolCall.failedPost')}</span>
                        {tc.durationMs != null && (
                          <span className="text-[11px] text-gray-500 font-mono">{tc.durationMs}ms</span>
                        )}
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Streaming assistant bubble */}
          {isStreaming && streamingContent && (
            <MessageBubble
              message={{
                id: 'streaming',
                role: 'assistant',
                content: streamingContent,
                createdAt: new Date().toISOString(),
              }}
              isStreaming
            />
          )}

          {/* Error banner — visible between the end of streaming and the message reload */}
          {streamError && !isStreaming && (
            <div className="flex justify-start">
              <div className={`rounded-xl px-4 py-3 text-sm max-w-xl border ${
                streamError.code === 'billing'
                  ? 'bg-amber-950/40 border-amber-700/50 text-amber-300'
                  : streamError.code === 'rate_limit'
                  ? 'bg-blue-950/40 border-blue-700/50 text-blue-300'
                  : 'bg-red-950/40 border-red-700/50 text-red-300'
              }`}>
                <div className="flex items-start gap-2">
                  <span className="text-base mt-0.5">
                    {streamError.code === 'billing' ? '💳' : streamError.code === 'rate_limit' ? '⏱' : '⚠️'}
                  </span>
                  <span>{streamError.message}</span>
                </div>
              </div>
            </div>
          )}

          {/* Typing indicator (when no content yet) */}
          {isStreaming && !streamingContent && pendingToolCalls.length === 0 && (
            <div className="flex justify-start">
              <div className="bg-gray-800 rounded-2xl px-4 py-3 flex items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Memory proposal — inline confirmation of the extracted facts */}
          {memoryProposals.length > 0 && (
            <div className="flex justify-start">
              <div className="bg-indigo-950/40 border border-indigo-700/50 rounded-xl px-4 py-3 max-w-xl w-full space-y-2">
                <div className="flex items-center gap-2 text-sm text-indigo-200 font-medium">
                  <Brain size={15} className="text-indigo-400" />
                  {t('memory.askRemember')}
                </div>
                <ul className="space-y-1.5">
                  {memoryProposals.map((p) => (
                    <li key={p.id} className="flex items-start gap-2 text-sm text-gray-200">
                      <span className="flex-1 leading-snug">{p.content}</span>
                      <button
                        onClick={() => confirmMemory([p.id])}
                        disabled={memoryBusy}
                        className="p-1 rounded text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-50"
                        title={t('memory.remember')}
                      >
                        <Check size={15} />
                      </button>
                      <button
                        onClick={() => dismissMemory([p.id])}
                        disabled={memoryBusy}
                        className="p-1 rounded text-gray-400 hover:bg-red-500/15 hover:text-red-400 disabled:opacity-50"
                        title={t('memory.ignore')}
                      >
                        <X size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-3 pt-1 text-xs">
                  <button
                    onClick={() => confirmMemory(memoryProposals.map((p) => p.id))}
                    disabled={memoryBusy}
                    className="text-indigo-300 hover:text-indigo-200 font-medium disabled:opacity-50"
                  >
                    Ricorda tutto
                  </button>
                  <button
                    onClick={() => dismissMemory(memoryProposals.map((p) => p.id))}
                    disabled={memoryBusy}
                    className="text-gray-400 hover:text-gray-300 disabled:opacity-50"
                  >
                    Ignora tutto
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Agent team steps (Multi-Agent) during the current response */}
          {agentSteps.length > 0 && (
            <div className="flex justify-start">
              <div className="w-full max-w-2xl space-y-1">
                {agentSteps.map((s, i) => (
                  <div key={i} className="text-xs border border-gray-800 rounded-lg px-2.5 py-1.5 bg-gray-900/40">
                    <span className="text-indigo-300 font-medium inline-flex items-center gap-1"><Network size={11} /> {s.agent}</span>
                    {s.role && <span className="text-gray-600"> · {s.role}</span>}
                    <div className="text-gray-400 mt-0.5 whitespace-pre-wrap break-words line-clamp-3">{s.output}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Skill file chips — files generated by skills during the current response */}
          {skillFiles.length > 0 && (
            <div className="flex justify-start">
              <div className="flex flex-wrap gap-2">
                {skillFiles.map((f) => (
                  <SkillFileChip key={f.downloadUrl ?? f.rel} name={f.name} rel={f.rel} downloadUrl={f.downloadUrl} />
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* File panel — controlled by GlobalHeader via store */}
        {filesPanelOpen && (
          <div className="w-72 border-l border-gray-800 overflow-y-auto">
            <FilePanel chatId={chatId} projectId={chatMeta?.projectId} />
          </div>
        )}
      </div>

      {/* Input — read-only for colleagues' chats (shared project) */}
      {readOnly ? (
        <div className="border-t border-gray-800 p-4 flex items-center justify-center gap-2 text-sm text-gray-500">
          <Eye size={14} />
          {t('readOnly', { author: chatMeta?.authorName ?? t('readOnlyAuthorFallback') })}
        </div>
      ) : (
        <div className="border-t border-gray-800 p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-500" title={t('team.title')}>
              <Network size={13} className={chatMeta?.agentTeamId ? 'text-indigo-400' : ''} />
              <select
                value={chatMeta?.agentTeamId ?? ''}
                onChange={(e) => setChatTeam(e.target.value || null)}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-300"
              >
                <option value="">{t('team.single')}</option>
                {agentTeams.map((tm) => <option key={tm.id} value={tm.id}>{t('team.option', { name: tm.name })}</option>)}
              </select>
            </label>
            <button
              onClick={extractMemoryNow}
              disabled={memoryBusy || isStreaming}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-indigo-300 disabled:opacity-40 transition-colors"
              title={t('memory.updateTitle')}
            >
              {memoryBusy
                ? <Loader2 size={13} className="animate-spin" />
                : <Brain size={13} />}
              {t('memory.update')}
            </button>
          </div>
          <MessageInput onSend={sendMessage} disabled={isStreaming} chatId={chatId} projectId={chatMeta?.projectId} />
        </div>
      )}
    </div>
  );
}
