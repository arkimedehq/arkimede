/**
 * @file agent-team.entity.ts
 *
 * A team of agents: N agents + a topology that governs their collaboration.
 * Scope personal|team|org. Members live in `agent_team_members`.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { AgentScope, TeamTopology } from './agent.types';

@Entity('agent_teams')
export class AgentTeam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 16, default: 'supervisor' })
  topology: TeamTopology;

  /** Supervisor agent (only topology='supervisor'). */
  @Column({ type: 'uuid', nullable: true })
  supervisorAgentId: string | null;

  /**
   * If true, the team is exposed as a `DynamicStructuredTool` (`team_<slug>`):
   * the chat can delegate a task to it as if it were a single tool. Mirror of
   * `Agent.exposeAsTool` / `Flow.exposeAsTool`.
   */
  @Column({ type: 'boolean', default: false })
  exposeAsTool: boolean;

  @Column({ type: 'varchar', length: 16, default: 'personal' })
  scope: AgentScope;

  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
