// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * e2e over real HTTP (Nest + Express, an async auth guard like the JWT one): the
 * page that sent a message disconnects in the middle of the agent's work. The agent
 * goes on and saves its answer; meanwhile GET /api/chats/:id/run shows the run, and
 * POST .../run/cancel is the only way to stop it. Several chats run at once.
 *
 * Guards against the old assumption that `req.on('close')` fires on a disconnect:
 * with an async guard and a parsed JSON body, `req` has already closed by the time
 * the handler runs, so that listener never fired (and no reload ever stopped a run).
 */
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { MessagesController } from '../../src/messages/messages.controller';
import { ChatRunsController } from '../../src/messages/chat-runs.controller';
import { ChatRunsService } from '../../src/messages/chat-runs.service';
import { MessagesService } from '../../src/messages/messages.service';
import { ChatsService } from '../../src/chats/chats.service';
import { AgentService } from '../../src/agent/agent.service';
import { MultiAgentService } from '../../src/agents/multi-agent.service';
import { FilesService } from '../../src/files/files.service';
import { UserMemoryService } from '../../src/user-memory/user-memory.service';
import { NotificationsGateway } from '../../src/notifications/notifications.gateway';

const CHAT = '22222222-2222-4222-8222-222222222222';
const CHAT_B = '33333333-3333-4333-8333-333333333333';
const CHAT_C = '44444444-4444-4444-8444-444444444444';
const saved: any[] = [];
let app: INestApplication;
let port: number;
// A skill output the fake tool reports (under the caller's skills-output subdir).
let outDir: string;
let reportPath: string;
const savedOutDir = process.env.SKILLS_OUTPUT_DIR;

/** Controls the fake agent per chat: it waits on its chat's gate after its first tool. */
function control() {
  const c = {
    gate: Promise.resolve(),
    release: () => {},
    started: Promise.resolve(),
    markStarted: () => {},
    signal: undefined as AbortSignal | undefined,
  };
  c.gate = new Promise<void>((r) => { c.release = r; });
  c.started = new Promise<void>((r) => { c.markStarted = r; });
  return c;
}
const controls = new Map<string, ReturnType<typeof control>>();
const reset = (chatId: string) => { const c = control(); controls.set(chatId, c); return c; };

const agent = {
  streamResponse: async (...args: any[]) => {
    const [input, , , chatId, , , , , onChunk, onToolCall, signal, onToolResult, opts] = args;
    const c = controls.get(chatId)!;
    c.signal = signal;
    opts?.onProgress?.({ type: 'model_start' });
    opts?.onProgress?.({ type: 'tool_preparing', name: 'archive', argsChars: 3000 });
    onToolCall({ name: 'archive', input: {} });
    onToolResult('archive', { saved: true, file: reportPath }, 'success');
    c.markStarted();
    await c.gate;
    if (signal.aborted) return null;
    onChunk(`Archived: ${input}`);
    return null;
  },
};

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'pa-run-e2e-'));
  mkdirSync(join(outDir, 'u1'));
  reportPath = join(outDir, 'u1', 'diary.pdf');
  writeFileSync(reportPath, 'pdf');
  process.env.SKILLS_OUTPUT_DIR = outDir;
  const moduleRef = await Test.createTestingModule({
    controllers: [MessagesController, ChatRunsController],
    providers: [
      ChatRunsService,
      { provide: NotificationsGateway, useValue: { emitToWatchers: vi.fn(), registerWatchable: vi.fn() } },
      { provide: MessagesService, useValue: {
        findByChat: async () => [],
        save: async (m: any) => { saved.push(m); return { ...m, id: `m${saved.length}` }; },
      } },
      { provide: ChatsService, useValue: {
        findOneForWrite: async (id: string) => ({ id, title: 'x', userId: 'u1', projectId: null, agentTeamId: null }),
        touch: async () => undefined,
        updateTitle: async () => undefined,
      } },
      { provide: AgentService, useValue: agent },
      { provide: MultiAgentService, useValue: {} },
      { provide: FilesService, useValue: { trackOutput: async () => 'file-e2e' } },
      { provide: UserMemoryService, useValue: { maybeExtractOnTurn: async () => [] } },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      // Async like the real JWT guard: the handler runs on a later tick.
      canActivate: async (ctx: any) => {
        await new Promise((r) => setTimeout(r, 5));
        ctx.switchToHttp().getRequest().user = { id: 'u1', role: 'user' };
        return true;
      },
    })
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(outDir, { recursive: true, force: true });
  process.env.SKILLS_OUTPUT_DIR = savedOutDir;
});

