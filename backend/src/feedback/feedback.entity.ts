import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { Message } from '../messages/messages.entity';

export type FeedbackRating = 'up' | 'down';
export type FeedbackScope = 'personal' | 'shared';

/**
 * A user's rating on an assistant message (feedback loop 👍/👎).
 *
 * Feedback with a `comment` (correction) is vectorized into the `feedback_memory`
 * collection and, if the memory is active, re-injected into the system prompt on
 * future similar requests → the agent avoids repeating the same errors in-context.
 */
@Entity('message_feedback')
@Unique('UQ_message_feedback_user_message', ['messageId', 'userId'])
export class Feedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'messageId' })
  message: Message;

  @Column({ type: 'uuid' })
  messageId: string;

  @Index('IDX_message_feedback_user')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 10 })
  rating: FeedbackRating;

  /** User's correction/note. If present, the feedback enters the memory. */
  @Column({ type: 'text', nullable: true })
  comment: string | null;

  /** User question that generated the rated answer (used as the text to embed). */
  @Column({ type: 'text', nullable: true })
  question: string | null;

  /** Snippet of the rated answer. */
  @Column({ type: 'text', nullable: true })
  answer: string | null;

  /** personal = author only; shared = all users (only if isApproved). */
  @Column({ type: 'varchar', length: 20, default: 'personal' })
  scope: FeedbackScope;

  /** For shared ones: visible in others' memory only after admin approval. */
  @Column({ type: 'boolean', default: false })
  isApproved: boolean;

  /** Id of the point in the 'feedback_memory' collection (null = not vectorized). */
  @Column({ type: 'uuid', nullable: true })
  vectorId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
