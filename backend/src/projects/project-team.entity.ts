import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Unique, Index,
} from 'typeorm';
import { Project } from './projects.entity';
import { Team } from '../teams/team.entity';

/**
 * Role of a team on a shared project.
 *
 * - `collaborator` → the team's members work fully in the project
 *                    (create their own chats, upload files, see the context)
 * - `viewer`       → read-only: they see chats/files/context, they don't write
 */
export type ProjectTeamRole = 'collaborator' | 'viewer';

/**
 * Project ↔ team assignment (many-to-many with role).
 *
 * A project can be shared with multiple teams (e.g. architects + sales)
 * that also enter at different stages. Management (add/remove team) is
 * reserved for the project owner and global admins.
 *
 * Uniqueness constraint (projectId, teamId): a team cannot be assigned
 * twice to the same project.
 */
@Entity('project_teams')
@Unique('uq_project_team', ['projectId', 'teamId'])
export class ProjectTeam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Project, (p) => p.projectTeams, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Index()
  @Column({ type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Team, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teamId' })
  team: Team;

  @Index()
  @Column({ type: 'uuid' })
  teamId: string;

  @Column({ type: 'varchar', length: 20, default: 'collaborator' })
  role: ProjectTeamRole;

  @CreateDateColumn()
  addedAt: Date;
}
