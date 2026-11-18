// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Wyoming voice server end-to-end over a real TCP socket, with the providers
 * stubbed: capability advertisement (`describe` → `info` built from the
 * configured STT/TTS), the STT flow (audio-start/chunk/stop → transcript with
 * the buffered PCM wrapped as WAV), the TTS flow (synthesize → PCM chunks
 * with the WAV's real format), the client allowlist and the runtime toggle.
 */
import { currentVoiceClearance } from '../../src/voice-id/voice-clearance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { WyomingService, expectsReply, spokenFailure, voiceBlocks, workingOn, keepTalking, stoppedWork } from '../../src/wyoming/wyoming.service';
import { ConversationFocusService } from '../../src/chats/conversation-focus.service';
import { WyomingDecoder, WyomingEvent, encodeEvent, parseWav, pcmToWav } from '../../src/wyoming/wyoming.protocol';

const VOICE_USER = 'a1a1a1a1-0000-4000-8000-000000000001';
const VOICE_AGENT = 'b2b2b2b2-0000-4000-8000-000000000002';
const OTHER_USER = 'e5e5e5e5-0000-4000-8000-000000000005';

function makeService(opts: { enabled?: boolean; cidrs?: string | null; sttEnabled?: boolean; ttsEnabled?: boolean; handleUser?: string | null; handleAgent?: string | null; persist?: boolean; voiceId?: any; satellites?: Record<string, string>; initiatives?: any; runMs?: number; runFails?: boolean; noRuns?: boolean } = {}) {
  // `handleUser`: the conversation on, with that user as the satellites' default account; `handleAgent`: their voice agent.
  const appConfig = {
    getWyomingConfig: vi.fn(async () => ({
      wyomingEnabled: opts.enabled ?? true, wyomingAllowedCidrs: opts.cidrs ?? null,
      wyomingConversationEnabled: !!opts.handleUser,
      wyomingPersistConversations: opts.persist ?? false,
    })),
    voiceAccounts: vi.fn(async () => ({ memoryUserId: opts.handleUser ?? null, defaultUserId: opts.handleUser ?? null, satellites: opts.satellites ?? {} })),
  };
  const agent = { id: VOICE_AGENT, name: 'Voce Casa', systemPrompt: 'Rispondi in una frase.', toolFilter: { mode: 'names', names: ['mcp_home_assistant_*'] }, maxIterations: 3, llmConfigId: null };
  const clearances: unknown[] = [];
  const agentService = {
    // Echoes the input plus how many history messages it received; emits one tool event.
    streamResponse: vi.fn(async (input: string, _userId: string, _p: any, _c: any, history: any[], _a: any, _i: any, _b: any, onChunk: (s: string) => void, onToolCall: any, signal: AbortSignal, onToolResult: any) => {
      clearances.push(currentVoiceClearance());
      if (opts.runMs) await new Promise((r) => setTimeout(r, opts.runMs));
      if (signal?.aborted) return null;   // as AgentService: a stopped run returns no usage
      if (opts.runFails) throw new Error('Recursion limit of 101 reached');
      onToolCall({ name: 'mcp_home_assistant_GetLiveContext', input: {} });
      onToolResult('mcp_home_assistant_GetLiveContext', 'ok', 'success', {});
      onChunk(`risposta a "${input}" (history=${history.length})`);
      return { inputTokens: 10, outputTokens: 5 };
    }),
  };
  const agentsService = {
    findAll:  vi.fn(async (userId: string) => (userId === VOICE_USER || userId === OTHER_USER ? [agent] : [])),
    findById: vi.fn(async (id: string) => { if (id !== VOICE_AGENT) throw new Error('not found'); return agent; }),
  };
  const usersService = {
    voiceSettings: vi.fn(async (id: string) => (id === VOICE_USER ? { id, email: 'voice@internal.com', status: 'active', voiceAgentId: opts.handleAgent ?? null }
      : id === OTHER_USER ? { id, email: 'other@example.com', status: 'active', voiceAgentId: null } : null)),
  };
  const homeAssistant = { satelliteEntity: (s: string | null) => (s?.startsWith('assist_satellite.') ? s : null) };
  const invocations = { record: vi.fn(async () => undefined) };
  const focus = new ConversationFocusService();
  // One stored chat of the voice user, for focused turns.
  const externalChats = {
    historyOf: vi.fn(async (chatId: string, userId: string) => (chatId === 'chat-1' && userId === VOICE_USER
      ? [{ role: 'user', content: 'prima' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'poi' }, { role: 'assistant', content: 'ok' }]
      : null)),
    recordTurn: vi.fn(async () => 'chat-1'),
    recordUserMessage: vi.fn(async () => 'chat-9'),
    recordAnswer: vi.fn(async () => undefined),
    memoryConversationId: vi.fn(async (turn: any) => turn.chatId ?? `${turn.source}:${turn.key}`),
  };
  const transcription = {
    describe:   vi.fn(async () => ({ provider: 'internal', model: 'faster-whisper-base', enabled: opts.sttEnabled ?? true })),
    transcribe: vi.fn(async (wav: Buffer) => `heard ${parseWav(wav).pcm.length} bytes`),
  };
  const tts = {
    describe:   vi.fn(async () => ({ provider: 'internal', model: 'piper', voice: 'it_IT-paola-medium', voices: ['it_IT-paola-medium', 'en_US-amy-low'], enabled: opts.ttsEnabled ?? true })),
    synthesize: vi.fn(async (text: string) => pcmToWav(Buffer.alloc(text.length * 100, 3), { rate: 22050, width: 2, channels: 1 })),
  };
  const env = { get: (k: string, d?: string) => (k === 'WYOMING_PORT' ? '0' : k === 'WYOMING_BIND' ? '127.0.0.1' : d) };
  // ModuleRef stand-in: the service resolves the conversation dependencies lazily by class token.
  const voiceDelivery = { deliver: vi.fn(async () => 'assist_satellite.soggiorno') };
  const notifications = { create: vi.fn(async () => ({ id: 'n-1' })) };
  const gateway = { emitToUser: vi.fn() };
  // The chats' runs: a detached turn's work registered there (stoppable); `stop()` stops the last one started.
  const controllers: AbortController[] = [];
  const chatRuns = {
    start: vi.fn(() => { const c = new AbortController(); controllers.push(c); return { runId: `run-${controllers.length}`, signal: c.signal }; }),
    update: vi.fn(), toolDone: vi.fn(), finish: vi.fn(),
    stop: () => controllers.at(-1)?.abort(),
  };
  const moduleRef = { get: (token: any) => ({ ChatRunsService: opts.noRuns ? undefined : chatRuns, VoiceDeliveryService: voiceDelivery, NotificationsService: notifications, NotificationsGateway: gateway, AgentService: agentService, AgentsService: agentsService, UsersService: usersService, InvocationsService: invocations, ConversationFocusService: focus, ExternalChatsService: externalChats, VoiceIdService: opts.voiceId, HomeAssistantService: homeAssistant, RecordareInitiativesService: opts.initiatives } as any)[token.name] };
  const svc = new WyomingService(appConfig as any, transcription as any, tts as any, env as any, moduleRef as any);
  return { clearances, svc, appConfig, transcription, tts, agentService, agentsService, usersService, invocations, focus, externalChats, voiceDelivery, notifications, gateway, chatRuns };
}

/** Sends events on a fresh connection and collects the replies until the socket idles. */
function exchange(port: number, events: WyomingEvent[], idleMs = 150): Promise<WyomingEvent[]> {
  return new Promise((resolve) => {
    const out: WyomingEvent[] = [];
    const dec = new WyomingDecoder();
    const sock = net.connect(port, '127.0.0.1');
    let timer: NodeJS.Timeout;
    const done = () => { sock.destroy(); resolve(out); };
    sock.on('connect', () => { for (const ev of events) sock.write(encodeEvent(ev)); timer = setTimeout(done, idleMs); });
    sock.on('data', (b) => { dec.feed(b); let ev; while ((ev = dec.next())) out.push(ev); clearTimeout(timer); timer = setTimeout(done, idleMs); });
    sock.on('error', () => { clearTimeout(timer); resolve(out); });   // a rejected client sees ECONNRESET: that is the outcome under test
    sock.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

describe('WyomingService', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(async () => { ctx = makeService(); await ctx.svc.applyConfig(); });
  afterEach(async () => { await ctx.svc.onModuleDestroy(); });

  it('starts when enabled and reports a live status', () => {
    const st = ctx.svc.getStatus();
    expect(st.running).toBe(true);
    expect(st.port).toBeGreaterThan(0);
  });

  it('answers describe with asr + tts programs built from the configured providers', async () => {
    const [info] = await exchange(ctx.svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(info.type).toBe('info');
    expect(info.data.asr[0].models[0].name).toBe('faster-whisper-base');
    expect(info.data.asr[0].models[0].languages).toContain('it');
    const voices = info.data.tts[0].voices.map((v: any) => v.name);
    expect(voices).toEqual(['it_IT-paola-medium', 'en_US-amy-low']);
    expect(info.data.tts[0].voices[0].languages).toEqual(['it', 'it-IT']);
    expect(info.data.handle).toEqual([]);   // no conversation user configured → STT/TTS only
    expect(ctx.svc.getStatus().handle).toBeNull();
  });

  it('transcribes the buffered PCM stream and returns a transcript', async () => {
    const fmt = { rate: 16000, width: 2, channels: 1 };
    const replies = await exchange(ctx.svc.getStatus().port, [
      { type: 'transcribe', data: { language: 'it' } },
      { type: 'audio-start', data: fmt },
      { type: 'audio-chunk', data: fmt, payload: Buffer.alloc(3200, 1) },
      { type: 'audio-chunk', data: fmt, payload: Buffer.alloc(1600, 2) },
      { type: 'audio-stop', data: {} },
    ]);
    expect(replies).toEqual([{ type: 'transcript', data: { text: 'heard 4800 bytes', language: 'it' }, payload: undefined }]);
    expect(ctx.transcription.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio.wav', 'it', expect.any(Object));
  });

  it('synthesizes text into audio-start / audio-chunk* / audio-stop with the WAV format', async () => {
    const replies = await exchange(ctx.svc.getStatus().port, [
      { type: 'synthesize', data: { text: 'ciao mondo', voice: { name: 'it_IT-paola-medium' } } },
    ]);
    expect(replies[0].type).toBe('audio-start');
    expect(replies[0].data).toMatchObject({ rate: 22050, width: 2, channels: 1 });
    expect(replies.at(-1)!.type).toBe('audio-stop');
    const chunks = replies.filter((r) => r.type === 'audio-chunk');
    expect(Buffer.concat(chunks.map((c) => c.payload!)).length).toBe(1000);
    expect(ctx.tts.synthesize).toHaveBeenCalledWith('ciao mondo', 'it_IT-paola-medium', 'wav');
  });

  it('replies to ping with pong', async () => {
    const [pong] = await exchange(ctx.svc.getStatus().port, [{ type: 'ping', data: { text: 'x' } }]);
    expect(pong).toEqual({ type: 'pong', data: { text: 'x' }, payload: undefined });
  });

  it('reports provider failures as a Wyoming error event instead of dropping the socket', async () => {
    ctx.tts.synthesize.mockRejectedValueOnce(new Error('piper down'));
    const [err] = await exchange(ctx.svc.getStatus().port, [{ type: 'synthesize', data: { text: 'x' } }]);
    expect(err.type).toBe('error');
    expect(err.data.text).toMatch(/piper down/);
  });
});

describe('WyomingService — access control and toggle', () => {
  it('drops connections outside the allowlist', async () => {
    const { svc } = makeService({ cidrs: '10.99.0.0/16' });   // 127.0.0.1 is not in it
    await svc.applyConfig();
    const replies = await exchange(svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(replies).toEqual([]);
    await svc.onModuleDestroy();
  });

  it('accepts connections matching the allowlist', async () => {
    const { svc } = makeService({ cidrs: '10.99.0.0/16, 127.0.0.1' });
    await svc.applyConfig();
    const [info] = await exchange(svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(info.type).toBe('info');
    await svc.onModuleDestroy();
  });

  it('omits the asr program when transcription is disabled by the admin', async () => {
    const { svc } = makeService({ sttEnabled: false });
    await svc.applyConfig();
    const [info] = await exchange(svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(info.data.asr).toEqual([]);
    expect(info.data.tts.length).toBe(1);
    await svc.onModuleDestroy();
  });

  it('omits the tts program when speech synthesis is disabled or unavailable', async () => {
    const { svc } = makeService({ ttsEnabled: false });
    await svc.applyConfig();
    const [info] = await exchange(svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(info.data.tts).toEqual([]);
    expect(info.data.asr.length).toBe(1);
    await svc.onModuleDestroy();
  });

  it('stays down when disabled and starts/stops on applyConfig()', async () => {
    const { svc, appConfig } = makeService({ enabled: false });
    await svc.applyConfig();
    expect(svc.getStatus().running).toBe(false);
    appConfig.getWyomingConfig.mockResolvedValueOnce({ wyomingEnabled: true, wyomingAllowedCidrs: null });
    await svc.applyConfig();
    expect(svc.getStatus().running).toBe(true);
    appConfig.getWyomingConfig.mockResolvedValueOnce({ wyomingEnabled: false, wyomingAllowedCidrs: null });
    await svc.applyConfig();
    expect(svc.getStatus().running).toBe(false);
  });
});

describe('expectsReply', () => {
  it('is true for an answer ending with a question, also closed by quotes, brackets or emphasis', () => {
    for (const answer of ['In quale stanza?', 'Vuoi che la accenda? ', 'Ti dico "quale?"', 'Quale (cucina o sala?)', 'Davvero?**']) {
      expect(expectsReply(answer)).toBe(true);
    }
  });
  it('is false for statements and questions in the middle', () => {
    for (const answer of ['Fatto.', 'Luce accesa', '', 'Chi era? Era Mario.']) {
      expect(expectsReply(answer)).toBe(false);
    }
  });
});

describe('spokenFailure', () => {
  it('speaks the turn language, Italian or else English, and never the error', () => {
    expect(spokenFailure('it')).toMatch(/^Scusa/);
    expect(spokenFailure('it-IT')).toMatch(/^Scusa/);
    expect(spokenFailure('en')).toMatch(/^Sorry/);
    expect(spokenFailure(undefined)).toMatch(/^Sorry/);
  });
});

describe('WyomingService — conversation (handle program)', () => {
  it('advertises the handle program with the agent slug when a user + agent are configured', async () => {
    const { svc } = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await svc.applyConfig();
    const [info] = await exchange(svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(info.data.handle[0].models[0].name).toBe('voce-casa');
    expect(info.data.handle[0].models[0].languages).toContain('it');
    expect(svc.getStatus().handle).toEqual({ userEmail: 'voice@internal.com', agentName: 'Voce Casa', model: 'voce-casa' });
    await svc.onModuleDestroy();
  });

  it('asks the hub to keep listening when the answer is a question', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    ctx.agentService.streamResponse.mockImplementationOnce(async (...args: any[]) => { args[8]('In quale stanza?'); return null; });
    const [handled] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'accendi la luce', context: { conversation_id: 'conv-q' } } }]);
    expect(handled).toMatchObject({ type: 'handled', data: { text: 'In quale stanza?', continue_conversation: true } });
    await ctx.svc.onModuleDestroy();
  });

  it('runs the agent as the configured user with its overrides and answers with handled', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    const context = { conversation_id: 'conv-1', device_id: 'dev-1' };
    const [handled] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'accendi la luce', language: 'it', context } }]);
    expect(handled.type).toBe('handled');
    expect(handled.data.text).toBe('risposta a "accendi la luce" (history=0)');
    expect(handled.data.context).toEqual(context);
    expect(handled.data.continue_conversation).toBe(false);
    const call = ctx.agentService.streamResponse.mock.calls[0];
    expect(call[1]).toBe(VOICE_USER);
    expect(call[12]).toMatchObject({ origin: 'voice', agentPromptOverride: 'Rispondi in una frase.', toolOverride: { mode: 'names' }, maxIterations: 7 });
    expect(ctx.invocations.record).toHaveBeenCalledWith(expect.objectContaining({
      userId: VOICE_USER, origin: 'voice', route: 'chat', model: 'wyoming:voce-casa', status: 'ok', inputTokens: 10,
      toolCalls: [expect.objectContaining({ name: 'mcp_home_assistant_GetLiveContext', ok: true })],
    }));
    await ctx.svc.onModuleDestroy();
  });

  it('keeps multi-turn context per conversation_id and isolates other conversations', async () => {
    const ctx = makeService({ handleUser: VOICE_USER });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    await exchange(port, [{ type: 'transcript', data: { text: 'primo', context: { conversation_id: 'A' } } }]);
    const [second] = await exchange(port, [{ type: 'transcript', data: { text: 'secondo', context: { conversation_id: 'A' } } }]);
    const [other]  = await exchange(port, [{ type: 'transcript', data: { text: 'altro', context: { conversation_id: 'B' } } }]);
    expect(second.data.text).toContain('history=2');
    expect(other.data.text).toContain('history=0');
    // The first answer's tool calls come back with it (replayed: a "yes" can confirm what a tool prepared).
    const replayed = ctx.agentService.streamResponse.mock.calls[1][4];
    expect(replayed[1]).toMatchObject({ role: 'assistant', id: expect.any(String), toolCalls: [expect.objectContaining({ name: 'mcp_home_assistant_GetLiveContext' })] });
    // Standard pipeline (no agent): the origin, and the conversation for the memory
    expect(ctx.agentService.streamResponse.mock.calls[0][12]).toEqual({ origin: 'voice', conversationId: 'wyoming:A', onProgress: expect.any(Function) });
    await ctx.svc.onModuleDestroy();
  });

  it('runs a focused satellite inside its chat, and starts fresh once the focus ends', async () => {
    const ctx = makeService({ handleUser: VOICE_USER });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    const living = { conversation_id: 'A', satellite_id: 'assist_satellite.living' };
    const heard: unknown[] = [];
    ctx.focus.setVoiceTurnListener((turn) => heard.push(turn));
    await exchange(port, [{ type: 'transcript', data: { text: 'primo', context: living } }]);
    // The satellite spoken to is told after the answer (Home Assistant places it: its room's presence).
    expect(heard).toEqual([{ userId: VOICE_USER, satelliteId: 'assist_satellite.living', deviceId: null }]);
    ctx.focus.set(VOICE_USER, 'assist_satellite.living', 'chat-1');
    const [focused] = await exchange(port, [{ type: 'transcript', data: { text: 'continua', context: living } }]);
    expect(focused.data.text).toContain('history=4');   // the chat's history, not the window's
    expect(ctx.externalChats.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: VOICE_USER, satellite: 'assist_satellite.living', chatId: 'chat-1', userText: 'continua',
    }));
    // Another satellite in the same hub conversation is not focused.
    const [kitchen] = await exchange(port, [{ type: 'transcript', data: { text: 'cucina', context: { conversation_id: 'K', satellite_id: 'assist_satellite.kitchen' } } }]);
    expect(kitchen.data.text).toContain('history=0');
    // Focus ended: the hub's conversation A does not continue its earlier window.
    ctx.focus.clear(VOICE_USER, 'assist_satellite.living', Date.now() + 1);
    const [after] = await exchange(port, [{ type: 'transcript', data: { text: 'nuova', context: living } }]);
    expect(after.data.text).toContain('history=0');
    await ctx.svc.onModuleDestroy();
  });

  it('answers not-handled when no conversation user is configured or the agent fails', async () => {
    const none = makeService();
    await none.svc.applyConfig();
    const [nh] = await exchange(none.svc.getStatus().port, [{ type: 'transcript', data: { text: 'ciao' } }]);
    expect(nh.type).toBe('not-handled');
    await none.svc.onModuleDestroy();

    const ctx = makeService({ handleUser: VOICE_USER });
    await ctx.svc.applyConfig();
    ctx.agentService.streamResponse.mockRejectedValueOnce(new Error('llm down'));
    const [err] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'ciao', language: 'it' } }]);
    // The satellite says a sentence for people; the error stays in the invocation record.
    expect(err).toMatchObject({ type: 'not-handled', data: { text: spokenFailure('it') } });
    expect(err.data.text).not.toContain('llm down');
    expect(ctx.invocations.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: 'llm down' }));
    await ctx.svc.onModuleDestroy();
  });

  it('disables the handle program (but keeps STT/TTS) when the configured user or agent is gone', async () => {
    const ctx = makeService({ handleUser: 'c3c3c3c3-0000-4000-8000-000000000003', handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    const [info] = await exchange(ctx.svc.getStatus().port, [{ type: 'describe', data: {} }]);
    expect(info.data.handle).toEqual([]);
    expect(info.data.asr.length).toBe(1);
    await ctx.svc.onModuleDestroy();

    const fallback = makeService({ handleUser: VOICE_USER, handleAgent: 'd4d4d4d4-0000-4000-8000-000000000004' });
    await fallback.svc.applyConfig();
    expect(fallback.svc.getStatus().handle).toEqual({ userEmail: 'voice@internal.com', agentName: null, model: 'arkimede' });
    await fallback.svc.onModuleDestroy();
  });

  it('runs a turn as the account its satellite is assigned to, with that user\'s voice agent; the rest as the default account', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, satellites: { 'assist_satellite.study': OTHER_USER } });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    await exchange(port, [{ type: 'transcript', data: { text: 'studio', context: { conversation_id: 'S', satellite_id: 'assist_satellite.study' } } }]);
    await exchange(port, [{ type: 'transcript', data: { text: 'sala', context: { conversation_id: 'L', satellite_id: 'assist_satellite.living' } } }]);
    const [study, living] = ctx.agentService.streamResponse.mock.calls;
    expect(study[1]).toBe(OTHER_USER);
    expect(study[12]).toEqual({ origin: 'voice', conversationId: 'wyoming:S', onProgress: expect.any(Function) });     // no voice agent: the standard pipeline
    expect(living[1]).toBe(VOICE_USER);
    expect(living[12]).toMatchObject({ agentPromptOverride: 'Rispondi in una frase.' });
    expect(ctx.invocations.record).toHaveBeenCalledWith(expect.objectContaining({ userId: OTHER_USER, model: 'wyoming:arkimede' }));
    // The advertised model stays the default account's.
    expect(ctx.svc.getStatus().handle?.model).toBe('voce-casa');
    await ctx.svc.onModuleDestroy();
  });

  it('does not handle a turn whose account is not active', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, satellites: { 'assist_satellite.gone': 'c3c3c3c3-0000-4000-8000-000000000003' } });
    await ctx.svc.applyConfig();
    const [nh] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'ciao', language: 'it', context: { satellite_id: 'assist_satellite.gone' } } }]);
    expect(nh).toMatchObject({ type: 'not-handled', data: { text: spokenFailure('it') } });
    expect(ctx.agentService.streamResponse).not.toHaveBeenCalled();
    await ctx.svc.onModuleDestroy();
  });
});

