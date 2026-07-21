import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * Collection in the vector database.
 *
 * Only one collection can have `isDefault = true`.
 * The invariant is guaranteed by VectorDbService (removes the default from the others
 * before setting it on the new one).
 */
@Entity('vector_collections')
export class VectorCollectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Collection name in Qdrant (unique, max 100 characters). */
  @Column({ type: 'varchar', length: 100, unique: true })
  name: string;

  /** Optional description for administrative use. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * If true, this collection is used by default for ingest and RAG.
   * Invariant: at most one row with isDefault = true.
   */
  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