/** Opens the SSE stream of CHAT and resolves once its run has reached its first tool. */
function openStream(chat = CHAT, content = 'archive this long diary'): Promise<http.ClientRequest> {
  const c = controls.get(chat)!;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/chats/${chat}/messages/stream`,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      res.on('data', () => undefined);
      res.on('error', () => undefined);
      c.started.then(() => resolve(req));
    });
    req.on('error', () => undefined);
    req.once('error', reject);
    req.end(JSON.stringify({ content }));
  });
}

async function api(method: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: r.status, body: await r.json() };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a run that outlives its page', () => {
  it('goes on after the page disconnects, and is visible meanwhile', async () => {
    const ctl = reset(CHAT);
    saved.length = 0;
    const req = await openStream();

    const during = await api('GET', `/api/chats/${CHAT}/run`);
    expect(during.status).toBe(200);
    expect(during.body.run).toMatchObject({ chatId: CHAT, phase: 'tool', tool: 'archive', step: 1 });
    expect(during.body.run.recent).toEqual([expect.objectContaining({ tool: 'archive', ok: true })]);
    // The file the tool produced is downloadable before the answer exists.
    expect(during.body.run.files).toEqual([{ name: 'diary.pdf', fileId: 'file-e2e', downloadUrl: '/api/files/file-e2e/download' }]);

    req.destroy();                                  // the page reloads
    await new Promise((r) => setTimeout(r, 50));
    expect(ctl.signal!.aborted).toBe(false);
    ctl.release();

    await waitFor(() => saved.some((m) => m.role === 'assistant'));
    expect(saved.find((m) => m.role === 'assistant')).toMatchObject({
      content: 'Archived: archive this long diary',
      attachments: [expect.objectContaining({ fileId: 'file-e2e' })],
    });
    expect((await api('GET', `/api/chats/${CHAT}/run`)).body).toEqual({ run: null });
  });

  it('stops when cancelled', async () => {
    const ctl = reset(CHAT);
    saved.length = 0;
    const req = await openStream();
    expect((await api('POST', `/api/chats/${CHAT}/run/cancel`)).body).toEqual({ cancelled: true });
    expect(ctl.signal!.aborted).toBe(true);
    ctl.release();
    await waitFor(() => saved.some((m) => m.role === 'assistant'));
    expect((await api('GET', `/api/chats/${CHAT}/run`)).body).toEqual({ run: null });
    expect((await api('POST', `/api/chats/${CHAT}/run/cancel`)).body).toEqual({ cancelled: false });
    req.destroy();
  });

  it('runs several chats at once, each with its own state, stop and answer', async () => {
    const chats = [CHAT, CHAT_B, CHAT_C];
    const ctls = chats.map((c) => reset(c));
    saved.length = 0;
    const reqs = await Promise.all(chats.map((c, i) => openStream(c, `diary ${i}`)));

    // All three in progress at the same time, each visible on its own chat.
    for (const c of chats) {
      expect((await api('GET', `/api/chats/${c}/run`)).body.run).toMatchObject({ chatId: c, phase: 'tool', step: 1 });
    }
    const runIds = new Set(await Promise.all(chats.map(async (c) => (await api('GET', `/api/chats/${c}/run`)).body.run.runId)));
    expect(runIds.size).toBe(3);

    // A second message in a busy chat is refused; the runs are untouched.
    const busy = await fetch(`http://127.0.0.1:${port}/api/chats/${CHAT_C}/messages/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'again' }),
    }).then((r) => r.text());
    expect(busy).toContain('"code":"busy"');
    expect(saved.filter((m) => m.role === 'user')).toHaveLength(3);

    // Stopping one leaves the others going.
    expect((await api('POST', `/api/chats/${CHAT_B}/run/cancel`)).body).toEqual({ cancelled: true });
    expect(ctls.map((c) => c.signal!.aborted)).toEqual([false, true, false]);

    reqs[0].destroy();                              // the page of the first chat reloads
    ctls.forEach((c) => c.release());
    await waitFor(() => saved.filter((m) => m.role === 'assistant').length === 3);

    const answers = saved.filter((m) => m.role === 'assistant');
    expect(answers.find((m) => m.chatId === CHAT)).toMatchObject({ content: 'Archived: diary 0' });
    expect(answers.find((m) => m.chatId === CHAT_C)).toMatchObject({ content: 'Archived: diary 2' });
    expect(answers.find((m) => m.chatId === CHAT_B)!.content).not.toContain('Archived');   // stopped before answering
    for (const c of chats) expect((await api('GET', `/api/chats/${c}/run`)).body).toEqual({ run: null });
    reqs.forEach((r) => r.destroy());
  });

  it('rejects a chat id that is not a UUID', async () => {
    expect((await api('GET', '/api/chats/not-a-uuid/run')).status).toBe(400);
  });
});
