import {
  Injectable, Logger, Inject, Optional,
  BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Feedback, FeedbackRating, FeedbackScope } from './feedback.entity';
import { Message } from '../messages/messages.entity';
import { ChatsService } from '../chats/chats.service';
import { AppConfigService } from '../app-config/app-config.service';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { VectorStoreProviderService } from '../vector-db/vector-store-provider.service';

/** Vector collection dedicated to the feedback-memory. */
const FEEDBACK_COLLECTION = 'feedback_memory';
/** Minimum similarity score to inject a feedback into the prompt (cuts the noise). */
const MIN_SCORE = 0.35;
/** Maximum length of the saved answer snippet. */
const ANSWER_SNIPPET = 1000;

export interface CreateFeedbackDto {
  messageId: string;
  rating:    FeedbackRating;
  comment?:  string;
  scope?:    FeedbackScope;
}

/** Retrieved memory entry, ready for injection into the system prompt. */
export interface FeedbackMemoryHit {
  rating:   FeedbackRating;
  question: string;
  comment:  string;
  score:    number;
}

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    @InjectRepository(Feedback) private readonly repo: Repository<Feedback>,
    @InjectRepository(Message)  private readonly messageRepo: Repository<Message>,
    @Inject(ChatsService)       private readonly chats: ChatsService,
    @Inject(AppConfigService)   private readonly appConfig: AppConfigService,
    @Optional() @Inject(EmbeddingProviderService) private readonly embedding: EmbeddingProviderService | null,
    @Optional() @Inject(VectorStoreProviderService) private readonly vectorStore: VectorStoreProviderService | null,
  ) {}

  // ── Config / toggle ─────────────────────────────────────────────────────────

  async getConfig(): Promise<{ enabled: boolean; vectorAvailable: boolean }> {
    const enabled = await this.appConfig.getFeedbackMemoryEnabled();
    let vectorAvailable = false;
    if (this.vectorStore) {
      try { await this.vectorStore.getAdapter(); vectorAvailable = true; }
      catch { vectorAvailable = false; }
    }
    return { enabled, vectorAvailable };
  }

  /** Enables/disables the memory. On activation it creates the vector collection. */
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; vectorAvailable: boolean }> {
    if (enabled) {
      if (!this.vectorStore || !this.embedding) {
        throw new BadRequestException('feedback.memoryNotAvailable');
      }
      try {
        await this.vectorStore.ensureCollection(FEEDBACK_COLLECTION, this.embedding.vectorSize);
      } catch (err: any) {
        throw new BadRequestException(
          I18nContext.current()?.t('feedback.collectionCreateFailed', { args: { collection: FEEDBACK_COLLECTION, error: err?.message ?? err } }) ??
          `Unable to create collection '${FEEDBACK_COLLECTION}': ${err?.message ?? err}. Check the vector DB configuration.`,
        );
      }
    }
    await this.appConfig.setFeedbackMemoryEnabled(enabled);
    return this.getConfig();
  }

  // ── Feedback creation / update ──────────────────────────────────────

  async createOrUpdate(userId: string, dto: CreateFeedbackDto): Promise<Feedback> {
    const message = await this.messageRepo.findOne({ where: { id: dto.messageId } });
    if (!message) throw new NotFoundException('feedback.messageNotFound');

    // Authz: the caller must be able to access the chat the message belongs to.
    // Without this, any user could read another tenant's prompt/answer by iterating
    // messageIds (the feedback stores question/answer snippets and returns them).
    await this.chats.findOne(message.chatId, userId);

    // Question = last user message preceding the rated answer (same chat)
    const prevUser = await this.messageRepo.findOne({
      where: { chatId: message.chatId, role: 'user', createdAt: LessThan(message.createdAt) },
      order: { createdAt: 'DESC' },
    });

    let feedback = await this.repo.findOne({ where: { messageId: dto.messageId, userId } });
    if (!feedback) {
      feedback = this.repo.create({ messageId: dto.messageId, userId, scope: 'personal', isApproved: false });
    }
    feedback.rating   = dto.rating;
    feedback.comment  = dto.comment?.trim() || null;
    feedback.question = prevUser?.content ?? null;
    feedback.answer   = (message.content ?? '').slice(0, ANSWER_SNIPPET);
    if (dto.scope) feedback.scope = dto.scope;
    feedback = await this.repo.save(feedback);

    await this.syncVector(feedback);
    return feedback;
  }

  // ── Vectorization ─────────────────────────────────────────────────────────

  /** Aligns the vector point to the feedback state (upsert or delete). */
  private async syncVector(feedback: Feedback): Promise<void> {
    const enabled = await this.appConfig.getFeedbackMemoryEnabled();
    const hasMemoryContent = !!feedback.comment?.trim();

    // No active memory / no correction / no vector store → remove any existing point
    if (!enabled || !hasMemoryContent || !this.vectorStore || !this.embedding) {
      if (feedback.vectorId && this.vectorStore) {
        await this.vectorStore.deleteByFilter(FEEDBACK_COLLECTION, { feedbackId: feedback.id }).catch(() => {});
        feedback.vectorId = null;
        await this.repo.save(feedback);
      }
      return;
    }

    try {
      const textToEmbed = feedback.question?.trim() || feedback.answer?.trim() || feedback.comment!;
      const vector = await this.embedding.embed(textToEmbed);
      const vectorId = feedback.vectorId ?? uuidv4();

      await this.vectorStore.ensureCollection(FEEDBACK_COLLECTION, this.embedding.vectorSize);
      await this.vectorStore.upsert(FEEDBACK_COLLECTION, [{
        id: vectorId,
        vector,
        payload: {
          feedbackId: feedback.id,
          userId:     feedback.userId,
          scope:      feedback.scope,
          approved:   feedback.isApproved,
          rating:     feedback.rating,
          question:   feedback.question ?? '',
          answer:     feedback.answer ?? '',
          comment:    feedback.comment ?? '',
        },
      }]);

      if (feedback.vectorId !== vectorId) {
        feedback.vectorId = vectorId;
        await this.repo.save(feedback);
      }
    } catch (err: any) {
      this.logger.warn(`Feedback vectorization ${feedback.id} failed: ${err?.message ?? err}`);
    }
  }

  // ── Retrieval for the prompt ─────────────────────────────────────────────────

  /**
   * Retrieves the feedback most similar to the query: own ones (personal) + approved
   * shared ones. Two separate searches because the adapter filters only by equality.
   */
  async searchMemory(userId: string, queryText: string, limit = 3): Promise<FeedbackMemoryHit[]> {
    if (!this.vectorStore || !this.embedding || !queryText.trim()) return [];
    try {
      const vector = await this.embedding.embed(queryText);
      const [mine, shared] = await Promise.all([
        this.vectorStore.search(FEEDBACK_COLLECTION, vector, limit, { userId, scope: 'personal' }),
        this.vectorStore.search(FEEDBACK_COLLECTION, vector, limit, { scope: 'shared', approved: true }),
      ]);

      const merged = [...mine, ...shared]
        .filter((h) => h.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score);

      // Dedup by feedbackId, keep the best score
      const seen = new Set<string>();
      const out: FeedbackMemoryHit[] = [];
      for (const h of merged) {
        const fid = h.payload.feedbackId ?? h.id;
        if (seen.has(fid)) continue;
        seen.add(fid);
        out.push({
          rating:   h.payload.rating ?? 'down',
          question: h.payload.question ?? '',
          comment:  h.payload.comment ?? '',
          score:    h.score,
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err: any) {
      this.logger.warn(`searchMemory failed: ${err?.message ?? err}`);
      return [];
    }
  }

  // ── Dashboard / governance ──────────────────────────────────────────────────

  /** User's feedback for the messages of a chat (UI state). */
  async listForChat(userId: string, chatId: string): Promise<Feedback[]> {
    return this.repo
      .createQueryBuilder('f')
      .innerJoin(Message, 'm', 'm.id = f."messageId"')
      .where('f."userId" = :userId', { userId })
      .andWhere('m."chatId" = :chatId', { chatId })
      .orderBy('f."createdAt"', 'DESC')
      .getMany();
  }

  /** Listing for the admin dashboard (all) or user (only their own). */
  async list(userId: string, isAdmin: boolean): Promise<Feedback[]> {
    const where = isAdmin ? {} : { userId };
    return this.repo.find({ where, order: { createdAt: 'DESC' }, take: 200 });
  }

  /** Approves a shared feedback (admin only) → enters the collective memory. */
  async approve(id: string, approved: boolean): Promise<Feedback> {
    const feedback = await this.repo.findOne({ where: { id } });
    if (!feedback) throw new NotFoundException('feedback.notFound');
    feedback.isApproved = approved;
    await this.repo.save(feedback);
    await this.syncVector(feedback); // updates payload.approved in the vector
    return feedback;
  }

  /** Changes scope (owner or admin). */
  async setScope(id: string, scope: FeedbackScope, userId: string, isAdmin: boolean): Promise<Feedback> {
    const feedback = await this.repo.findOne({ where: { id } });
    if (!feedback) throw new NotFoundException('feedback.notFound');
    if (!isAdmin && feedback.userId !== userId) throw new ForbiddenException();
    feedback.scope = scope;
    if (scope === 'personal') feedback.isApproved = false;
    await this.repo.save(feedback);
    await this.syncVector(feedback);
    return feedback;
  }

  /** Deletes feedback + its vector point (owner or admin). */
  async remove(id: string, userId: string, isAdmin: boolean): Promise<void> {
    const feedback = await this.repo.findOne({ where: { id } });
    if (!feedback) throw new NotFoundException('feedback.notFound');
    if (!isAdmin && feedback.userId !== userId) throw new ForbiddenException();
    if (feedback.vectorId && this.vectorStore) {
      await this.vectorStore.deleteByFilter(FEEDBACK_COLLECTION, { feedbackId: feedback.id }).catch(() => {});
    }
    await this.repo.remove(feedback);
  }
}