describe('WyomingService — who is speaking (voice recognition)', () => {
  const fmt = { rate: 16000, width: 2, channels: 1 };
  const audio = (language = 'it'): WyomingEvent[] => [
    { type: 'transcribe', data: { language } }, { type: 'audio-start', data: fmt },
    { type: 'audio-chunk', data: fmt, payload: Buffer.alloc(32000, 1) }, { type: 'audio-stop', data: {} },
  ];

  it('voiceprints the audio alongside the transcription, tells the agent and the memory who speaks, before the run', async () => {
    const speaker = { holder: false, identity: { channel: 'voice', externalId: 'v-alex' }, displayName: 'Alex', profileId: 'v-alex', userId: null, confidence: 0.8, score: 0.7 };
    const voiceId = {
      active: vi.fn(async () => true),
      embed: vi.fn(async () => [0.1, 0.2]),
      remember: vi.fn(),
      forTurn: vi.fn(async () => ({ kind: 'speaker', speaker })),
    };
    const ctx = makeService({ handleUser: VOICE_USER, persist: true, voiceId });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    const [transcript] = await exchange(port, audio());
    expect(voiceId.embed).toHaveBeenCalledWith(expect.any(Buffer));
    expect(voiceId.remember).toHaveBeenCalledWith(transcript.data.text, expect.any(Promise));
    const heard: any[] = [];
    ctx.focus.setVoiceTurnListener((t) => heard.push(t));
    const context = { conversation_id: 'A', satellite_id: 'assist_satellite.living' };
    await exchange(port, [{ type: 'transcript', data: { text: transcript.data.text, context } }]);
    expect(voiceId.forTurn).toHaveBeenCalledWith(transcript.data.text, 'assist_satellite.living', VOICE_USER);
    // The user's message with its speaker is saved before the run, and the run's memory conversation is that chat.
    expect(ctx.externalChats.recordUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: VOICE_USER, satellite: 'assist_satellite.living', speaker: { channel: 'voice', externalId: 'v-alex', displayName: 'Alex' },
    }));
    const opts = ctx.agentService.streamResponse.mock.calls[0][12];
    expect(opts.conversationId).toBe('chat-9');
    expect(opts.turnBlocks[0]).toContain('The person speaking is Alex');
    expect(ctx.externalChats.recordAnswer).toHaveBeenCalledWith('chat-9', expect.objectContaining({ answer: expect.stringContaining('risposta') }));
    expect(ctx.externalChats.recordTurn).not.toHaveBeenCalled();
    // The run sees who spoke (voice clearance): the actions only a recognised voice may do.
    expect(ctx.clearances[0]).toEqual({ speaker: { profileId: 'v-alex', name: 'Alex', score: 0.7 }, satellite: 'assist_satellite.living' });
    // The presence of the turn carries who spoke.
    expect(heard[0]).toMatchObject({ satelliteId: 'assist_satellite.living', speaker: { identity: { channel: 'voice', externalId: 'v-alex' }, confidence: 0.8 } });
    await ctx.svc.onModuleDestroy();
  });

  it('off (or nobody recognised): no voiceprint, the turn as before', async () => {
    const voiceId = { active: vi.fn(async () => false), embed: vi.fn(), remember: vi.fn(), forTurn: vi.fn(async () => ({ kind: 'unknown' })) };
    const ctx = makeService({ handleUser: VOICE_USER, persist: true, voiceId });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    await exchange(port, audio());
    expect(voiceId.embed).not.toHaveBeenCalled();
    await exchange(port, [{ type: 'transcript', data: { text: 'ciao', context: { conversation_id: 'A' } } }]);
    expect(ctx.agentService.streamResponse.mock.calls[0][12]).toEqual({ origin: 'voice', conversationId: 'wyoming:A', onProgress: expect.any(Function) });
    expect(ctx.clearances[0]).toEqual({ speaker: null, satellite: null });
    expect(ctx.externalChats.recordUserMessage).not.toHaveBeenCalled();
    expect(ctx.externalChats.recordTurn).toHaveBeenCalled();
    await ctx.svc.onModuleDestroy();
  });

  it('a person recognised on a satellite that is not theirs: the turn to their own memory too (sharedTurn decides)', async () => {
    const speaker = { holder: false, identity: { channel: 'voice', externalId: 'v-sam' }, displayName: 'Sam', profileId: 'v-sam', userId: OTHER_USER, confidence: 0.8, score: 0.7 };
    const voiceId = { active: vi.fn(async () => false), embed: vi.fn(), remember: vi.fn(), forTurn: vi.fn(async () => ({ kind: 'speaker', speaker })) };
    const initiatives = { sharedTurn: vi.fn(async () => true) };
    const ctx = makeService({ handleUser: VOICE_USER, voiceId, initiatives });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    await exchange(port, [{ type: 'transcript', data: { text: 'che tempo fa', context: { conversation_id: 'A', satellite_id: 'assist_satellite.living' } } }]);
    expect(initiatives.sharedTurn).toHaveBeenCalledWith(OTHER_USER, { conversation: 'wyoming:A', text: 'che tempo fa', answer: expect.stringContaining('risposta') });
    // On their own satellite the turn is already theirs: nothing more.
    initiatives.sharedTurn.mockClear();
    speaker.userId = VOICE_USER;
    await exchange(port, [{ type: 'transcript', data: { text: 'ancora', context: { conversation_id: 'A', satellite_id: 'assist_satellite.living' } } }]);
    expect(initiatives.sharedTurn).not.toHaveBeenCalled();
    await ctx.svc.onModuleDestroy();
  });

  it('voiceBlocks: who speaks (the holder named as the account\'s own user), a voice being learned, nothing when unknown', () => {
    expect(voiceBlocks({ kind: 'unknown' })).toEqual([]);
    expect(voiceBlocks({ kind: 'rejected', profileId: 'p', name: 'Sam', rejection: { reason: 'other', name: 'Alex', score: 0.7 }, left: 3 })[0])
      .toMatch(/not taken \(it sounded like Alex's voice\); 3 still to go/);
    // An entity's account (the assistant's own identity): an unknown voice is never called by the account's name.
    expect(voiceBlocks({ kind: 'unknown' }, true)[0]).toContain("never call them by the account's name");
    expect(voiceBlocks({ kind: 'speaker', speaker: { holder: false, identity: null, displayName: 'Sam', profileId: 'p', userId: null, confidence: 0.8, score: 0.7 } }, true)[0]).toContain('The person speaking is Sam');
    expect(voiceBlocks({ kind: 'speaker', speaker: { holder: true, identity: null, displayName: 'Sam', profileId: 'p', userId: null, confidence: 0.8, score: 0.7 } })[0]).toContain("Sam (the account's own user)");
    expect(voiceBlocks({ kind: 'enrolled', profileId: 'p', name: 'Sam', samples: 5, of: 5 })[0]).toContain('done, from now on you recognise it');
  });
});

