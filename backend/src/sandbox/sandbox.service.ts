/**
 * @file sandbox.service.ts
 *
 * "sandbox" capability: exposes to the agent the `run_in_sandbox` tool, which runs
 * arbitrary code/shell written by the model in a locked-down ephemeral container
 * (persistent per-chat workspace). It is the most powerful capability in the system,
 * so it lives behind a gate (see `isEnabledFor`).
 *
 * Presence model: "built-in per-request" class (like schedule_task) — when
 * enabled it is ALWAYS available (bypasses RAG selection), but only for those
 * authorized by the gate. The actual execution is delegated to the skill-executor (/sandbox),
 * which in turn goes through the broker (hardened container-job) in production.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolve } from 'path';
import { AppConfigService } from '../app-config/app-config.service';
import { TeamsService } from '../teams/teams.service';
import { SkillExecutorClient } from '../skills/skill-executor.client';
import { SkillsService } from '../skills/skills.service';
import { FilesService } from '../files/files.service';
import { Message } from '../messages/messages.entity';
import { mintRunToken } from '../common/internal-token/internal-token';
import { RUN_IN_SANDBOX_DESC } from '../prompts/prompts';

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly teams:     TeamsService,
    private readonly executor:  SkillExecutorClient,
    private readonly skills:    SkillsService,
    private readonly files:     FilesService,
    @InjectRepository(Message) private readonly messagesRepo: Repository<Message>,
  ) {}

  /**
   * Attachments of the chat (all turns) resolved to host paths, for staging into
   * `inputs/` in the workspace. ACL via FilesService (unreadable files are skipped);
   * on duplicate names the most recent upload wins.
   */
  private async collectChatAttachments(chatId: string | undefined, userId: string): Promise<{ name: string; hostPath: string }[]> {
    if (!chatId) return [];
    const msgs = await this.messagesRepo.find({
      where: { chatId }, select: ['attachments'], order: { createdAt: 'ASC' },
    });
    const byName = new Map<string, string>(); // name → fileId (later messages overwrite)
    for (const m of msgs) {
      for (const att of m.attachments ?? []) {
        if (att?.name && att?.fileId) byName.set(att.name, att.fileId);
      }
    }
    const out: { name: string; hostPath: string }[] = [];
    for (const [name, fileId] of byName) {
      try {
        const file = await this.files.findOneReadable(fileId, userId);
        out.push({ name, hostPath: resolve(file.storagePath) });
      } catch { /* deleted or not accessible → skip */ }
    }
    return out;
  }

  /**
   * Gate (scope b): global master switch in app_config, then authorization:
   * admin always; otherwise the chat's project or one of the user's teams must
   * be in the allowlist. Fail-closed: if the flag is off, no one passes.
   */
  async isEnabledFor(userId: string, projectId?: string, isAdmin = false): Promise<boolean> {
    const cfg = await this.appConfig.getSandboxConfig();
    if (!cfg.sandboxEnabled) return false;
    if (isAdmin) return true;
    if (projectId && cfg.sandboxAllowedProjectIds.includes(projectId)) return true;
    if (cfg.sandboxAllowedTeamIds.length) {
      const userTeams = await this.teams.teamIdsForUser(userId);
      if (userTeams.some((t) => cfg.sandboxAllowedTeamIds.includes(t))) return true;
    }
    return false;
  }

  /**
   * Builds the `run_in_sandbox` tool bound to the current session (chat).
   * The workspace is persistent per-chat: files written in one turn remain
   * available in the subsequent turns of the same conversation.
   */
  buildSandboxTools(userId: string, projectId: string | undefined, chatId: string | undefined): DynamicStructuredTool[] {
    // session = chat; without a chat (e.g. headless run) uses a per-user session.
    const sessionId = chatId ?? `user-${userId}`;

    const tool = new DynamicStructuredTool({
      name: 'run_in_sandbox',
      description: RUN_IN_SANDBOX_DESC,
      schema: z.object({
        language: z.enum(['python', 'node', 'shell']).describe('Language: "python", "node" (JS) or "shell" (bash).'),
        code: z.string().describe('Code or command to execute. The working dir is the chat\'s persistent workspace: use relative paths.'),
      }),
      func: async (args: { language: 'python' | 'node' | 'shell'; code: string }): Promise<string> => {
        try {
          // Network tier + execution profile decided by the admin, read at runtime.
          const { sandboxNetwork, sandboxExecMode } = await this.appConfig.getSandboxConfig();
          // Accessible descriptive skills → staged in /workspace/skills/<name>/.
          const skills = await this.skills.listDescriptiveSkillDirs(userId, projectId);
          // Chat attachments → staged in inputs/ in the workspace (ACL-checked).
          const attachments = await this.collectChatAttachments(chatId, userId);
          const res = await this.executor.runSandbox({
            session_id: sessionId,
            language:   args.language,
            code:       args.code,
            user_id:    userId,
            run_token:  mintRunToken(userId, 300_000),
            network:    sandboxNetwork,
            exec_mode:  sandboxExecMode,
            ...(skills.length ? { skills } : {}),
            ...(attachments.length ? { attachments } : {}),
          });

          // Attribution for the compile-to-tool suggestion: a successful run whose
          // code references `skills/<name>/` counts as a use of that descriptive
          // skill (same sanitized name used by the executor's staging).
          if (res.exit_code === 0 && skills.length) {
            const used = skills
              .filter((sk) => args.code.includes(`skills/${sk.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}/`))
              .map((sk) => sk.name);
            if (used.length) void this.skills.recordSandboxUse(used);
          }

          const parts: string[] = [];
          if (res.stdout?.trim()) parts.push(`stdout:\n${res.stdout.slice(0, 8000)}`);
          if (res.stderr?.trim()) parts.push(`stderr:\n${res.stderr.slice(0, 4000)}`);
          parts.push(`exit_code: ${res.exit_code}`);
          // Declared transparency: the dev in-process mode runs WITHOUT isolation
          // (deliberate choice, full host access). Visible in the chat panel too.
          if (res.isolated === false) parts.push('[⚠ in-process execution (dev): NOT isolated]');
          if (res.files?.length) parts.push(`files in the workspace: ${res.files.join(', ')}`);
          // Deliverables copied to SKILLS_OUTPUT_DIR → tracked as downloadable files and
          // surfaced in the chat/project file panel. The backend builds the canonical
          // `?rel=` links (owner-confined) so they don't depend on what the code printed.
          if (res.outputs?.length) {
            const links = res.outputs
              .map((f) => `- ${f}: /api/files/raw?rel=${encodeURIComponent(f)}`)
              .join('\n');
            parts.push(`deliverables (downloadable — give the user these Markdown links):\n${links}`);
          }
          return parts.join('\n\n') || '(no output)';
        } catch (err: any) {
          this.logger.warn(`run_in_sandbox failed (session=${sessionId}): ${err?.message ?? err}`);
          return `Sandbox not available: ${err?.message ?? err}`;
        }
      },
    });

    return [tool];
  }
}
