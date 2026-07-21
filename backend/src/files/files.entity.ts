import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { Project } from '../projects/projects.entity';

@Entity('files')
export class File {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  originalName: string;

  @Column({ type: 'varchar' })
  storagePath: string;

  @Column({ type: 'varchar' })
  mimeType: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column({ type: 'boolean', default: false })
  vectorized: boolean;

  @Column({ type: 'varchar', nullable: true })
  vectorCollectionId: string;

  @ManyToOne(() => User, (u) => u.files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => Project, (p) => p.files, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Column({ type: 'uuid', nullable: true })
  projectId: string;

  /**
   * File visibility scope (C2) — same model as tool/skill/datasource.
   * `personal` (owner + members of the file's project only) | `team` (members of
   * the `teamId` team) | `org` (the whole organization). Default `personal`.
   */
  @Column({ type: 'varchar', length: 20, default: 'personal' })
  scope: 'personal' | 'team' | 'org';

  /** Set only if scope='team'. */
  @Column({ type: 'uuid', nullable: true, default: null })
  teamId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
