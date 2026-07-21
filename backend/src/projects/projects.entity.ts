import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { Chat } from '../chats/chats.entity';
import { File } from '../files/files.entity';
import { ProjectTeam } from './project-team.entity';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true })
  description: string;

  @Column({ type: 'varchar', nullable: true })
  color: string;

  /**
   * Project owner (whoever created it). Nullable: if the user is deleted
   * the project survives orphaned (ON DELETE SET NULL) and an admin reassigns it,
   * so a project shared with the team doesn't disappear with its creator.
   */
  @ManyToOne(() => User, (u) => u.projects, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @OneToMany(() => Chat, (c) => c.project)
  chats: Chat[];

  @OneToMany(() => File, (f) => f.project)
  files: File[];

  /** Teams the project is shared with (multi-team, collaborator/viewer roles). */
  @OneToMany(() => ProjectTeam, (pt) => pt.project)
  projectTeams: ProjectTeam[];

  /**
   * Project contextual instructions — added on top of the base SYSTEM_PROMPT and the user prompt.
   * E.g.: "This project concerns the client Acme in Milan, budget €180k"
   * Used to give the agent specific context without having to repeat it in every message.
   */
  @Column({ type: 'text', nullable: true, default: null })
  systemPrompt: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
