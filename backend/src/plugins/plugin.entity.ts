// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin.entity.ts
 *
 * The plugin tables (specs/PLUGINS.md §12): the installed plugin, its settings, the events it emitted (dedup and log),
 * its key-value store and the links between its people and Arkimede's users. Everything a plugin owns goes with it
 * (ON DELETE CASCADE); the primitives it contributed carry `pluginId` and are removed by PluginsService.
 */
import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from 'typeorm';
import type { PluginManifest, PluginPermissions } from './plugin-manifest';
import type { TrustLevel } from './plugin-trust';

export type PluginStatus = 'pending_approval' | 'active' | 'disabled' | 'error';
export type PluginScope = 'personal' | 'team' | 'org';

/** One copy of a plugin: each user has their own copy of a personal plugin; a shared one is installed once by an admin. */
@Entity('plugins')
@Unique(['name', 'ownerId'])
export class Plugin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  /** `personal` (one person's account, data or memory: always the owner's copy) or `shared`. */
  @Column({ type: 'varchar', length: 16, default: 'shared' })
  audience: 'personal' | 'shared';

  @Column({ type: 'varchar', length: 32 })
  version: string;

  @Column({ type: 'int' })
  contract: number;

  /** The manifest of the version running (null before the first approval). */
  @Column({ type: 'jsonb', nullable: true })
  manifest: PluginManifest | null;

  /** A version waiting for approval (first install, or an update that asks more): stored here, not yet running. */
  @Column({ type: 'jsonb', nullable: true })
  pendingManifest: PluginManifest | null;

  @Column({ type: 'varchar', length: 20, default: 'pending_approval' })
  status: PluginStatus;

  @Column({ type: 'text', nullable: true })
  statusDetail: string | null;

  @Column({ type: 'varchar', length: 20, default: 'org' })
  scope: PluginScope;

  @Column({ type: 'uuid' })
  ownerId: string;

  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  /** The agent that answers agent.ask (null = the main pipeline). */
  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'unsigned' })
  trust: TrustLevel;

  @Column({ type: 'varchar', length: 128, nullable: true })
  signedBy: string | null;

  /** SHA-256 of the package running (or pending). */
  @Column({ type: 'varchar', length: 64 })
  sha256: string;

  /** What the admin approved; an update asking more waits for a new approval. */
  @Column({ type: 'jsonb', nullable: true })
  grants: PluginPermissions | null;

  /** Bumped when the plugin is disabled, updated or removed: its tokens stop working. */
  @Column({ type: 'int', default: 1 })
  tokenVersion: number;

  @Column({ type: 'uuid', nullable: true })
  approvedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('plugin_settings')
@Unique(['pluginId', 'key'])
export class PluginSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  pluginId: string;

  @ManyToOne(() => Plugin, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pluginId' })
  plugin?: Plugin;

  @Column({ type: 'varchar', length: 64 })
  key: string;

  /** Encrypted when the manifest marks the setting secret. */
  @Column({ type: 'text' })
  value: string;

  @Column({ type: 'boolean', default: false })
  secret: boolean;
}

export type PluginEventOutcome = 'accepted' | 'duplicate' | 'invalid' | 'rate_limited';

@Entity('plugin_events')
@Unique(['pluginId', 'eventId'])
@Index(['pluginId', 'createdAt'])
export class PluginEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  pluginId: string;

  @ManyToOne(() => Plugin, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pluginId' })
  plugin?: Plugin;

  @Column({ type: 'varchar', length: 128 })
  eventId: string;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'timestamptz' })
  at: Date;

  @Column({ type: 'varchar', length: 16 })
  outcome: PluginEventOutcome;

  /** What happened with it: the flows started, the plugins it reached, or why it was refused. */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

@Entity('plugin_kv')
@Unique(['pluginId', 'key'])
export class PluginKv {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  pluginId: string;

  @ManyToOne(() => Plugin, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pluginId' })
  plugin?: Plugin;

  @Column({ type: 'varchar', length: 256 })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ type: 'int' })
  bytes: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('plugin_identities')
@Unique(['pluginId', 'externalId'])
export class PluginIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  pluginId: string;

  @ManyToOne(() => Plugin, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pluginId' })
  plugin?: Plugin;

  /** The person's id in the plugin's own space. */
  @Column({ type: 'varchar', length: 256 })
  externalId: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  displayName: string | null;

  /** The Arkimede user it is (null: a guest). */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** A guest the admin authorized: agent.ask acts for them, as the plugin's owner. */
  @Column({ type: 'boolean', default: false })
  authorized: boolean;

  /**
   * The Home Assistant person it is (`person.*`), when no linked account gives one (a child, a grandparent without an
   * account): the memory, the presence and `say` know them as that person. A linked account's own haPerson wins.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  haPerson: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** A key the admin trusts for plugin signatures (the official ones come from the environment). */
@Entity('plugin_trusted_keys')
export class PluginTrustedKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  keyId: string;

  @Column({ type: 'varchar', length: 16 })
  level: 'verified' | 'community';

  @Column({ type: 'text' })
  publicKey: string;

  @Column({ type: 'uuid', nullable: true })
  addedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
