import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chat } from './chats.entity';
import { ProjectsService } from '../projects/projects.service';

@Injectable()
export class ChatsService {
  constructor(
    @InjectRepository(Chat) private readonly repo: Repository<Chat>,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * List chats with total input/output token count (aggregated in query).
   *
   * - With `projectId`: chats of THAT project from ALL members (project
   *   shared with the team) — subject to access check. Each chat carries
   *   `authorId`/`authorName` so the frontend distinguishes its own from those
   *   of colleagues (the latter read-only in v1).
   * - Without `projectId`: only the user's chats (global list in sidebar).
   */
  async findAllByUser(userId: string, projectId?: string) {
    const qb = this.repo.createQueryBuilder('chat')
      .leftJoin('messages', 'm', 'm."chatId" = chat.id')
      .leftJoin('users', 'u', 'u.id = chat."userId"')
      .addSelect('COALESCE(SUM(m."inputTokens"), 0)', 'inTok')
      .addSelect('COALESCE(SUM(m."outputTokens"), 0)', 'outTok')
      .addSelect('u.name', 'authorName')
      .groupBy('chat.id')
      .addGroupBy('u.id') // user PK: makes u.name a functional dependency (Postgres)
      .orderBy('chat."updatedAt"', 'DESC');

    if (projectId) {
      if (!(await this.projects.canAccess(projectId, userId))) throw new ForbiddenException();
      qb.where('chat."projectId" = :projectId', { projectId });
    } else {
      qb.where('chat."userId" = :userId', { userId });
    }

    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((chat, i) => ({
      ...chat,
      authorId:          chat.userId,
      authorName:        raw[i]?.authorName ?? null,
      totalInputTokens:  Number(raw[i]?.inTok)  || 0,
      totalOutputTokens: Number(raw[i]?.outTok) || 0,
    }));
  }

  /**
   * Read a chat: owner OR member of the project it belongs to.
   * Attaches `canWrite` (true for the author or for the project's
   * collaborators/owner) so the frontend knows whether to enable the composer.
   */
  async findOne(id: string, userId: string) {
    const chat = await this.repo.findOne({ where: { id }, relations: ['messages'] });
    if (!chat) throw new NotFoundException('chats.notFound');

    const isAuthor = chat.userId === userId;
    let canAccess = isAuthor;
    let canWrite = isAuthor;
    if (!isAuthor && chat.projectId) {
      const lvl = await this.projects.accessLevel(chat.projectId, userId);
      canAccess = lvl !== null;
      canWrite = lvl === 'owner' || lvl === 'collaborator';
    }
    if (!canAccess) throw new ForbiddenException();
    return { ...chat, canWrite };
  }

  /**
   * Write access to a chat (sending messages). Shared threads (Phase 3):
   * the author OR a collaborator/owner of the project the chat belongs to can
   * write. Viewers and non-members stay read-only.
   */
  async findOneForWrite(id: string, userId: string) {
    const chat = await this.repo.findOne({ where: { id } });
    if (!chat) throw new NotFoundException('chats.notFound');
    if (chat.userId === userId) return chat;
    if (chat.projectId && (await this.projects.canWrite(chat.projectId, userId))) return chat;
    throw new ForbiddenException();
  }

  /** Operations reserved to the chat author (rename/delete). */
  async findOneAsAuthor(id: string, userId: string) {
    const chat = await this.repo.findOne({ where: { id } });
    if (!chat) throw new NotFoundException('chats.notFound');
    if (chat.userId !== userId) throw new ForbiddenException();
    return chat;
  }

  async create(userId: string, data: Partial<Chat>) {
    // Creating a chat inside a shared project requires write access
    // (owner or collaborator); viewers cannot create chats.
    if (data.projectId && !(await this.projects.canWrite(data.projectId, userId))) {
      throw new ForbiddenException('chats.readonlyProject');
    }
    return this.repo.save(this.repo.create({ ...data, userId }));
  }

  /** Sets (or removes) the agent team that runs the chat. */
  async setAgentTeam(id: string, userId: string, agentTeamId: string | null) {
    const chat = await this.findOne(id, userId);
    chat.agentTeamId = agentTeamId;
    return this.repo.save(chat);
  }

  /** Marks the chat as read (clears `unread`). Read access is enough. */
  async markRead(id: string, userId: string) {
    await this.findOne(id, userId); // access check (owner or project member)
    await this.repo.update(id, { unread: false });
    return { ok: true };
  }

  async updateTitle(id: string, userId: string, title: string) {
    await this.findOneAsAuthor(id, userId);
    await this.repo.update(id, { title });
    return this.repo.findOne({ where: { id } });
  }

  async remove(id: string, userId: string) {
    await this.findOneAsAuthor(id, userId);
    await this.repo.delete(id);
    return { deleted: true };
  }

  async touch(id: string) {
    await this.repo.update(id, { updatedAt: new Date() });
  }

  /**
   * After a truncate/rewind, realign the markers pointing to message ids:
   *   - `summaryUpToMessageId` (history compaction)
   *   - `memoryUpToMessageId`  (user memory extraction)
   *
   * If the marked message was deleted, the marker is now invalid.
   * For the summary we clear it entirely (summary + tokens): since we cannot
   * "un-summarize" the removed messages, we let it regenerate from scratch on the
   * surviving turns. For memory it is enough to move the marker back: extraction
   * will re-analyze the remaining turns at the next trigger.
   */
  async clearStaleMarkers(chatId: string, deletedIds: string[]) {
    if (!deletedIds.length) return;
    const chat = await this.repo.findOne({ where: { id: chatId } });
    if (!chat) return;

    const patch: Partial<Chat> = {};
    if (chat.summaryUpToMessageId && deletedIds.includes(chat.summaryUpToMessageId)) {
      patch.summary = null;
      patch.summaryUpToMessageId = null;
      patch.summaryTokens = null;
    }
    if (chat.memoryUpToMessageId && deletedIds.includes(chat.memoryUpToMessageId)) {
      patch.memoryUpToMessageId = null;
    }
    if (Object.keys(patch).length) await this.repo.update(chatId, patch);
  }
}
