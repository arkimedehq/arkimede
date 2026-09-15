// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file wyoming.service.ts
 *
 * Wyoming voice server: exposes the STT/TTS providers configured in the admin
 * panel (TranscriptionService / TtsService — internal Whisper+Piper or any
 * cloud/OpenAI-compatible endpoint) over the Wyoming protocol, so voice hubs
 * such as Home Assistant can add Arkimede as a native speech-to-text and
 * text-to-speech provider ("Wyoming Protocol" integration → host:port).
 *
 * Opt-in: the TCP listener starts only when `app_config.wyomingEnabled` is true
 * and is (re)started at runtime when the admin saves the card — no restart.
 * The protocol carries no authentication: access is gated by an optional
 * client allowlist (IPs / IPv4 CIDRs) checked on every connection.
 *
 * Supported events (one request per connection, as Home Assistant does):
 *   describe → info                       (capabilities: asr + tts + handle programs)
 *   transcribe, audio-start/chunk/stop → transcript
 *   synthesize → audio-start/chunk/stop
 *   transcript → handled | not-handled   (conversation: the hub sends the text
 *                                         to handle, the configured user's agent answers)
 *   ping → pong
 *
 * Conversation ("handle" program): exposed only when an admin picked the user
 * the hub acts as (`wyomingHandleUserId`) and optionally an agent of theirs.
 * The hub sends one text per turn; multi-turn context is kept here per
 * `context.conversation_id` (the hub's conversation), with a short TTL.
 *
 * The listening port is deployment-level (env WYOMING_PORT, default 10300)
 * because it must match the container port mapping.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as net from 'node:net';
import { AppConfigService } from '../app-config/app-config.service';
import { TranscriptionService } from '../transcription/transcription.service';
import { TtsService } from '../tts/tts.service';
import { matchesHostAllowlist } from '../common/ssrf-guard';
import { AgentService } from '../agent/agent.service';
import { AgentsService } from '../agents/agents.service';
import { agentRunOptions } from '../agents/agent-run-options';
import { agentSlug } from '../openai-compat/openai-mapper';
import { UsersService } from '../users/users.service';
import { InvocationsService } from '../invocations/invocations.service';
import { makeToolCollector } from '../invocations/tool-collector';
import { APP_NAME, APP_NAME_SLUG } from '../config/app.config';
import {
  WyomingDecoder, WyomingEvent, encodeEvent, pcmToWav, parseWav, chunkPcm, PcmFormat,
} from './wyoming.protocol';

/** Languages understood by Whisper-class models (ISO 639-1), advertised for ASR. */
const ASR_LANGUAGES = [
  'af','ar','hy','az','be','bs','bg','ca','zh','hr','cs','da','nl','en','et','fi','fr','gl','de','el','he','hi',
  'hu','is','id','it','ja','kn','kk','ko','lv','lt','mk','ms','mr','mi','ne','no','fa','pl','pt','ro','ru','sr',
  'sk','sl','es','sw','sv','tl','ta','th','tr','uk','ur','vi','cy',
];

/** Languages of the multilingual cloud TTS voices (OpenAI & co.). */
const CLOUD_TTS_LANGUAGES = ['en','it','de','fr','es','pt','nl','pl','ru','ja','ko','zh','ar','hi','tr','sv','da','no','fi','cs','el','he','id','ms','ro','sk','uk','vi'];

/** Audio format Home Assistant streams for STT (16 kHz, 16-bit, mono). */
const DEFAULT_ASR_FORMAT: PcmFormat = { rate: 16000, width: 2, channels: 1 };

/** Cap on buffered audio per transcription request (≈ 5 min at 16 kHz/16-bit mono). */
const MAX_ASR_BYTES = 16000 * 2 * 300;

/** Idle timeout per connection. */
const SOCKET_TIMEOUT_MS = 120_000;

/** Conversation window kept per hub conversation: max turns and inactivity TTL. */
const CONVERSATION_MAX_MESSAGES = 20;
const CONVERSATION_TTL_MS = 10 * 60 * 1000;

/** Model id advertised for the standard pipeline (no agent) — same as the OpenAI shim. */
const DEFAULT_HANDLE_MODEL = APP_NAME_SLUG;

interface ConversationWindow { messages: { role: 'user' | 'assistant'; content: string }[]; updatedAt: number }

export interface WyomingStatus {
  running:   boolean;
  port:      number;
  clients:   number;
  lastError: string | null;
  /** Resolved conversation agent (null = STT/TTS only). */
  handle:    { userEmail: string; agentName: string | null; model: string } | null;
}

@Injectable()
export class WyomingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WyomingService.name);
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private allowlist: string[] = [];
  private lastError: string | null = null;
  private port: number;
  private readonly host: string;
  /** Conversation agent resolved from the config (null = handle program not exposed). */
  private handle: { userId: string; userEmail: string; agentId: string | null; agentName: string | null; model: string } | null = null;
  private readonly conversations = new Map<string, ConversationWindow>();

  constructor(
    @Inject(forwardRef(() => AppConfigService))
    private readonly appConfig: AppConfigService,
    @Inject(forwardRef(() => TranscriptionService))
    private readonly transcription: TranscriptionService,
    @Inject(forwardRef(() => TtsService))
    private readonly tts: TtsService,
    private readonly env: ConfigService,
    // The conversation program needs the agent pipeline, agent/user lookups and the
    // invocation log. They are resolved lazily through ModuleRef instead of module
    // imports: AgentModule's import graph reaches AppConfigModule (which imports this
    // module), and a static import would leave AppConfigModule undefined mid-cycle.
    private readonly moduleRef: ModuleRef,
  ) {
    const port = Number(this.env.get<string>('WYOMING_PORT', '10300'));
    this.port = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 10300;  // 0 = ephemeral (tests)
    this.host = this.env.get<string>('WYOMING_BIND', '0.0.0.0');
  }

  private get agentService(): AgentService   { return this.moduleRef.get(AgentService,   { strict: false }); }
  private get agentsService(): AgentsService { return this.moduleRef.get(AgentsService,  { strict: false }); }
  private get usersService(): UsersService   { return this.moduleRef.get(UsersService,   { strict: false }); }
  private get invocations(): InvocationsService { return this.moduleRef.get(InvocationsService, { strict: false }); }

  async onModuleInit(): Promise<void> {
    await this.applyConfig();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Live status for the admin card. */
  getStatus(): WyomingStatus {
    return {
      running: !!this.server, port: this.port, clients: this.clients.size, lastError: this.lastError,
      handle: this.handle ? { userEmail: this.handle.userEmail, agentName: this.handle.agentName, model: this.handle.model } : null,
    };
  }

  /** Re-reads the DB configuration and starts/stops the listener accordingly. */
  async applyConfig(): Promise<void> {
    const cfg = await this.appConfig.getWyomingConfig();
    this.allowlist = (cfg.wyomingAllowedCidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    this.handle = await this.resolveHandle(cfg.wyomingHandleUserId, cfg.wyomingHandleAgentId);
    if (cfg.wyomingEnabled) {
      if (!this.server) await this.start();
    } else if (this.server) {
      await this.stop();
    }
  }

  /**
   * Resolves the conversation identity from the config. Tolerant: a deleted or
   * disabled user (or a vanished agent) silently disables the handle program
   * instead of breaking STT/TTS, and is logged for the admin.
   */
  private async resolveHandle(userId: string | null, agentId: string | null) {
    if (!userId) return null;
    try {
      const user = await this.usersService.getById(userId);
      if (user.status !== 'active') {
        this.logger.warn(`Wyoming: conversation user ${user.email} is not active — handle program disabled`);
        return null;
      }
      let agentName: string | null = null;
      if (agentId) {
        const agents = await this.agentsService.findAll(userId);
        const agent = agents.find((a) => a.id === agentId);
        if (!agent) {
          this.logger.warn(`Wyoming: agent ${agentId} not accessible by ${user.email} — falling back to the standard pipeline`);
          agentId = null;
        } else {
          agentName = agent.name;
        }
      }
      return { userId, userEmail: user.email, agentId, agentName, model: agentName ? agentSlug(agentName) : DEFAULT_HANDLE_MODEL };
    } catch (err: any) {
      this.logger.warn(`Wyoming: conversation user ${userId} not found — handle program disabled (${err?.message ?? err})`);
      return null;
    }
  }

  /**
   * Validates a conversation identity before it is saved (admin PATCH):
   * the user must exist and be active, the agent must be visible to that user.
   * Throws a plain Error with an i18n key the controller maps to a 400.
   */
  async validateHandleConfig(userId: string | null, agentId: string | null): Promise<void> {
    if (!userId) return;
    const user = await this.usersService.getById(userId).catch(() => null);
    if (!user || user.status !== 'active') throw new Error('wyoming.handleUserInvalid');
    if (agentId) {
      const agents = await this.agentsService.findAll(userId);
      if (!agents.some((a) => a.id === agentId)) throw new Error('wyoming.handleAgentInvalid');
    }
  }

  /** Agents the given user can run as a conversation agent (admin picker). */
  async listHandleAgents(userId: string): Promise<{ id: string; name: string }[]> {
    const agents = await this.agentsService.findAll(userId);
    return agents.map((a) => ({ id: a.id, name: a.name }));
  }

  /** Returns the conversation window for a key, evicting expired ones on the way. */
  private conversationWindow(key: string): ConversationWindow {
    const now = Date.now();
    for (const [k, w] of this.conversations) {
      if (now - w.updatedAt > CONVERSATION_TTL_MS) this.conversations.delete(k);
    }
    let w = this.conversations.get(key);
    if (!w) { w = { messages: [], updatedAt: now }; this.conversations.set(key, w); }
    return w;
  }

  // ── Listener lifecycle ─────────────────────────────────────────────────────

  private start(): Promise<void> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.on('error', (err: any) => {
        this.lastError = err?.message ?? String(err);
        this.logger.error(`Wyoming listener error: ${this.lastError}`);
        this.server = null;
        resolve();
      });
      server.listen(this.port, this.host, () => {
        this.server = server;
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;   // resolve an ephemeral port
        this.lastError = null;
        this.logger.log(`Wyoming voice server listening on ${this.host}:${this.port} (allowlist: ${this.allowlist.join(', ') || 'any'})`);
        resolve();
      });
    });
  }

  private stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      if (!server) return resolve();
      this.server = null;
      for (const s of this.clients) s.destroy();
      this.clients.clear();
      server.close(() => {
        this.logger.log('Wyoming voice server stopped');
        resolve();
      });
    });
  }

  // ── Connection handling ────────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const ip = (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (this.allowlist.length && !matchesHostAllowlist(ip, ip, this.allowlist)) {
      this.logger.warn(`Wyoming: connection from ${ip} rejected (not in allowlist)`);
      socket.destroy();
      return;
    }
    this.clients.add(socket);
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', (err) => this.logger.debug(`Wyoming: socket ${ip} error: ${err.message}`));

    const decoder = new WyomingDecoder();
    // Per-connection STT state: the audio stream between audio-start and audio-stop.
    const asr = { active: false, language: undefined as string | undefined, fmt: DEFAULT_ASR_FORMAT, chunks: [] as Buffer[], bytes: 0 };
    // Serialize event handling per connection (events are ordered on the wire).
    let queue: Promise<void> = Promise.resolve();

    socket.on('data', (buf) => {
      try {
        decoder.feed(buf);
        let ev: WyomingEvent | null;
        while ((ev = decoder.next())) {
          const event = ev;
          queue = queue.then(() => this.handleEvent(socket, event, asr, ip)).catch((err) => {
            this.logger.error(`Wyoming: ${event.type} from ${ip} failed: ${err?.message ?? err}`);
            this.send(socket, { type: 'error', data: { text: String(err?.message ?? err), code: 'error' } });
          });
        }
      } catch (err: any) {
        this.logger.warn(`Wyoming: protocol error from ${ip}: ${err?.message ?? err}`);
        socket.destroy();
      }
    });
  }

  private send(socket: net.Socket, ev: WyomingEvent): void {
    if (!socket.destroyed) socket.write(encodeEvent(ev));
  }

  private async handleEvent(
    socket: net.Socket,
    ev: WyomingEvent,
    asr: { active: boolean; language?: string; fmt: PcmFormat; chunks: Buffer[]; bytes: number },
    ip: string,
  ): Promise<void> {
    switch (ev.type) {
      case 'describe':
        this.send(socket, { type: 'info', data: await this.buildInfo() });
        return;

      case 'ping':
        this.send(socket, { type: 'pong', data: ev.data?.text ? { text: ev.data.text } : {} });
        return;

      case 'transcribe':
        asr.active = true; asr.chunks = []; asr.bytes = 0;
        asr.language = typeof ev.data?.language === 'string' ? ev.data.language : undefined;
        return;

      case 'audio-start':
        asr.active = true; asr.chunks = []; asr.bytes = 0;
        asr.fmt = this.pcmFormatOf(ev.data);
        return;

      case 'audio-chunk':
        if (!asr.active) { asr.active = true; asr.fmt = this.pcmFormatOf(ev.data); }
        if (ev.payload?.length) {
          asr.bytes += ev.payload.length;
          if (asr.bytes > MAX_ASR_BYTES) throw new Error('audio stream too long');
          asr.chunks.push(ev.payload);
        }
        return;

      case 'audio-stop': {
        if (!asr.active) return;
        asr.active = false;
        const pcm = Buffer.concat(asr.chunks);
        asr.chunks = []; asr.bytes = 0;
        const t0 = Date.now();
        const text = pcm.length
          ? await this.transcription.transcribe(pcmToWav(pcm, asr.fmt), 'audio.wav', asr.language)
          : '';
        this.logger.log(`Wyoming: transcript for ${ip} (${pcm.length} bytes → ${text.length} chars) in ${Date.now() - t0}ms`);
        this.send(socket, { type: 'transcript', data: { text, ...(asr.language ? { language: asr.language } : {}) } });
        return;
      }

      case 'transcript': {
        // Conversation turn from the hub (handle program): text → agent → handled.
        if (!this.handle) {
          this.send(socket, { type: 'not-handled', data: { text: 'No conversation agent configured' } });
          return;
        }
        const text = String(ev.data?.text ?? '').trim();
        if (!text) { this.send(socket, { type: 'not-handled', data: { text: '' } }); return; }
        const context = ev.data?.context && typeof ev.data.context === 'object' ? ev.data.context : {};
        const key = typeof context.conversation_id === 'string' && context.conversation_id ? context.conversation_id : `ip:${ip}`;
        const window = this.conversationWindow(key);
        const history = window.messages.map((m) => ({ role: m.role, content: m.content })) as any[];
        const t0 = Date.now();
        const tools = makeToolCollector();
        const abort = new AbortController();
        socket.once('close', () => abort.abort());
        let answer = '';
        try {
          const usage = await this.agentService.streamResponse(
            text, this.handle.userId, undefined, undefined, history,
            [], [], [],
            (chunk) => { answer += chunk; },
            tools.onToolCall,
            abort.signal,
            tools.onToolResult,
            agentRunOptions(this.handle.agentId ? await this.agentsService.findById(this.handle.agentId).catch(() => null) : null, 'voice'),
          );
          window.messages.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
          if (window.messages.length > CONVERSATION_MAX_MESSAGES) window.messages.splice(0, window.messages.length - CONVERSATION_MAX_MESSAGES);
          window.updatedAt = Date.now();
          this.logger.log(`Wyoming: handled turn for ${ip} [${this.handle.model}] (${text.length} → ${answer.length} chars, ${history.length} history) in ${Date.now() - t0}ms`);
          void this.invocations.record({
            userId: this.handle.userId, origin: 'voice', route: 'chat', model: `wyoming:${this.handle.model}`,
            inputPreview: text, outputPreview: answer || null, toolCalls: tools.records,
            inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
            durationMs: Date.now() - t0, status: 'ok',
          });
          this.send(socket, { type: 'handled', data: { text: answer, ...(context.conversation_id ? { context } : {}) } });
        } catch (err: any) {
          const message = err?.message ?? 'Internal error';
          this.logger.warn(`Wyoming: handle failed for ${ip} in ${Date.now() - t0}ms: ${message}`);
          void this.invocations.record({
            userId: this.handle.userId, origin: 'voice', route: 'chat', model: `wyoming:${this.handle.model}`,
            inputPreview: text, outputPreview: answer || null, toolCalls: tools.records,
            durationMs: Date.now() - t0, status: 'error', error: abort.signal.aborted ? 'client aborted' : message,
          });
          this.send(socket, { type: 'not-handled', data: { text: message } });
        }
        return;
      }

      case 'synthesize': {
        const text  = String(ev.data?.text ?? '');
        const voice = typeof ev.data?.voice?.name === 'string' ? ev.data.voice.name : undefined;
        const t0 = Date.now();
        const wav = await this.tts.synthesize(text, voice, 'wav');
        const { fmt, pcm } = parseWav(wav);
        this.send(socket, { type: 'audio-start', data: { ...fmt, timestamp: 0 } });
        let ts = 0;
        for (const chunk of chunkPcm(pcm, fmt)) {
          this.send(socket, { type: 'audio-chunk', data: { ...fmt, timestamp: ts }, payload: chunk });
          ts += Math.round((chunk.length / (fmt.width * fmt.channels)) * 1000 / fmt.rate);
        }
        this.send(socket, { type: 'audio-stop', data: { timestamp: ts } });
        this.logger.log(`Wyoming: synthesized ${text.length} chars for ${ip} (${pcm.length} bytes) in ${Date.now() - t0}ms`);
        return;
      }

      default:
        // Unknown/unsupported events (select-program, streaming synthesize-*) are ignored.
        this.logger.debug(`Wyoming: ignoring event "${ev.type}" from ${ip}`);
    }
  }

  private pcmFormatOf(data: Record<string, any> | undefined): PcmFormat {
    return {
      rate:     Number(data?.rate)     || DEFAULT_ASR_FORMAT.rate,
      width:    Number(data?.width)    || DEFAULT_ASR_FORMAT.width,
      channels: Number(data?.channels) || DEFAULT_ASR_FORMAT.channels,
    };
  }

  // ── Capabilities (`info`) ──────────────────────────────────────────────────

  /**
   * Builds the `info` event from the providers currently configured (and the
   * conversation agent, if any), so the hub sees the real model/voice names. Everything is `installed: true`: the
   * providers are already reachable from this backend (or the test button
   * in the admin card tells otherwise).
   */
  private async buildInfo(): Promise<Record<string, any>> {
    const [stt, tts] = await Promise.all([this.transcription.describe(), this.tts.describe()]);
    const attribution = { name: APP_NAME, url: 'https://github.com/arkimedehq/arkimede' };

    const asrPrograms = stt.enabled ? [{
      name: `${APP_NAME_SLUG}-stt`,
      description: `${APP_NAME} speech-to-text (${stt.provider})`,
      attribution,
      installed: true,
      version: '1',
      models: [{
        name: stt.model,
        description: `${stt.model} via ${stt.provider}`,
        attribution,
        installed: true,
        version: '1',
        languages: ASR_LANGUAGES,
      }],
    }] : [];

    // Internal Piper: one entry per downloaded voice (language from the voice id, e.g. it_IT-paola-medium).
    // Cloud providers: the configured default voice, multilingual.
    const voiceNames = tts.provider === 'internal'
      ? (tts.voices.length ? tts.voices : (tts.voice ? [tts.voice] : []))
      : (tts.voice ? [tts.voice] : []);
    const voices = voiceNames.map((name) => ({
      name,
      description: `${name} via ${tts.provider}`,
      attribution,
      installed: true,
      version: '1',
      languages: this.languagesOfVoice(name, tts.provider === 'internal'),
    }));
    const ttsPrograms = voices.length ? [{
      name: `${APP_NAME_SLUG}-tts`,
      description: `${APP_NAME} text-to-speech (${tts.provider})`,
      attribution,
      installed: true,
      version: '1',
      voices,
    }] : [];

    const handlePrograms = this.handle ? [{
      name: `${APP_NAME_SLUG}-agent`,
      description: `${APP_NAME} conversation agent (${this.handle.agentName ?? 'standard pipeline'})`,
      attribution,
      installed: true,
      version: '1',
      models: [{
        name: this.handle.model,
        description: this.handle.agentName ? `Agent "${this.handle.agentName}" of ${this.handle.userEmail}` : `Standard pipeline as ${this.handle.userEmail}`,
        attribution,
        installed: true,
        version: '1',
        languages: ASR_LANGUAGES,
      }],
    }] : [];

    return { asr: asrPrograms, tts: ttsPrograms, handle: handlePrograms, intent: [], wake: [], mic: [], snd: [], satellite: null };
  }

  /** `it_IT-paola-medium` → ['it', 'it-IT']; unknown/cloud voices → multilingual list. */
  private languagesOfVoice(name: string, internal: boolean): string[] {
    const m = /^([a-z]{2})[_-]([A-Z]{2})-/.exec(name);
    if (m) return [m[1], `${m[1]}-${m[2]}`];
    return internal ? ['en'] : CLOUD_TTS_LANGUAGES;
  }
}
