import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Message } from './messages.entity';

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message) private readonly repo: Repository<Message>,
  ) {}

  async findByChat(chatId: string) {
    // Enriches each message with the author's name (useful in shared chats
    // where multiple collaborators write). authorName=null for assistant/system.
    const qb = this.repo.createQueryBuilder('m')
      .leftJoin('users', 'u', 'u.id = m."authorId"')
      .addSelect('u.name', 'authorName')
      .where('m."chatId" = :chatId', { chatId })
      .orderBy('m."createdAt"', 'ASC');
    const { entities, raw } = await qb.getRawAndEntities();
    return entities.map((m, i) => ({ ...m, authorName: raw[i]?.authorName ?? null }));
  }

  save(data: Partial<Message>) {
    return this.repo.save(this.repo.create(data));
  }

  /**
   * Truncate/rewind: deletes the given message and ALL subsequent ones
   * in the same chat. "Rewind from here" semantics: the only safe deletion,
   * because it leaves no orphaned turns and does not break the
   * tool_use → tool_result invariant used in history reconstruction.
   *
   * The order is the chat's canonical one (createdAt ASC, id as deterministic
   * tiebreak). Cascade deletion covers the linked feedback
   * (message_feedback has onDelete CASCADE).
   *
   * @returns the deleted ids (to reconcile the summary/memory markers on Chat).
   */
  async truncateFrom(chatId: string, messageId: string): Promise<string[]> {
    const msgs = await this.repo.find({
      where: { chatId },
      order: { createdAt: 'ASC', id: 'ASC' },
      select: { id: true },
    });
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new NotFoundException('messages.notFound');

    const toDelete = msgs.slice(idx).map((m) => m.id);
    await this.repo.delete({ id: In(toDelete) });
    return toDelete;
  }
}
