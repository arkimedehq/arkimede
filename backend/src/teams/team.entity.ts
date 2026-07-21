import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, OneToMany,
} from 'typeorm';
import { TeamMembership } from './team-membership.entity';

/**
 * Team (group) within the organization.
 *
 * Teams allow sharing resources (tools, skills, projects) with a
 * subset of users instead of the whole org. The `team` scope of the
 * resources references a team via `teamId`.
 */
@Entity('teams')
export class Team {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, default: null })
  color: string | null;

  @OneToMany(() => TeamMembership, (m) => m.team)
  memberships: TeamMembership[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