describe('WyomingService — a long turn is detached', () => {
  const previous = process.env.WYOMING_DETACH_MS;
  beforeEach(() => { process.env.WYOMING_DETACH_MS = '60'; });
  afterEach(() => { if (previous === undefined) delete process.env.WYOMING_DETACH_MS; else process.env.WYOMING_DETACH_MS = previous; });
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20)); };

  it('the hub hears the work goes on and hangs up; the run is not cancelled, its answer is saved, said and notified', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, runMs: 300 });
    await ctx.svc.applyConfig();
    const context = { conversation_id: 'conv-9', satellite_id: 'assist_satellite.soggiorno' };
    const replies = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'costruisci una scacchiera', language: 'it', context } }], 100);
    expect(replies).toEqual([expect.objectContaining({ type: 'handled', data: expect.objectContaining({ text: workingOn('it'), continue_conversation: false }) })]);
    await until(() => ctx.notifications.create.mock.calls.length > 0);
    const answer = 'risposta a "costruisci una scacchiera" (history=0)';
    // Its chat at the detach (persistence off too: the answer is delivered from it), the work registered there.
    expect(ctx.externalChats.recordUserMessage).toHaveBeenCalledWith(expect.objectContaining({ userText: 'costruisci una scacchiera' }));
    expect(ctx.chatRuns.start).toHaveBeenCalledWith('chat-9');
    expect(ctx.externalChats.recordAnswer).toHaveBeenCalledWith('chat-9', expect.objectContaining({ answer }));
    expect(ctx.chatRuns.toolDone).toHaveBeenCalledWith('chat-9', 'run-1', expect.objectContaining({ tool: 'mcp_home_assistant_GetLiveContext', ok: true }));
    expect(ctx.chatRuns.finish).toHaveBeenCalledWith('chat-9', 'run-1', null);
    expect(ctx.voiceDelivery.deliver).toHaveBeenCalledWith(VOICE_USER, answer, 'chat-9');
    expect(ctx.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: VOICE_USER, eventType: 'voice_work_done', payload: expect.objectContaining({ chatId: 'chat-9', message: answer, spoken: true }),
    }));
    expect(ctx.gateway.emitToUser).toHaveBeenCalledWith(VOICE_USER, 'notification', expect.objectContaining({ eventType: 'voice_work_done' }));
    expect(ctx.invocations.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', outputPreview: answer }));
    await ctx.svc.onModuleDestroy();
  });

  it('a detached run that fails: the failure is said and written in the chat, never the error', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, runMs: 200, runFails: true });
    await ctx.svc.applyConfig();
    await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'scrivi un gioco enorme', language: 'it', context: { conversation_id: 'c' } } }], 100);
    await until(() => ctx.voiceDelivery.deliver.mock.calls.length > 0);
    expect(ctx.voiceDelivery.deliver).toHaveBeenCalledWith(VOICE_USER, spokenFailure('it'), 'chat-9');
    expect(ctx.externalChats.recordAnswer).toHaveBeenCalledWith('chat-9', expect.objectContaining({ answer: spokenFailure('it') }));
    expect(ctx.chatRuns.finish).toHaveBeenCalledWith('chat-9', 'run-1', null);
    expect(ctx.invocations.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: 'Recursion limit of 101 reached' }));
    await ctx.svc.onModuleDestroy();
  });

  it('stopped from its chat: the work ends, the satellite says it stopped, the chat keeps it', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, runMs: 400 });
    await ctx.svc.applyConfig();
    await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'scrivi un gioco', language: 'it', context: { conversation_id: 'c' } } }], 100);
    await until(() => ctx.chatRuns.start.mock.calls.length > 0);
    ctx.chatRuns.stop();
    await until(() => ctx.voiceDelivery.deliver.mock.calls.length > 0);
    expect(ctx.voiceDelivery.deliver).toHaveBeenCalledWith(VOICE_USER, stoppedWork('it'), 'chat-9');
    expect(ctx.externalChats.recordAnswer).toHaveBeenCalledWith('chat-9', expect.objectContaining({ answer: stoppedWork('it') }));
    expect(ctx.chatRuns.finish).toHaveBeenCalledWith('chat-9', 'run-1', null);
    await ctx.svc.onModuleDestroy();
  });

  it('without the chats\' runs (another app) a detached turn still ends and is delivered', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, runMs: 200, noRuns: true });
    await ctx.svc.applyConfig();
    await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'costruisci', language: 'it', context: { conversation_id: 'c' } } }], 100);
    await until(() => ctx.voiceDelivery.deliver.mock.calls.length > 0);
    expect(ctx.voiceDelivery.deliver).toHaveBeenCalledWith(VOICE_USER, expect.stringContaining('risposta a'), 'chat-9');
    await ctx.svc.onModuleDestroy();
  });

  it('its answer waits while another turn is going on (an announcement would cut it), then is said', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, runMs: 150 });
    await ctx.svc.applyConfig();
    (ctx.svc as any).turnsInProgress = 1;   // another turn waiting for its answer on the satellite
    await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'costruisci', language: 'it', context: { conversation_id: 'c' } } }], 100);
    await new Promise((r) => setTimeout(r, 600));
    expect(ctx.voiceDelivery.deliver).not.toHaveBeenCalled();
    (ctx.svc as any).turnsInProgress -= 1;   // that turn answered
    await until(() => ctx.voiceDelivery.deliver.mock.calls.length > 0);
    expect((ctx.svc as any).turnsInProgress).toBe(0);   // the detached turn counted itself out at the detach
    await ctx.svc.onModuleDestroy();
  });

  it('a sentence being played holds an announcement for as long as its synthesis lasts', async () => {
    const ctx = makeService({ handleUser: VOICE_USER });
    await ctx.svc.applyConfig();
    await exchange(ctx.svc.getStatus().port, [{ type: 'synthesize', data: { text: 'x'.repeat(10) } }]);
    // 1000 bytes of 22050 Hz 16-bit mono ≈ 23 ms, plus the tail: quiet within a few seconds, not at once
    const t0 = Date.now();
    const waited = await ctx.svc.quiet(5000, 50);
    expect(waited).toBeGreaterThan(1000);
    expect(Date.now() - t0).toBeLessThan(4000);
    await ctx.svc.onModuleDestroy();
  });

  it('a turn that ends in time is answered as before, nothing delivered later', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT, runMs: 5 });
    await ctx.svc.applyConfig();
    const [handled] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'che ore sono', language: 'it', context: { conversation_id: 'c' } } }]);
    expect(handled.data.text).toBe('risposta a "che ore sono" (history=0)');
    expect(ctx.voiceDelivery.deliver).not.toHaveBeenCalled();
    expect(ctx.notifications.create).not.toHaveBeenCalled();
    expect(ctx.externalChats.recordTurn).not.toHaveBeenCalled();   // persistence off, as before
    expect(ctx.chatRuns.start).not.toHaveBeenCalled();
    await ctx.svc.onModuleDestroy();
  });

  it('workingOn speaks the turn language', () => {
    expect(workingOn('it-IT')).toMatch(/^Ci sto lavorando/);
    expect(workingOn('en')).toMatch(/^I'm working on it/);
    expect(workingOn()).toMatch(/^I'm working on it/);
  });
});

