import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Chat } from '../chats/chats.entity';

export type MessageRole = 'user' | 'assistant' | 'system';

/** A tool call executed during the generation of an assistant message. */
export interface ToolCallRecord {
  name: string;
  input: any;
  output?: any;
  ok?: boolean;
  startedAt: number;
  durationMs?: number;
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: ['user', 'assistant', 'system'], default: 'user' })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', nullable: true })
  attachments: { name: string; fileId: string; mimeType: string; mode?: 'embed' | 'inline' | 'attachment' }[];

  /**
   * History/debug of the tool calls made to generate this message.
   * Populated only for assistant messages. null = no tool call (or old message).
   * Each record: { name, input, output (truncated ~8KB), ok, startedAt, durationMs }.
   */
  @Column({ type: 'jsonb', nullable: true })
  toolCalls: ToolCallRecord[] | null;

  /**
   * Input tokens (prompt + history) consumed to generate this message.
   * Populated only for assistant messages. null = data not available (e.g. old messages).
   */
  @Column({ type: 'int', nullable: true, default: null })
  inputTokens: number | null;

  /**
   * Output tokens (generated text) consumed for this message.
   * Populated only for assistant messages. null = data not available.
   */
  @Column({ type: 'int', nullable: true, default: null })
  outputTokens: number | null;

  /**
   * Input tokens read from the prompt cache (discounted relative to full input).
   * Semantics and price multiplier depend on the provider (see pricing.ts).
   */
  @Column({ type: 'int', nullable: true, default: null })
  cacheReadTokens: number | null;

  /** Tokens written to cache (cache creation, surcharge on Anthropic). */
  @Column({ type: 'int', nullable: true, default: null })
  cacheWriteTokens: number | null;

  /**
   * Provider and model that generated this assistant message. Used to attribute
   * the cost to the correct price (from llm_configs) even if the default config
   * changes over time. null = historical message / data not available.
   */
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  provider: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  model: string | null;

  @ManyToOne(() => Chat, (c) => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chatId' })
  chat: Chat;

  @Column({ type: 'uuid' })
  chatId: string;

  /**
   * Author of the user message (in a shared project multiple collaborators
   * write in the same chat). null for assistant/system or historical messages.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  authorId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
