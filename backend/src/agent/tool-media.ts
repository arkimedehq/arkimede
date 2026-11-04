// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file tool-media.ts
 *
 * Shows the model the content of the files tools returned (files/tool-files.ts).
 *
 * The files go in a user message right after the tool results that returned
 * them, not inside the tool results: that is the one place every provider
 * accepts images (OpenAI Chat Completions and DeepSeek take them in user
 * messages only; Anthropic and Gemini take them there too). The message is
 * built for each model call only — never stored in the conversation — so a
 * chat's history keeps the files' reference lines, not their bytes.
 *
 * Per file:
 *   image  → the image itself, if the model sees images; else a description by
 *            the designated vision model, if there is one; else nothing more
 *            than the reference line the tool already gave;
 *   audio  → its transcript (the speech-to-text service);
 *   text   → its text, if small;
 *   other  → nothing (a video, an archive: the model knows it by its line).
 */
import * as fs from 'fs';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ToolFile, formatSize, toolFilesOf } from '../files/tool-files';

export interface ToolMediaOptions {
  /** The model accepts images (it is the designated vision model). */
  seesImages: boolean;
  /** Describes an image with the vision model (when the model itself does not see images). */
  describeImage?: (file: ToolFile, base64: string) => Promise<string>;
  /** Transcribes speech. */
  transcribe?: (file: ToolFile, data: Buffer) => Promise<string>;
  /** Most images shown in one model call (the most recent ones win). */
  maxImages?: number;
  maxImageBytes?: number;
  maxAudioBytes?: number;
  maxTextChars?: number;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_TYPES  = /^(text\/|application\/(json|xml|x-yaml|yaml|csv)$)/;

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * A `messageModifier` for createReactAgent: the system prompt first, then the
 * messages, with one user message of file content after each run of tool
 * results that returned files. Descriptions and transcripts are cached for the
 * life of the modifier (one agent run), so a run's later model calls reuse them.
 */
export function toolMediaModifier(
  system: string | SystemMessage,
  opts: ToolMediaOptions,
): (messages: BaseMessage[]) => Promise<BaseMessage[]> {
  const systemMessage = typeof system === 'string' ? new SystemMessage(system) : system;
  const cache = new Map<string, Promise<Part[]>>();
  const maxImages = opts.maxImages ?? 8;

  return async (messages: BaseMessage[]) => {
    // Runs of consecutive tool messages; the message goes after the last of each.
    const runs: { end: number; files: ToolFile[] }[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]._getType() !== 'tool') continue;
      const files = toolFilesOf(messages[i]);
      const last = runs[runs.length - 1];
      if (last && last.end === i - 1) {
        last.end = i;
        last.files.push(...files);
      } else {
        runs.push({ end: i, files: [...files] });
      }
    }
    const withFiles = runs.filter((r) => r.files.length);
    if (!withFiles.length) return [systemMessage, ...messages];

    // The image budget goes to the most recent files first.
    let imagesLeft = maxImages;
    const partsByRun = new Map<number, Part[]>();
    for (const run of [...withFiles].reverse()) {
      const parts: Part[] = [];
      for (const file of run.files) {
        const isImage = IMAGE_TYPES.has(file.mimeType);
        if (isImage && opts.seesImages) {
          if (imagesLeft <= 0) continue;
          imagesLeft--;
        }
        parts.push(...await partsFor(file, opts, cache));
      }
      if (parts.length) partsByRun.set(run.end, parts);
    }

    const out: BaseMessage[] = [systemMessage];
    messages.forEach((m, i) => {
      out.push(m);
      const parts = partsByRun.get(i);
      if (parts) {
        out.push(new HumanMessage({
          content: [
            { type: 'text', text: 'Content of the files the tool calls above returned (added by the system, not written by the user):' },
            ...parts,
          ] as any,
        }));
      }
    });
    return out;
  };
}

function partsFor(file: ToolFile, opts: ToolMediaOptions, cache: Map<string, Promise<Part[]>>): Promise<Part[]> {
  const key = `${file.fileId}:${opts.seesImages ? 'see' : 'text'}`;
  let parts = cache.get(key);
  if (!parts) {
    parts = buildParts(file, opts).catch((err: any) => [
      { type: 'text' as const, text: `${label(file)}: could not be read (${err?.message ?? err}).` },
    ]);
    cache.set(key, parts);
  }
  return parts;
}

async function buildParts(file: ToolFile, opts: ToolMediaOptions): Promise<Part[]> {
  const maxImageBytes = opts.maxImageBytes ?? 5 * 1024 * 1024;
  const maxAudioBytes = opts.maxAudioBytes ?? 25 * 1024 * 1024;
  const maxTextChars  = opts.maxTextChars ?? 20_000;

  if (IMAGE_TYPES.has(file.mimeType)) {
    if (!opts.seesImages && !opts.describeImage) return [];
    if (file.size > maxImageBytes) {
      return [{ type: 'text', text: `${label(file)}: too large to be shown (${formatSize(file.size)}).` }];
    }
    const base64 = (await fs.promises.readFile(file.path)).toString('base64');
    if (opts.seesImages) {
      return [
        { type: 'text', text: `${label(file)}:` },
        { type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${base64}` } },
      ];
    }
    const description = await opts.describeImage!(file, base64);
    return [{ type: 'text', text: `${label(file)}, as the vision model describes it: ${description.trim()}` }];
  }

  if (file.mimeType.startsWith('audio/')) {
    if (!opts.transcribe) return [];
    if (file.size > maxAudioBytes) {
      return [{ type: 'text', text: `${label(file)}: too long to be transcribed (${formatSize(file.size)}).` }];
    }
    const transcript = (await opts.transcribe(file, await fs.promises.readFile(file.path))).trim();
    return [{ type: 'text', text: `${label(file)}, transcript: ${transcript || '(no speech)'}` }];
  }

  if (TEXT_TYPES.test(file.mimeType)) {
    const text = (await fs.promises.readFile(file.path, 'utf8'));
    const cut = text.length > maxTextChars ? `${text.slice(0, maxTextChars)}… [truncated]` : text;
    return [{ type: 'text', text: `${label(file)}:\n${cut}` }];
  }

  return [];
}

function label(file: ToolFile): string {
  return `File ${file.name} (file_id ${file.fileId})`;
}
