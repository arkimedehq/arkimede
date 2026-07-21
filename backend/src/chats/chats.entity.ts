import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { Project } from '../projects/projects.entity';
import { Message } from '../messages/messages.entity';

@Entity('chats')
export class Chat {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', default: 'Nuova chat' })
  title: string;

  @ManyToOne(() => User, (u) => u.chats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => Project, (p) => p.chats, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Column({ type: 'uuid', nullable: true })
  projectId: string;

  /**
   * If set, the chat runs with an **agent team** (Multi-Agent) instead
   * of the single agent. See MultiAgentService + branch in MessagesController.
   */
  @Column({ type: 'uuid', nullable: true })
  agentTeamId: string | null;

  /**
   * The chat has content not yet seen by the user (e.g. automation outcome
   * delivered by the headless runner). Shown as "unread" in the sidebar;
   * cleared when the user opens the chat (PATCH /chats/:id/read).
   */
  @Column({ type: 'boolean', default: false })
  unread: boolean;

  @OneToMany(() => Message, (m) => m.chat)
  messages: Message[];

  /**
   * Incremental summary of the older turns (history compaction).
   * null = no summary generated yet.
   */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /**
   * Id of the last message already incorporated into `summary`. Messages created
   * after this are still "fresh" and are passed to the model verbatim.
   */
  @Column({ type: 'uuid', nullable: true })
  summaryUpToMessageId: string | null;

  /** Token estimate of `summary`, used to compute the remaining budget. */
  @Column({ type: 'int', nullable: true })
  summaryTokens: number | null;

  /**
   * Id of the last message already analyzed by the user memory extraction.
   * Later messages are "new": when their count exceeds the threshold the
   * automatic extraction fires. Twin of `summaryUpToMessageId`.
   */
  @Column({ type: 'uuid', nullable: true })
  memoryUpToMessageId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
