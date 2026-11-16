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
 *   transcript → handled | not-handled   (conversation: the hub sends the text to handle, the agent of the
 *                                         satellite's account answers; `handled` carries `continue_conversation`)
 *   ping → pong
 *
 * Conversation ("handle" program): exposed when the admin turns it on. Each turn
 * runs as the account its satellite is assigned to in the Home Assistant settings
 * (an unassigned satellite, or a hub that sends none: the default account), with
 * the voice agent that user chose (specs/VOICE_SATELLITES.md). The advertised
 * model is the default account's, so the hub's pipeline keeps its name.
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
import { randomUUID } from 'node:crypto';
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
import { ExternalChatsService, type ExternalTurn } from '../chats/external-chats.service';
import { VoiceDeliveryService } from '../notifications/voice-delivery.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { ChatRunsService } from '../messages/chat-runs.service';
import type { AgentProgressEvent } from '../agent/agent.service';
import type { ToolCallRecord } from '../messages/messages.entity';
import { ConversationFocusService, FOCUS_HISTORY_MESSAGES, satelliteName } from '../chats/conversation-focus.service';
import { APP_NAME, APP_NAME_SLUG } from '../config/app.config';
import { withTraceUser } from '../observability/genai-tracing';
import { VoiceIdService, type VoiceTurnResult } from '../voice-id/voice-id.service';
import { HomeAssistantService } from '../home-assistant/home-assistant.service';
import { RecordareInitiativesService } from '../recordare/recordare-initiatives.service';
import { RecordareIdentityService } from '../recordare/recordare-identity.service';
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

/**
 * A turn still running after this long is detached (0: never): the hub hears that the work goes on and hangs up, the
 * run goes on, and its answer is delivered when it ends — said where the user is (the one voice channel) and written in
 * the chat, with a notification. A satellite is no place to wait minutes for a whole app to be written, and the hub
 * would close the connection (SOCKET_TIMEOUT_MS), which cancelled the run.
 */
const detachMs = (): number => Math.max(0, Number(process.env.WYOMING_DETACH_MS ?? 25_000) || 0);

/**
 * A voice command the hub cut at its maximum length (Home Assistant's pipeline stops listening after 15 s, whatever is
 * being said): a transcription this long is taken as cut, not as the whole request. Its text is held — the satellite
 * says "go on" and keeps listening — and the next part of that conversation is joined to it, up to DICTATION_MAX_PARTS
 * parts, before the agent runs. A part waits DICTATION_TTL_MS at most.
 */
const DICTATION_CUT_SECONDS = Math.max(0, Number(process.env.WYOMING_DICTATION_CUT_S ?? 14.8) || 0);
const DICTATION_TTL_MS = 60_000;
const DICTATION_MAX_PARTS = 6;

/** What a satellite says when a command was cut at the hub's limit: the rest is awaited (Italian or English). */
export function keepTalking(language?: string): string {
  return (language ?? '').toLowerCase().startsWith('it') ? 'Continua, ti ascolto.' : 'Go on, I am listening.';
}

/** A transcription's text as compared between the STT request and the turn that carries it. */
const dictationKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** Conversation window kept per hub conversation: max turns and inactivity TTL. */
const CONVERSATION_MAX_MESSAGES = 20;
const CONVERSATION_TTL_MS = 10 * 60 * 1000;

/** Model id advertised for the standard pipeline (no agent) — same as the OpenAI shim. */
const DEFAULT_HANDLE_MODEL = APP_NAME_SLUG;

/**
 * Whether ANSWER waits for the user's reply: it ends with a question mark (also when closed by quotes, brackets or
 * emphasis). Sent as `continue_conversation` in the `handled` event: a hub that honours it listens again without the
 * wake word (proposed for the Wyoming protocol and Home Assistant's Wyoming integration).
 */
export function expectsReply(answer: string): boolean {
  return /[?？]\s*["'»”’)\]*_]*\s*$/.test(answer);
}

/**
 * What a satellite says when the agent could not answer (an LLM error, the step limit reached, a tool timing out):
 * a sentence for people, in the turn's language (Italian or English), instead of the error's own text, which the hub
 * would read out ("Recursion limit of 13 reached…"). The error itself goes to the log and the invocation record.
 */
export function spokenFailure(language?: string): string {
  return (language ?? '').toLowerCase().startsWith('it')
    ? 'Scusa, non sono riuscito a finire. Riprova, magari chiedendolo in un altro modo.'
    : "Sorry, I couldn't finish that. Please try again, maybe asking in another way.";
}

/** What a satellite says when a turn is detached: the work goes on, the answer will come (Italian or English). */
export function workingOn(language?: string): string {
  return (language ?? '').toLowerCase().startsWith('it')
    ? 'Ci sto lavorando: te lo dico appena ho finito.'
    : "I'm working on it: I'll tell you as soon as it's done.";
}

/**
 * A detached turn's answer waits while a voice exchange is going on — audio coming in, a turn waiting for its answer,
 * a sentence being played (as long as its synthesis lasts, plus VOICE_TAIL_MS) — at most QUIET_WAIT_MS: an
 * announcement on a satellite cuts the pipeline running on it, and the hub then cancels that turn.
 */
const QUIET_WAIT_MS = 120_000;
const VOICE_TAIL_MS = 1_500;
const AUDIO_QUIET_MS = 2_000;

/** What a satellite says when the user stopped a detached turn's work (Italian or English). */
export function stoppedWork(language?: string): string {
  return (language ?? '').toLowerCase().startsWith('it') ? 'Ho fermato il lavoro.' : 'I stopped the work.';
}

/** A voice conversation's turns (the assistant's tool calls with its answer: the agent replays them on the next turn). */
interface ConversationWindow {
  messages: { id?: string; role: 'user' | 'assistant'; content: string; toolCalls?: ToolCallRecord[] }[];
  updatedAt: number;
}

export interface WyomingStatus {
  running:   boolean;
  port:      number;
  clients:   number;
  lastError: string | null;
  /** The default account's conversation agent, as advertised (null = STT/TTS only). */
  handle:    { userEmail: string; agentName: string | null; model: string } | null;
}

/** Who a turn runs as: the satellite's account and the agent that user chose for the voice. */
interface TurnAccount { userId: string; userEmail: string; agentId: string | null; agentName: string | null; model: string }

@Injectable()
export class WyomingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WyomingService.name);
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private allowlist: string[] = [];
  private lastError: string | null = null;
  private port: number;
  private readonly host: string;
  /** The default account (advertised model, speech attribution); null = handle program not exposed. */
  private handle: TurnAccount | null = null;
  private readonly conversations = new Map<string, ConversationWindow>();
  /** The voice exchange going on (see QUIET_WAIT_MS): turns waiting for their answer, the last audio in, the end of the
   * last sentence synthesized. */
  private turnsInProgress = 0;
  private audioAt = 0;
  private speakingUntil = 0;
  /** Transcriptions cut at the hub's command limit (their text → when), until their turn comes. */
  private readonly cutTranscripts = new Map<string, number>();
  /** The parts of a command dictated across cuts, per conversation (its key): joined when the last one comes. */
  private readonly dictations = new Map<string, { parts: string[]; at: number }>();
  /** Save the conversation turns as chats of the turn's account (admin toggle). */
  private persistConversations = false;

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
  private get externalChats(): ExternalChatsService { return this.moduleRef.get(ExternalChatsService, { strict: false }); }
  private get focus(): ConversationFocusService { return this.moduleRef.get(ConversationFocusService, { strict: false }); }
  private get voiceDelivery(): VoiceDeliveryService { return this.moduleRef.get(VoiceDeliveryService, { strict: false }); }
  private get notifications(): NotificationsService { return this.moduleRef.get(NotificationsService, { strict: false }); }
  private get gateway(): NotificationsGateway { return this.moduleRef.get(NotificationsGateway, { strict: false }); }
  private get chatRuns(): ChatRunsService | null {
    try { return this.moduleRef.get(ChatRunsService, { strict: false }); } catch { return null; }
  }
  /** Voice recognition (optional: absent in a test module without it). */
  private get voiceId(): VoiceIdService | null {
    try { return this.moduleRef.get(VoiceIdService, { strict: false }); } catch { return null; }
  }
  /** Home Assistant (the satellites' assignments) and the memory's shared turns: optional likewise. */
  private get homeAssistant(): HomeAssistantService | null {
    try { return this.moduleRef.get(HomeAssistantService, { strict: false }); } catch { return null; }
  }
  private get initiatives(): RecordareInitiativesService | null {
    try { return this.moduleRef.get(RecordareInitiativesService, { strict: false }); } catch { return null; }
  }

  private get identity(): RecordareIdentityService | null {
    try { return this.moduleRef.get(RecordareIdentityService, { strict: false }); } catch { return null; }
  }

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
    this.handle = cfg.wyomingConversationEnabled ? await this.accountFor(null, null) : null;
    this.persistConversations = cfg.wyomingPersistConversations;
    if (cfg.wyomingEnabled) {
      if (!this.server) await this.start();
    } else if (this.server) {
      await this.stop();
    }
  }

  /**
   * The account a turn from this satellite runs as (its assignment, else the default account) with that user's voice
   * agent. Tolerant: a disabled user gives no account (the turn is not handled), a vanished or no longer visible agent
   * the standard pipeline; both are logged for the admin.
   */
  async accountFor(satelliteId: string | null, deviceId: string | null): Promise<TurnAccount | null> {
    const accounts = await this.appConfig.voiceAccounts();
    const entity = this.homeAssistant?.satelliteEntity(satelliteId, deviceId) ?? null;
    const userId = (entity && accounts.satellites[entity]) || accounts.defaultUserId;
    if (!userId) {
      this.logger.warn('Wyoming: no account for the satellites (no active admin) — conversation not handled');
      return null;
    }
    const user = await this.usersService.voiceSettings(userId);
    if (!user || user.status !== 'active') {
      this.logger.warn(`Wyoming: the account of ${entity ?? 'the satellites'} is not active — conversation not handled`);
      return null;
    }
    let agentId = user.voiceAgentId;
    let agentName: string | null = null;
    if (agentId) {
      const agent = (await this.agentsService.findAll(userId)).find((a) => a.id === agentId);
      if (agent) agentName = agent.name;
      else {
        this.logger.warn(`Wyoming: voice agent ${agentId} not accessible by ${user.email} — standard pipeline`);
        agentId = null;
      }
    }
    return { userId, userEmail: user.email, agentId, agentName, model: agentName ? agentSlug(agentName) : DEFAULT_HANDLE_MODEL };
  }

  /** Returns the conversation window for a key, evicting expired ones on the way. */
  /** Drops what waits longer than its TTL: a cut transcription whose turn never came, a dictation left unfinished. */
  private forgetStaleDictations(now: number): void {
    for (const [text, at] of this.cutTranscripts) if (now - at > DICTATION_TTL_MS) this.cutTranscripts.delete(text);
    for (const [key, d] of this.dictations) if (now - d.at > DICTATION_TTL_MS) this.dictations.delete(key);
  }

  /**
   * Saves a turn's answer: into the chat its recognised speaker already opened (`early`), else as a whole turn when it
   * is recorded at all. In the background (the hub waits for its answer) it is not awaited: null. Otherwise the chat
   * id, or null when it could not be saved.
   */
  private async saveTurn(early: string | null, record: boolean, turn: ExternalTurn, background: boolean): Promise<string | null> {
    if (!early && !record) return null;
    const save = early
      ? this.externalChats.recordAnswer(early, { answer: turn.answer, toolCalls: turn.toolCalls, usage: turn.usage }).then(() => early)
      : this.externalChats.recordTurn(turn);
    const saved = save.catch((err) => { this.logger.warn(`Wyoming: saving the turn failed: ${err?.message ?? err}`); return null; });
    if (background) { void saved; return null; }
    return saved;
  }

  /**
   * A detached turn's answer, once its work ended: said where the user is (the one voice channel: a turn of the last
   * minutes put presence in the satellite's room), and announced in the app with its chat to open.
   */
  /** Resolves once no voice exchange is going on (see QUIET_WAIT_MS), or after MAX_MS; how long it waited. */
  async quiet(maxMs = QUIET_WAIT_MS, stepMs = 250): Promise<number> {
    const start = Date.now();
    const busy = () => this.turnsInProgress > 0 || Date.now() < this.speakingUntil || Date.now() - this.audioAt < AUDIO_QUIET_MS;
    while (busy() && Date.now() - start < maxMs) await new Promise((resolve) => setTimeout(resolve, stepMs));
    return Date.now() - start;
  }

  private async deliverDetached(userId: string, answer: string, chatId: string | null, request: string): Promise<void> {
    if (!chatId) return;
    const waited = await this.quiet();
    if (waited > 1000) this.logger.log(`Wyoming: a detached turn's answer waited ${Math.round(waited / 1000)} s for the voice exchange going on`);
    const point = await this.voiceDelivery.deliver(userId, answer, chatId);
    this.logger.log(`Wyoming: a detached turn's answer ${point ? `said on ${point}` : 'not said by voice (nobody confirmed present): in its chat'}`);
    try {
      const title = request.length > 80 ? `${request.slice(0, 80)}…` : request;
      const payload = { title: `🎙️ ${title}`, message: answer.length > 160 ? `${answer.slice(0, 160)}…` : answer, chatId, spoken: !!point };
      const notif = await this.notifications.create({ userId, source: 'wyoming', sourceId: chatId, eventType: 'voice_work_done', payload });
      this.gateway.emitToUser(userId, 'notification', { id: notif.id, eventType: 'voice_work_done', ...payload });
    } catch (err) {
      this.logger.warn(`Wyoming: the detached turn's notification failed: ${(err as Error).message}`);
    }
  }

  /** Someone spoke to that satellite: its room is lived in now (Home Assistant tells the memory, a voice delivery speaks there). */
  private voiceTurn(context: Record<string, any>, speaker: { identity?: { channel: string; externalId: string } | null; confidence: number } | null, userId: string): void {
    this.focus.voiceTurn({
      userId, satelliteId: satelliteName(context.satellite_id), deviceId: satelliteName(context.device_id),
      ...(speaker?.identity ? { speaker: { identity: speaker.identity, confidence: speaker.confidence } } : {}),
    });
  }

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
        this.audioAt = Date.now();
        asr.active = true; asr.chunks = []; asr.bytes = 0;
        asr.fmt = this.pcmFormatOf(ev.data);
        return;

      case 'audio-chunk':
        this.audioAt = Date.now();
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
        const wav = pcm.length ? pcmToWav(pcm, asr.fmt) : null;
        // Who spoke (voice recognition on): the voiceprint is computed alongside the transcription, no added wait.
        const voiceId = wav && this.handle ? this.voiceId : null;
        const voiceprint = voiceId && (await voiceId.active()) ? voiceId.embed(wav!) : null;
        // Speech requests act for the default account (trace attribution only: the satellite is known with the text).
        const text = wav
          ? await withTraceUser(this.handle?.userId, () => this.transcription.transcribe(wav, 'audio.wav', asr.language, { userId: this.handle?.userId }))
          : '';
        if (voiceprint && text.trim()) voiceId!.remember(text, voiceprint);
        // As long as the hub's command limit: cut while the user was still speaking (see DICTATION_CUT_SECONDS).
        const seconds = pcm.length / (asr.fmt.rate * asr.fmt.width * asr.fmt.channels);
        if (DICTATION_CUT_SECONDS > 0 && seconds >= DICTATION_CUT_SECONDS && text.trim()) {
          this.cutTranscripts.set(dictationKey(text), Date.now());
          this.logger.log(`Wyoming: a transcript cut at ${seconds.toFixed(1)} s (the hub's limit): its turn will wait for the rest`);
        }
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
        const said = String(ev.data?.text ?? '').trim();
        if (!said) { this.send(socket, { type: 'not-handled', data: { text: '' } }); return; }
        const language = typeof ev.data?.language === 'string' ? ev.data.language : asr.language;
        const context = ev.data?.context && typeof ev.data.context === 'object' ? ev.data.context : {};
        const key = typeof context.conversation_id === 'string' && context.conversation_id ? context.conversation_id : `ip:${ip}`;
        // A command dictated across the hub's cuts: this part joins the ones before; a part cut again waits for the next.
        const now = Date.now();
        this.forgetStaleDictations(now);
        const before = this.dictations.get(key);
        const parts = [...(before?.parts ?? []), said];
        const cut = this.cutTranscripts.delete(dictationKey(said));
        if (cut && parts.length < DICTATION_MAX_PARTS) {
          this.dictations.set(key, { parts, at: now });
          this.logger.log(`Wyoming: part ${parts.length} of a dictated command for ${ip} (key ${key}): waiting for the rest`);
          this.send(socket, { type: 'handled', data: {
            text: keepTalking(language), continue_conversation: true, ...(context.conversation_id ? { context } : {}),
          } });
          return;
        }
        this.dictations.delete(key);
        const text = parts.join(' ');
        // The hub reports the satellite (its entity) beside the conversation id: the turn runs as the satellite's
        // account, and a client may have focused that satellite on a chat (ConversationFocusService).
        const account = await this.accountFor(satelliteName(context.satellite_id), satelliteName(context.device_id));
        if (!account) {
          this.send(socket, { type: 'not-handled', data: { text: spokenFailure(language) } });
          return;
        }
        const userId = account.userId;
        const satellite = satelliteName(context.satellite_id) ?? satelliteName(context.device_id);
        const focusedId = this.focus.get(userId, satellite);
        const focused = focusedId ? await this.externalChats.historyOf(focusedId, userId, FOCUS_HISTORY_MESSAGES) : null;
        const window = this.conversationWindow(key);
        // A focus that ended since this window's last turn closes the window's conversation.
        const fresh = this.focus.freshSince(userId, satellite);
        if (!focused && fresh && window.messages.length && window.updatedAt < fresh) window.messages = [];
        const history = (focused ?? window.messages.map((m) => ({ ...m }))) as any[];
        // Who is speaking (voice recognition on): told to the agent, to the memory with the turn, and as the presence.
        // Its voiceprint is found by the text just transcribed: the last part of a dictated command.
        const voice: VoiceTurnResult = (await this.voiceId?.forTurn(said, satellite, userId).catch(() => null)) ?? { kind: 'unknown' };
        const speaker = voice.kind === 'speaker' && !voice.speaker.holder ? voice.speaker : null;
        // An entity's memory (a shared agent: the account is the assistant's own identity): an unknown voice is not its holder.
        const entity = voice.kind === 'unknown' && (await this.identity?.mode(userId).catch(() => null)) === 'entity';
        const turnBlocks = voiceBlocks(voice, entity);
        // A recognised speaker goes into the chat before the run: the memory reads who is talking when asked for context.
        const record = this.persistConversations || !!focused;
        let early = record && speaker
          ? await this.externalChats.recordUserMessage({
            userId, source: 'wyoming', key, idleMs: CONVERSATION_TTL_MS, satellite, chatId: focused ? focusedId : null, notBefore: fresh,
            userText: text, speaker: { channel: speaker.identity!.channel, externalId: speaker.identity!.externalId, displayName: speaker.displayName },
          }).catch((err) => { this.logger.warn(`Wyoming: saving the turn failed: ${err?.message ?? err}`); return null; })
          : null;
        const t0 = Date.now();
        const tools = makeToolCollector();
        const abort = new AbortController();
        const onClose = () => abort.abort();
        socket.once('close', onClose);
        let answer = '';
        let detached = false;
        // A detached turn's work, shown in its chat like a chat's run (step, tool) and stoppable there.
        let run: { chatId: string; runId: string } | null = null;
        let stopped = false;
        const runs = this.chatRuns;
        // The turn's end, whether the hub is still waiting (`handled`) or the work went on after it (detached).
        const finish = async (usage: Awaited<ReturnType<AgentService['streamResponse']>>): Promise<void> => {
          if (stopped) answer = answer ? `${answer}\n\n${stoppedWork(language)}` : stoppedWork(language);
          if (!focused) {
            window.messages.push({ role: 'user', content: text }, {
              id: randomUUID(), role: 'assistant', content: answer, ...(tools.records.length ? { toolCalls: tools.records as ToolCallRecord[] } : {}),
            });
            if (window.messages.length > CONVERSATION_MAX_MESSAGES) window.messages.splice(0, window.messages.length - CONVERSATION_MAX_MESSAGES);
            window.updatedAt = Date.now();
          }
          this.logger.log(`Wyoming: handled turn for ${ip} [${account.model} as ${account.userEmail}] (${text.length} → ${answer.length} chars, ${history.length} history, key ${key}, satellite ${satellite ?? '-'}${focused ? `, focused on chat ${focusedId}` : ''}${detached ? ', detached' : ''}) in ${Date.now() - t0}ms`);
          void this.invocations.record({
            userId, origin: 'voice', route: 'chat', model: `wyoming:${account.model}`,
            inputPreview: text, outputPreview: answer || null, toolCalls: tools.records,
            inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
            durationMs: Date.now() - t0, status: 'ok',
          });
          // Detached, the answer is delivered from its chat: the turn is saved even with persistence off.
          const chatId = await this.saveTurn(early, record || detached, {
            userId, source: 'wyoming', key, idleMs: CONVERSATION_TTL_MS,
            satellite, chatId: focused ? focusedId : null, notBefore: fresh,
            userText: text, answer, toolCalls: tools.records, usage,
          }, !detached);
          if (run) runs?.finish(run.chatId, run.runId, null);
          if (detached) await this.deliverDetached(userId, stopped ? stoppedWork(language) : answer, chatId, text);
          else {
            answered();
            this.send(socket, { type: 'handled', data: {
              text: answer, continue_conversation: expectsReply(answer), ...(context.conversation_id ? { context } : {}),
            } });
          }
          // A recognised person on a satellite that is not theirs: the turn into their own memory too (their choice).
          const owner = voice.kind === 'speaker' ? voice.speaker.userId : null;
          if (owner && owner !== userId) {
            void this.initiatives?.sharedTurn(owner, { conversation: `wyoming:${key}`, text, answer })
              .catch((err) => this.logger.warn(`Wyoming: the shared turn was not sent: ${err?.message ?? err}`));
          }
          // Someone spoke to that satellite: its room is lived in now (Home Assistant tells the memory). Detached, it
          // was said at the detach.
          if (!detached) this.voiceTurn(context, speaker, userId);
        };
        const failed = async (err: any): Promise<void> => {
          const message = err?.message ?? 'Internal error';
          this.logger.warn(`Wyoming: handle failed for ${ip} in ${Date.now() - t0}ms${detached ? ' (detached)' : ''}: ${message}`);
          void this.invocations.record({
            userId, origin: 'voice', route: 'chat', model: `wyoming:${account.model}`,
            inputPreview: text, outputPreview: answer || null, toolCalls: tools.records,
            durationMs: Date.now() - t0, status: 'error', error: abort.signal.aborted ? 'client aborted' : message,
          });
          if (!detached) {
            answered();
            this.send(socket, { type: 'not-handled', data: { text: spokenFailure(language) } });
            return;
          }
          // Detached: the user was told the work goes on — they hear (and read) that it did not end.
          if (run) runs?.finish(run.chatId, run.runId, null);
          const failure = stopped ? stoppedWork(language) : spokenFailure(language);
          const chatId = await this.saveTurn(early, true, {
            userId, source: 'wyoming', key, idleMs: CONVERSATION_TTL_MS,
            satellite, chatId: focused ? focusedId : null, notBefore: fresh,
            userText: text, answer: answer ? `${answer}\n\n${failure}` : failure, toolCalls: tools.records,
          }, false);
          await this.deliverDetached(userId, failure, chatId, text);
        };
        // Waiting for its answer (QUIET_WAIT_MS): until `handled`, `not-handled` or the detach.
        this.turnsInProgress++;
        let counted = true;
        const answered = () => { if (counted) { counted = false; this.turnsInProgress--; } };
        try {
          const running = this.agentService.streamResponse(
            text, userId, undefined, undefined, history,
            [], [], [],
            (chunk) => { answer += chunk; },
            (call: any) => {
              tools.onToolCall(call);
              if (run && call?.name) runs?.update(run.chatId, run.runId, { phase: 'tool', tool: call.name });
            },
            abort.signal,
            (name: string, result: any, status?: 'success' | 'error', input?: any) => {
              tools.onToolResult(name, result, status, input);
              if (run) runs?.toolDone(run.chatId, run.runId, { tool: name, ok: status !== 'error' });
            },
            {
              ...agentRunOptions(account.agentId ? await this.agentsService.findById(account.agentId).catch(() => null) : null, 'voice'),
              // The memory's conversation: the chat this turn continues (as recordTurn below groups it).
              conversationId: early ?? await this.externalChats.memoryConversationId({
                userId, source: 'wyoming', key, idleMs: CONVERSATION_TTL_MS, chatId: focused ? focusedId : null, notBefore: fresh,
              }),
              ...(turnBlocks.length ? { turnBlocks } : {}),
              onProgress: (event: AgentProgressEvent) => {
                if (!run) return;
                if (event.type === 'model_start') runs?.update(run.chatId, run.runId, { phase: 'model', tool: null, nextStep: true });
                else if (event.type === 'tool_preparing') runs?.update(run.chatId, run.runId, { phase: 'preparing', tool: event.name, argsChars: event.argsChars });
                else runs?.update(run.chatId, run.runId, { phase: 'writing', tool: null });
              },
            },
          );
          // A long turn (an app to write, a long search) does not hold the satellite: past detachMs() the hub hears that
          // the work goes on, and the answer comes when it is done — said where the user is, and in the chat.
          const wait = detachMs();
          if (wait > 0 && await Promise.race([
            running.then(() => false, () => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), wait).unref?.()),
          ])) {
            detached = true;
            answered();
            socket.off('close', onClose);   // the hub may hang up now: the work is no longer its request
            this.send(socket, { type: 'handled', data: {
              text: workingOn(language), continue_conversation: false, ...(context.conversation_id ? { context } : {}),
            } });
            this.voiceTurn(context, speaker, userId);
            // Its chat now (the user's words in it), and the work registered there: followed and stoppable in the app.
            early ??= await this.externalChats.recordUserMessage({
              userId, source: 'wyoming', key, idleMs: CONVERSATION_TTL_MS, satellite, chatId: focused ? focusedId : null, notBefore: fresh,
              userText: text,
              ...(speaker ? { speaker: { channel: speaker.identity!.channel, externalId: speaker.identity!.externalId, displayName: speaker.displayName } } : {}),
            }).catch((err) => { this.logger.warn(`Wyoming: saving the turn failed: ${err?.message ?? err}`); return null; });
            const started = early ? runs?.start(early) : null;
            if (early && started) {
              run = { chatId: early, runId: started.runId };
              runs?.update(run.chatId, run.runId, { phase: 'model', tool: null });
              started.signal.addEventListener('abort', () => { stopped = true; abort.abort(); });
            }
            running.then(finish, failed).catch((err) => this.logger.warn(`Wyoming: a detached turn's end failed: ${err?.message ?? err}`));
            return;
          }
          await finish(await running);
        } catch (err: any) {
          await failed(err);
        }
        return;
      }

      case 'synthesize': {
        const text  = String(ev.data?.text ?? '');
        const voice = typeof ev.data?.voice?.name === 'string' ? ev.data.voice.name : undefined;
        const t0 = Date.now();
        const wav = await withTraceUser(this.handle?.userId, () => this.tts.synthesize(text, voice, 'wav'));
        const { fmt, pcm } = parseWav(wav);
        // The satellite plays it now: no announcement over it (QUIET_WAIT_MS).
        this.speakingUntil = Math.max(this.speakingUntil, Date.now() + (pcm.length / (fmt.rate * fmt.width * fmt.channels)) * 1000 + VOICE_TAIL_MS);
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
    const ttsPrograms = tts.enabled && voices.length ? [{
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

/**
 * What the agent is told about the voice of the turn: who is speaking (recognised, may be wrong), or that a voice is
 * being learned (so it can say so in a few words). Unknown: nothing — but on an entity's account (`entity`: the account
 * and its memory are the assistant's own identity) that the speaker is not the account, so its name is never theirs.
 */
export function voiceBlocks(voice: VoiceTurnResult, entity = false): string[] {
  if (voice.kind === 'speaker') {
    const who = voice.speaker.holder ? `${voice.speaker.displayName} (the account's own user)` : voice.speaker.displayName;
    return [`<speaker>The person speaking is ${who}, recognised by their voice (it may be wrong: if what they say does not fit, do not insist on the name).</speaker>`];
  }
  if (voice.kind === 'enrolled') {
    const done = voice.samples >= voice.of;
    return [`<voice-learning>You are learning ${voice.name}'s voice: sample ${voice.samples} of ${voice.of}${done ? ' — done, from now on you recognise it' : ''}. Answer as usual and mention this in a few words.</voice-learning>`];
  }
  if (voice.kind === 'rejected') {
    const r = voice.rejection;
    const why = r.reason === 'short' ? 'it was too short to learn from'
      : r.reason === 'other' ? `it sounded like ${r.name}'s voice`
        : 'it did not sound like the samples taken so far (another person, or noise)';
    return [`<voice-learning>You are learning ${voice.name}'s voice: that sentence was not taken (${why}); ${voice.left} still to go. `
      + `Answer as usual and, in a few words, ask ${voice.name} to say another sentence of a few words, alone.</voice-learning>`];
  }
  if (entity) {
    return ['<speaker>Who is speaking was not recognised. This account and its memory are your own identity, not the speaker\'s: '
      + 'never call them by the account\'s name, nor write it as theirs (e.g. in an automation\'s instruction). Use no name unless they say who they are.</speaker>'];
  }
  return [];
}
