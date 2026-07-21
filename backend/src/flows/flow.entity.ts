/**
 * @file flow.entity.ts
 *
 * TypeORM entity for the Flows (deterministic graph workflows).
 *
 * The topology (nodes + edges + binding) lives entirely in `definition` (jsonb):
 * it is read/written as a whole from the canvas editor, so there is no need to
 * normalize it into `flow_nodes`/`flow_edges` tables. The `scope` follows the same
 * model as custom tools / skills / data sources (personal | team | org).
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { FlowDefinition, FlowScope, FlowTrigger, FlowInputVar } from './flow.types';

@Entity('flows')
export class Flow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Owner of the flow (for personal scope and management). */
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** DAG graph: { nodes:[...], edges:[...] }. */
  @Column({ type: 'jsonb', default: { nodes: [], edges: [] } })
  definition: FlowDefinition;

  /** Trigger configuration. Slice 1: { type: 'manual' }. */
  @Column({ type: 'jsonb', default: { type: 'manual' } })
  trigger: FlowTrigger;

  /** Start variables (tool signature / manual-execution form). */
  @Column({ type: 'jsonb', default: [] })
  inputSchema: FlowInputVar[];

  /** If true, the agent can invoke the flow as a tool (Slice 3). */
  @Column({ type: 'boolean', default: false })
  exposeAsTool: boolean;

  /**
   * If false, the flow-tool does not enter the chat's flat context: it stays usable
   * only via an agent that includes it. Axis orthogonal to exposeAsTool — default true.
   */
  @Column({ type: 'boolean', default: true })
  loadOnFirst: boolean;

  /** Enable toggle, like the skills. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * Runtime state of the `chat` nodes: maps `chat title → chatId` of the dedicated chat
   * created at the first delivery and reused on subsequent runs. It lives HERE (not inside
   * the `definition`) because the definition is rewritten as a whole on every editor save:
   * a chat created at runtime would be overwritten there. If the user deletes the chat,
   * the node detects its absence and recreates one.
   */
  @Column({ type: 'jsonb', default: {} })
  deliverChats: Record<string, string>;

  @Column({ type: 'varchar', length: 16, default: 'personal' })
  scope: FlowScope;

  /** Set only if scope='team'. */
  @Column({ type: 'uuid', nullable: true })
  teamId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
