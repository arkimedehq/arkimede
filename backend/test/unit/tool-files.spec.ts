// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Files returned by tools: MCP image/audio/resource/resource_link blocks become
 * Files (an id the model can pass on, a reference line, an artifact), and the
 * agent's message modifier shows the model their content after the tool results
 * — images as images (vision model), else described; audio as a transcript.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { McpServersService } from '../../src/mcp-servers/mcp-servers.service';
import { toolMediaModifier } from '../../src/agent/tool-media';
import { ToolFile } from '../../src/files/tool-files';
import { FilesService } from '../../src/files/files.service';

const dir = fs.mkdtempSync(join(os.tmpdir(), 'tool-files-'));
let n = 0;

function makeService() {
  const svc: any = Object.create(McpServersService.prototype);
  svc.logger = { log() {}, debug() {}, warn() {}, error() {} };
  svc.files = {
    saveToolFile: vi.fn(async (_u: string, name: string, mimeType: string, data: Buffer) => {
      const id = `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
      const storagePath = join(dir, `${id}-${name}`);
      fs.writeFileSync(storagePath, data);
      return { id, originalName: name, mimeType, size: data.length, storagePath };
    }),
  };
  return svc;
}

const png = Buffer.from('fake-png');
const wav = Buffer.from('fake-wav');

describe('MCP content blocks → tool files', () => {
  it('text passes through; image and audio become files with reference lines and an artifact', async () => {
    const svc = makeService();
    const raw = JSON.stringify({ content: [
      { type: 'text', text: 'Camera garden, 3 frames' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'audio', data: wav.toString('base64'), mimeType: 'audio/wav' },
    ] });
    const [text, artifact] = await svc.sanitizeMcpResult(raw, 'u1');
    expect(text.split('\n')[0]).toBe('Camera garden, 3 frames');
    expect(artifact.toolFiles).toHaveLength(2);
    const [img, audio] = artifact.toolFiles;
    expect(img).toMatchObject({ mimeType: 'image/jpeg', size: png.length });
    expect(img.name).toMatch(/^image-\d+\.jpg$/);
    expect(audio.name).toMatch(/^audio-\d+\.wav$/);
    expect(text).toContain(`file_id: ${img.fileId} — download: /api/files/${img.fileId}/download`);
    expect(text).toContain(`file_id: ${audio.fileId}`);
    expect(text).not.toContain(png.toString('base64'));
  });

  it('embedded resource: text inline, blob stored under the name of its URI', async () => {
    const svc = makeService();
    const [text, artifact] = await svc.sanitizeMcpResult(JSON.stringify({ content: [
      { type: 'resource', resource: { uri: 'file:///notes/today.txt', mimeType: 'text/plain', text: 'buy milk' } },
      { type: 'resource', resource: { uri: 'http://nas/trip/japan.mp4', mimeType: 'video/mp4', blob: png.toString('base64') } },
    ] }), 'u1');
    expect(text).toContain('### file:///notes/today.txt\nbuy milk');
    expect(artifact.toolFiles.map((f: ToolFile) => f.name)).toEqual(['japan.mp4']);
  });

  it('resource_link: fetched and stored when the transport can, else named with its URI', async () => {
    const svc = makeService();
    const link = { type: 'resource_link', uri: 'http://panel/files/clip.mp4', name: 'clip.mp4', mimeType: 'video/mp4' };
    const fetched = await svc.sanitizeMcpResult(JSON.stringify({ content: [link] }), 'u1',
      vi.fn(async () => ({ data: png, mimeType: 'video/mp4' })));
    expect(fetched[1].toolFiles[0]).toMatchObject({ name: 'clip.mp4', mimeType: 'video/mp4', size: png.length });

    const plain = await svc.sanitizeMcpResult(JSON.stringify({ content: [link] }), 'u1');
    expect(plain[0]).toBe('[link] clip.mp4 (video/mp4) — http://panel/files/clip.mp4');
    expect(plain[1].toolFiles).toEqual([]);
  });

  it('long text is capped but the file lines survive the cap', async () => {
    const svc = makeService();
    const [text, artifact] = await svc.sanitizeMcpResult(JSON.stringify({ content: [
      { type: 'text', text: 'word '.repeat(6_000) },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ] }), 'u1');
    expect(text).toContain('[truncated');
    expect(text.endsWith(`download: /api/files/${artifact.toolFiles[0].fileId}/download`)).toBe(true);
  });

  it('no file service → files are only named, nothing breaks', async () => {
    const svc = makeService();
    svc.files = null;
    const [text, artifact] = await svc.sanitizeMcpResult(JSON.stringify({ content: [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ] }), 'u1');
    expect(text).toMatch(/^\[file omitted: image-\d+\.png \(image\/png\)\]$/);
    expect(artifact.toolFiles).toEqual([]);
  });

  it('plain text and foreign JSON with its own `content` pass through (unchanged)', async () => {
    const svc = makeService();
    expect((await svc.sanitizeMcpResult('hello', 'u1'))[0]).toBe('hello');
    const own = JSON.stringify({ content: [{ id: 1, title: 'row' }] });
    expect((await svc.sanitizeMcpResult(own, 'u1'))[0]).toBe(own);
  });
});

function file(name: string, mimeType: string, data: Buffer): ToolFile {
  const path = join(dir, `m-${name}`);
  fs.writeFileSync(path, data);
  return { fileId: `id-${name}`, name, mimeType, size: data.length, path };
}

function conversation(files: ToolFile[]) {
  return [
    new HumanMessage('who is in the garden?'),
    new AIMessage({ content: '', tool_calls: [
      { id: 'c1', name: 'look', args: {} }, { id: 'c2', name: 'other', args: {} },
    ] }),
    new ToolMessage({ content: 'frames', tool_call_id: 'c1', artifact: { toolFiles: files } }),
    new ToolMessage({ content: 'ok', tool_call_id: 'c2' }),
  ];
}

describe('toolMediaModifier', () => {
  it('no files → system prompt + the messages, unchanged', async () => {
    const msgs = [new HumanMessage('hi')];
    const out = await toolMediaModifier('SYS', { seesImages: true })(msgs);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(out[0].content).toBe('SYS');
    expect(out[1]).toBe(msgs[0]);
  });

  it('vision model: the images go in a user message after the last tool result of the run', async () => {
    const img = file('a.jpg', 'image/jpeg', png);
    const out = await toolMediaModifier('SYS', { seesImages: true })(conversation([img]));
    expect(out.map((m) => m._getType())).toEqual(['system', 'human', 'ai', 'tool', 'tool', 'human']);
    const parts = out[5].content as any[];
    expect(parts[0].text).toContain('added by the system, not written by the user');
    expect(parts.find((p) => p.type === 'image_url').image_url.url).toBe(`data:image/jpeg;base64,${png.toString('base64')}`);
  });

  it('model without vision: the vision model describes the image, once per run', async () => {
    const img = file('b.png', 'image/png', png);
    const describeImage = vi.fn(async () => 'A man at the gate.');
    const modify = toolMediaModifier(new SystemMessage('SYS'), { seesImages: false, describeImage });
    const out = await modify(conversation([img]));
    await modify(conversation([img]));
    expect(describeImage).toHaveBeenCalledTimes(1);
    const parts = out[5].content as any[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    expect(parts[1].text).toBe('File b.png (file_id id-b.png), as the vision model describes it: A man at the gate.');
  });

  it('no vision anywhere: images add nothing (the reference line is enough)', async () => {
    const out = await toolMediaModifier('SYS', { seesImages: false })(conversation([file('c.png', 'image/png', png)]));
    expect(out).toHaveLength(5);
  });

  it('audio is transcribed; a video adds nothing', async () => {
    const transcribe = vi.fn(async () => 'hello there');
    const out = await toolMediaModifier('SYS', { seesImages: true, transcribe })(conversation([
      file('d.wav', 'audio/wav', wav), file('e.mp4', 'video/mp4', png),
    ]));
    const parts = out[5].content as any[];
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toBe('File d.wav (file_id id-d.wav), transcript: hello there');
  });

  it('the image budget keeps the most recent images', async () => {
    const imgs = [1, 2, 3].map((i) => file(`f${i}.png`, 'image/png', png));
    const out = await toolMediaModifier('SYS', { seesImages: true, maxImages: 2 })(conversation(imgs));
    const images = (out[5].content as any[]).filter((p) => p.type === 'image_url');
    expect(images).toHaveLength(2);
  });

  it('an unreadable file is reported, not thrown', async () => {
    const gone: ToolFile = { fileId: 'x', name: 'gone.png', mimeType: 'image/png', size: 3, path: join(dir, 'nope.png') };
    const out = await toolMediaModifier('SYS', { seesImages: true })(conversation([gone]));
    expect((out[5].content as any[])[1].text).toContain('could not be read');
  });
});

/**
 * Cross-provider: the modifier's output (tool results, then a user message with
 * the image) must convert into a valid payload on every provider's real
 * converter — the image in a user turn, every tool call paired with its result.
 */
import { createRequire } from 'node:module';
const requireDist = createRequire(import.meta.url);
const dep = (rel: string) => requireDist(join(process.cwd(), 'node_modules', rel));
const { _convertMessagesToAnthropicPayload } = dep('@langchain/anthropic/dist/utils/message_inputs.js');
const { convertMessagesToCompletionsMessageParams } = dep('@langchain/openai/dist/converters/completions.js');
const { convertToOllamaMessages } = dep('@langchain/ollama/dist/utils.js');
const { convertBaseMessagesToContent } = dep('@langchain/google-genai/dist/utils/common.js');

describe('tool media across providers', async () => {
  const img = file('p.jpg', 'image/jpeg', png);
  const modified = await toolMediaModifier('SYS', { seesImages: true })(conversation([img]));
  const chat = modified.slice(1); // the system message is handled apart by each provider

  it('OpenAI-compatible (OpenAI, DeepSeek, LM Studio): tool results then a user message with image_url', () => {
    const out = convertMessagesToCompletionsMessageParams({ messages: modified, model: 'gpt-4o' });
    expect(out.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(out[5].content.some((p: any) => p.type === 'image_url')).toBe(true);
  });

  it('Anthropic: tool_results and the image in user turns, every tool_use paired', () => {
    const payload = _convertMessagesToAnthropicPayload(modified);
    const blocks = payload.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []).map((b: any) => ({ role: m.role, type: b.type })));
    const uses = blocks.filter((b: any) => b.type === 'tool_use').length;
    const results = blocks.filter((b: any) => b.type === 'tool_result');
    expect(results).toHaveLength(uses);
    expect(results.every((b: any) => b.role === 'user')).toBe(true);
    expect(blocks.find((b: any) => b.type === 'image')?.role).toBe('user');
  });

  it('Ollama: the image travels in a user message', () => {
    const out = convertToOllamaMessages(chat);
    const withImage = out.find((m: any) => m.images?.length);
    expect(withImage?.role).toBe('user');
  });

  it('Gemini: function responses, then the image as inline data in a user turn', () => {
    const contents = convertBaseMessagesToContent(chat, true, false, 'gemini-2.5-flash');
    const parts = contents.flatMap((c: any) => c.parts.map((p: any) => ({ role: c.role, keys: Object.keys(p) })));
    expect(parts.filter((p: any) => p.keys.includes('functionResponse'))).toHaveLength(2);
    expect(parts.find((p: any) => p.keys.includes('inlineData'))?.role).toBe('user');
  });
});

describe('file-ref accepts a file link', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const svc: any = Object.create(FilesService.prototype);
  svc.findOneReadable = vi.fn(async (fid: string) =>
    fid === id ? { id, originalName: 'snap shot.jpg', storagePath: '/up/tool-files/x.jpg' } : null);

  it.each([
    id,
    `/api/files/${id}/download`,
    `/api/files/${id}`,
    `http://host:5173/api/files/${id}/download?rel=1`,
  ])('%s → the file', async (ref) => {
    expect(await svc.resolveFileRef(ref, 'u1')).toEqual({ hostPath: '/up/tool-files/x.jpg', name: 'snap_shot.jpg' });
    expect(svc.findOneReadable).toHaveBeenLastCalledWith(id, 'u1');
  });

  it('another absolute path is still refused', async () => {
    expect(await svc.resolveFileRef(`/api/other/${id}`, 'u1')).toBeNull();
  });
});
