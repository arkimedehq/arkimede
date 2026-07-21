/**
 * @file agent-team-member.entity.ts
 *
 * Join agents ↔ team with order (for the sequential topology) and role label.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { AgentTeam } from './agent-team.entity';
import { Agent } from './agent.entity';

@Entity('agent_team_members')
@Unique(['teamId', 'agentId'])
export class AgentTeamMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => AgentTeam, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'teamId' })
  team: AgentTeam;

  @Column({ type: 'uuid' })
  teamId: string;

  @ManyToOne(() => Agent, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'agentId' })
  agent: Agent;

  @Column({ type: 'uuid' })
  agentId: string;

  /** Order within the team (relevant for topology='sequential'). */
  @Column({ type: 'int', default: 0 })
  position: number;

  /** Free-form role label (e.g. "researcher", "writer"). */
  @Column({ type: 'varchar', length: 80, nullable: true })
  role: string | null;
}
