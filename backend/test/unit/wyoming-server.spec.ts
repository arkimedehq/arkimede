// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Wyoming voice server end-to-end over a real TCP socket, with the providers
 * stubbed: capability advertisement (`describe` → `info` built from the
 * configured STT/TTS), the STT flow (audio-start/chunk/stop → transcript with
 * the buffered PCM wrapped as WAV), the TTS flow (synthesize → PCM chunks
 * with the WAV's real format), the client allowlist and the runtime toggle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { WyomingService } from '../../src/wyoming/wyoming.service';
import { WyomingDecoder, WyomingEvent, encodeEvent, parseWav, pcmToWav } from '../../src/wyoming/wyoming.protocol';

const VOICE_USER = 'a1a1a1a1-0000-4000-8000-000000000001';
const VOICE_AGENT = 'b2b2b2b2-0000-4000-8000-000000000002';

function makeService(opts: { enabled?: boolean; cidrs?: string | null; sttEnabled?: boolean; handleUser?: string | null; handleAgent?: string | null } = {}) {
  const appConfig = {
    getWyomingConfig: vi.fn(async () => ({
      wyomingEnabled: opts.enabled ?? true, wyomingAllowedCidrs: opts.cidrs ?? null,
      wyomingHandleUserId: opts.handleUser ?? null, wyomingHandleAgentId: opts.handleAgent ?? null,
    })),
  };
  const agent = { id: VOICE_AGENT, name: 'Voce Casa', systemPrompt: 'Rispondi in una frase.', toolFilter: { mode: 'names', names: ['mcp_home_assistant_*'] }, maxIterations: 3, llmConfigId: null };
  const agentService = {
    // Echoes the input plus how many history messages it received; emits one tool event.
    streamResponse: vi.fn(async (input: string, _userId: string, _p: any, _c: any, history: any[], _a: any, _i: any, _b: any, onChunk: (s: string) => void, onToolCall: any, _signal: any, onToolResult: any) => {
      onToolCall({ name: 'mcp_home_assistant_GetLiveContext', input: {} });
      onToolResult('mcp_home_assistant_GetLiveContext', 'ok', 'success', {});
      onChunk(`risposta a "${input}" (history=${history.length})`);
      return { inputTokens: 10, outputTokens: 5 };
    }),
  };
  const agentsService = {
    findAll:  vi.fn(async (userId: string) => (userId === VOICE_USER ? [agent] : [])),
    findById: vi.fn(async (id: string) => { if (id !== VOICE_AGENT) throw new Error('not found'); return agent; }),
  };
  const usersService = {
    getById: vi.fn(async (id: string) => { if (id !== VOICE_USER) throw new Error("not found"); return { id, email: "voice@internal.com", status: "active" }; }),
  };
  const invocations = { record: vi.fn(async () => undefined) };
  const transcription = {
    describe:   vi.fn(async () => ({ provider: 'internal', model: 'faster-whisper-base', enabled: opts.sttEnabled ?? true })),
    transcribe: vi.fn(async (wav: Buffer) => `heard ${parseWav(wav).pcm.length} bytes`),
  };
  const tts = {
    describe:   vi.fn(async () => ({ provider: 'internal', model: 'piper', voice: 'it_IT-paola-medium', voices: ['it_IT-paola-medium', 'en_US-amy-low'] })),
    synthesize: vi.fn(async (text: string) => pcmToWav(Buffer.alloc(text.length * 100, 3), { rate: 22050, width: 2, channels: 1 })),
  };
  const env = { get: (k: string, d?: string) => (k === 'WYOMING_PORT' ? '0' : k === 'WYOMING_BIND' ? '127.0.0.1' : d) };
  // ModuleRef stand-in: the service resolves the conversation dependencies lazily by class token.
  const moduleRef = { get: (token: any) => ({ AgentService: agentService, AgentsService: agentsService, UsersService: usersService, InvocationsService: invocations } as any)[token.name] };
  const svc = new WyomingService(appConfig as any, transcription as any, tts as any, env as any, moduleRef as any);
  return { svc, appConfig, transcription, tts, agentService, agentsService, usersService, invocations };
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
    expect(ctx.transcription.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio.wav', 'it');
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

  it('runs the agent as the configured user with its overrides and answers with handled', async () => {
    const ctx = makeService({ handleUser: VOICE_USER, handleAgent: VOICE_AGENT });
    await ctx.svc.applyConfig();
    const context = { conversation_id: 'conv-1', device_id: 'dev-1' };
    const [handled] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'accendi la luce', language: 'it', context } }]);
    expect(handled.type).toBe('handled');
    expect(handled.data.text).toBe('risposta a "accendi la luce" (history=0)');
    expect(handled.data.context).toEqual(context);
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
    // Standard pipeline (no agent): only the origin override is passed
    expect(ctx.agentService.streamResponse.mock.calls[0][12]).toEqual({ origin: 'voice' });
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
    const [err] = await exchange(ctx.svc.getStatus().port, [{ type: 'transcript', data: { text: 'ciao' } }]);
    expect(err).toMatchObject({ type: 'not-handled', data: { text: 'llm down' } });
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

  it('validateHandleConfig rejects unknown users and agents not visible to the user', async () => {
    const { svc } = makeService();
    await expect(svc.validateHandleConfig('c3c3c3c3-0000-4000-8000-000000000003', null)).rejects.toThrow('wyoming.handleUserInvalid');
    await expect(svc.validateHandleConfig(VOICE_USER, 'd4d4d4d4-0000-4000-8000-000000000004')).rejects.toThrow('wyoming.handleAgentInvalid');
    await expect(svc.validateHandleConfig(VOICE_USER, VOICE_AGENT)).resolves.toBeUndefined();
    await expect(svc.validateHandleConfig(null, VOICE_AGENT)).resolves.toBeUndefined();
    expect(await svc.listHandleAgents(VOICE_USER)).toEqual([{ id: VOICE_AGENT, name: 'Voce Casa' }]);
  });
});
