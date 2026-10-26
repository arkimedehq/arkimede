// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

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

/** Grammatical gender of the user in gendered languages (e.g. Italian); also the first person of their memory. */
export type UserGender = 'masculine' | 'feminine' | 'neutral';
/** The categories of Recordare's notes, for the copy rule (D34). */
export const RECORDARE_NOTE_CATEGORIES = ['preference', 'habit', 'value', 'relationship', 'knowledge', 'profile', 'constraint'] as const;

export const USER_GENDERS: UserGender[] = ['masculine', 'feminine', 'neutral'];

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
   * Grammatical gender ('masculine' | 'feminine' | 'neutral'). null = not set → masculine.
   * Sent to Recordare as the gender of the memory's first person (its D50, `PATCH /me {gender}`).
   */
  @Column({ type: 'varchar', length: 10, nullable: true, default: null })
  gender: UserGender | null;

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
   * Use the team and organisation notes (A-MEM F4) in the user's chats — pinned, retrieved, searched — apart from the
   * personal memory above (Recordare D34: the toggle split). Default false.
   */
  @Column({ type: 'boolean', default: false })
  sharedMemoryEnabled: boolean;

  /**
   * Per-user override of the memory extraction threshold (number of new messages
   * since the last extraction). null = use the global default (app_config.autoMemoryThreshold).
   */
  @Column({ type: 'int', nullable: true, default: null })
  memoryThreshold: number | null;

  /**
   * Episodic memory in Recordare (external service, src/recordare/): if true, the
   * user's chats are sent to Recordare and its recall tools are offered to the
   * agent. Separate from autoMemoryEnabled (A-MEM, unchanged). Default false.
   * Recordare has no consent flag of its own (its D50): this switch is the only on/off.
   */
  @Column({ type: 'boolean', default: false })
  episodicMemoryEnabled: boolean;

  /** The user's memoryId in Recordare (GET api/v1/me), cached; null = not provisioned yet. */
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  recordareMemoryId: string | null;

  /**
   * The copy rule (Recordare D34): Recordare notes of these categories are copied into the personal A-MEM, and the
   * copies follow them (updated, corrected, removed). Empty = only the notes the user copies by hand.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  recordareCopyCategories: string[];

  /** How far the user's Recordare notes change feed has been followed (its `next`). */
  @Column({ type: 'bigint', default: 0, select: false })
  recordareNotesCursor: string;

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