describe('WyomingService — a command longer than the hub lets it be', () => {
  const fmt = { rate: 16000, width: 2, channels: 1 };
  // seconds of PCM in one chunk: 15 s is Home Assistant's command limit
  const speech = (seconds: number): WyomingEvent[] => [
    { type: 'transcribe', data: { language: 'it' } },
    { type: 'audio-start', data: fmt },
    { type: 'audio-chunk', data: fmt, payload: Buffer.alloc(Math.round(seconds * 32000), 1) },
    { type: 'audio-stop', data: {} },
  ];
  const turn = (text: string): WyomingEvent => ({ type: 'transcript', data: { text, language: 'it', context: { conversation_id: 'conv-long' } } });

  it('a transcription cut at the limit waits for the rest: "go on", listening again, then one request', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    const [stt] = await exchange(port, speech(15));
    expect(stt.data.text).toBe('heard 480000 bytes');
    const [wait] = await exchange(port, [turn('heard 480000 bytes')]);
    expect(wait).toMatchObject({ type: 'handled', data: { text: keepTalking('it'), continue_conversation: true } });
    expect(ctx.agentService.streamResponse).not.toHaveBeenCalled();
    const [answer] = await exchange(port, [turn('e quattro nemici')]);
    expect(answer.type).toBe('handled');
    expect(ctx.agentService.streamResponse).toHaveBeenCalledTimes(1);
    expect(ctx.agentService.streamResponse.mock.calls[0][0]).toBe('heard 480000 bytes e quattro nemici');
    await ctx.svc.onModuleDestroy();
  });

  it('cut twice: the three parts make one request', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    await exchange(port, speech(15));
    await exchange(port, [turn('heard 480000 bytes')]);
    await exchange(port, speech(14.9));
    const [wait] = await exchange(port, [turn('heard 476800 bytes')]);
    expect(wait.data.text).toBe(keepTalking('it'));
    await exchange(port, [turn('fine')]);
    expect(ctx.agentService.streamResponse.mock.calls.map((c: any[]) => c[0])).toEqual(['heard 480000 bytes heard 476800 bytes fine']);
    await ctx.svc.onModuleDestroy();
  });

  it('a shorter command runs at once, as before', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    const port = ctx.svc.getStatus().port;
    await exchange(port, speech(6));
    const [answer] = await exchange(port, [turn('heard 192000 bytes')]);
    expect(answer.data.text).toBe('risposta a "heard 192000 bytes" (history=0)');
    await ctx.svc.onModuleDestroy();
  });

  it('keepTalking speaks the turn language', () => {
    expect(keepTalking('it')).toBe('Continua, ti ascolto.');
    expect(keepTalking('en')).toMatch(/^Go on/);
  });
});
