import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Unique, Index,
} from 'typeorm';
import { Team } from './team.entity';
import { User } from '../users/users.entity';

/** Role of the user within a team. */
export type TeamRole = 'owner' | 'member';

/**
 * Membership of a user in a team (many-to-many relation with role).
 *
 * - `owner`  → can manage the team members (in addition to global admins)
 * - `member` → accesses the team's `team`-scoped resources
 *
 * Uniqueness constraint (teamId, userId): a user cannot be twice
 * in the same team.
 */
@Entity('team_memberships')
@Unique('uq_team_membership', ['teamId', 'userId'])
export class TeamMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Team, (t) => t.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teamId' })
  team: Team;

  @Index()
  @Column({ type: 'uuid' })
  teamId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 20, default: 'member' })
  role: TeamRole;

  @CreateDateColumn()
  createdAt: Date;
}
