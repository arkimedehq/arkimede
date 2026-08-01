// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/users.entity';

/**
 * Long-lived opaque API key of a user (service integrations: voice satellites,
 * external clients, scripts). Only the SHA-256 hash is stored; the clear key is
 * shown once at creation. Valid as a Bearer credential on the whole API with
 * the owner's identity — revocation is deleting the row (effective at the next
 * request), and a disabled owner blocks the key exactly like a JWT.
 */
@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  @Index()
  userId: string;

  /** Human label chosen at creation ("Satellite voce", "Script backup"…). */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** SHA-256 hex of the full key (the key itself is never stored). */
  @Column({ type: 'varchar', length: 64, unique: true })
  keyHash: string;

  /** First chars of the key ("ak_3fk9…") for identification in listings. */
  @Column({ type: 'varchar', length: 16 })
  prefix: string;

  /** Null = never expires. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  expiresAt: Date | null;

  /** Last successful authentication with this key (updated with throttling). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastUsedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
