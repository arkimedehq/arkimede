// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file tool-files.ts
 *
 * Files returned by tools (MCP image/audio/resource blocks, …). A tool stores
 * each one as a File (FilesService.saveToolFile) and returns, LangChain
 * `content_and_artifact` style:
 *   - content  → text for the model, one reference line per file (its id, so the
 *                model can pass it to any `file-ref` parameter, e.g. "send it on
 *                Telegram", and a download link the chat turns into an attachment);
 *   - artifact → `{ toolFiles: ToolFile[] }`, read before each model call to show
 *                the model the files' content (agent/tool-media.ts).
 * Nothing binary goes into the text: big files (a video) cost the model one line.
 */
import type { BaseMessage } from '@langchain/core/messages';

export interface ToolFile {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  /** Absolute path on disk (read when the model is shown the content). */
  path: string;
}

export interface ToolFilesArtifact {
  toolFiles: ToolFile[];
}

/** Human-readable size: 812 B, 84 KB, 3.2 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line the model reads for one file. */
export function toolFileLine(f: ToolFile): string {
  return `[file] ${f.name} (${f.mimeType}, ${formatSize(f.size)}) — file_id: ${f.fileId} — `
    + `download: /api/files/${f.fileId}/download`;
}

/** The files a ToolMessage carries in its artifact (none for ordinary tools). */
export function toolFilesOf(message: BaseMessage): ToolFile[] {
  const artifact = (message as any)?.artifact;
  const files = artifact && Array.isArray(artifact.toolFiles) ? artifact.toolFiles : [];
  return files.filter((f: any) => f && typeof f.fileId === 'string' && typeof f.path === 'string');
}
