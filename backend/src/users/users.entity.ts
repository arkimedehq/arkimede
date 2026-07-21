import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, OneToMany,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { Project } from '../projects/projects.entity';
import { Chat } from '../chats/chats.entity';
import { File } from '../files/files.entity';
import { ToolLoadingStrategy, ToolSchemaFormat } from '../app-config/app-config.entity';

/** Global organization-level roles. */
export type UserRole = 'admin' | 'user';

/** User account status. */
export type UserStatus = 'active' | 'disabled';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  email: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar' })
  @Exclude()
  password: string;

  @Column({ type: 'varchar', default: 'user' })
  role: string;

  /**
   * Account status.
   * - `active`   → can authenticate normally
   * - `disabled` → blocked by the admin: login rejected, existing sessions not renewable
   * Default `active`. Deactivation is preferred over deletion to preserve
   * the history (chats, files, audit) and to allow re-enabling the user.
   */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: UserStatus;

  /**
   * User custom instructions — appended to the base SYSTEM_PROMPT.
   * Visible/editable by the user in the profile settings.
   * E.g.: "Always answer concisely" · "I'm a domain expert, skip the basic explanations"
   */
  @Column({ type: 'text', nullable: true, default: null })
  systemPrompt: string | null;

  /**
   * Language of the interface and of the assistant's responses ('it' | 'en').
   * null = no saved preference → the frontend detects it from the browser (fallback 'en').
   */
  @Column({ type: 'varchar', length: 5, nullable: true, default: null })
  language: string | null;

  /**
   * Per-user override of the tool selection strategy (Axis 1).
   * null = use the global default configured by the admin.
   */
  @Column({ type: 'varchar', length: 30, nullable: true, default: null })
  toolLoadingStrategy: ToolLoadingStrategy | null;

  /**
   * Per-user override of the maximum number of tools (auto threshold / K for RAG).
   * null = use the global default.
   */
  @Column({ type: 'int', nullable: true, default: null })
  toolLoadingMaxTools: number | null;

  /**
   * Per-user override of the tool schema format (Axis 2).
   * null = use the global default.
   */
  @Column({ type: 'varchar', length: 20, nullable: true, default: null })
  toolSchemaFormat: ToolSchemaFormat | null;

  /**
   * Per-user token limit for the conversation history.
   * null = use the global default configured by the admin (app_config.maxHistoryTokens).
   * Lets each user independently balance contextual memory vs cost.
   */
  @Column({ type: 'int', nullable: true, default: null })
  maxHistoryTokens: number | null;

  /**
   * UI preference: show the token count (input/output) under each
   * assistant message and the total in the chat session.
   * Default: false (disabled to avoid cluttering the interface).
   */
  @Column({ type: 'boolean', default: false })
  showTokenCount: boolean;

  /**
   * Persistent user memory: if true, the agent automatically extracts durable
   * facts about the user (on a turn threshold) and — once confirmed — injects
   * them into the system prompt across sessions. Default false (opt-in from the Profile).
   */
  @Column({ type: 'boolean', default: false })
  autoMemoryEnabled: boolean;

  /**
   * Per-user override of the memory extraction threshold (number of new messages
   * since the last extraction). null = use the global default (app_config.autoMemoryThreshold).
   */
  @Column({ type: 'int', nullable: true, default: null })
  memoryThreshold: number | null;

  @OneToMany(() => Project, (p) => p.user)
  projects: Project[];

  @OneToMany(() => Chat, (c) => c.user)
  chats: Chat[];

  @OneToMany(() => File, (f) => f.user)
  files: File[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
