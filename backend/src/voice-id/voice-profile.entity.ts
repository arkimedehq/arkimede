// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A voice the house knows (voice-id.service.ts): a person who speaks to the satellites — not an Arkimede account (the
 * voice account is one many people talk to). Optionally the same person as a Home Assistant person (the identity the
 * memory already knows) and as an Arkimede user (the holder of a personal memory). The samples are voiceprints
 * (embeddings, no audio), encrypted at rest: biometric data.
 */
@Entity('voice_profiles')
export class VoiceProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** The Home Assistant person (`person.x`) this voice is. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  haPerson: string | null;

  /** The Arkimede user this voice is (who holds a personal memory). */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** The samples (number[][]), JSON, encrypted (crypto.utils). */
  @Column({ type: 'text', nullable: true })
  samples: string | null;

  @Column({ type: 'int', default: 0 })
  sampleCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
