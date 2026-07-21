/**
 * @file agent.entity.ts
 *
 * A reusable Multi-Agent agent: system prompt + one LlmConfig + a tool
 * filter. Scope personal|team|org like the other resources.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { AgentScope, AgentToolFilter } from './agent.types';

@Entity('agents')
export class Agent {
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

  /** Agent instructions (its role/behavior). */
  @Column({ type: 'text', default: '' })
  systemPrompt: string;

  /** Agent's LlmConfig (null = default config). */
  @Column({ type: 'uuid', nullable: true })
  llmConfigId: string | null;

  /** Which of the user's tools the agent may use. */
  @Column({ type: 'jsonb', default: { mode: 'all' } })
  toolFilter: AgentToolFilter;

  /** Cap on the number of ReAct loop iterations (null = default). */
  @Column({ type: 'int', nullable: true })
  maxIterations: number | null;

  /**
   * If true, the agent is exposed as a `DynamicStructuredTool` (`agent_<slug>`)
   * to the other agents / to the chat: the main model can *delegate* a task to it
   * without seeing the agent's internal tools. Mirror of `Flow.exposeAsTool`.
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
