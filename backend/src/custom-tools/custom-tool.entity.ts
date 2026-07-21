/**
 * @file custom-tool.entity.ts
 *
 * TypeORM entity for user-defined custom tools.
 *
 * A custom tool is essentially a LangChain DynamicStructuredTool
 * serialized into PostgreSQL: the `buildDynamicTool()` factory recreates it
 * on every agent request.
 *
 * Uniqueness constraint: (userId, name) — each user has its own namespace.
 * Names must not collide with built-in tools; validation happens
 * in the service at creation time.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn, Unique,
} from 'typeorm';
import { User } from '../users/users.entity';
import { ToolSecret } from './tool-secret.entity';
import { ExecutorType, ExecutorConfig, ToolParameter, ToolScope } from './custom-tool.types';

@Entity('custom_tools')
@Unique(['userId', 'name'])
export class CustomTool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /**
   * snake_case name of the tool — used as identifier in the LangGraph agent.
   * Must match the pattern /^[a-z][a-z0-9_]{1,63}$/.
   * E.g.: "search_brave", "cerca_cliente", "aggiorna_stock"
   */
  @Column({ type: 'varchar', length: 64 })
  name: string;

  /**
   * LLM-readable description — it is the "prompt" that decides when the tool
   * is invoked. The more precise and contextual it is, the better the decisions.
   * Must include: what it does, when to use it, when NOT to use it.
   */
  @Column({ type: 'text' })
  description: string;

  /**
   * List of tool parameters. Each parameter becomes a field of the Zod schema
   * that the LLM must fill in before execution.
   */
  @Column({ type: 'jsonb', default: [] })
  parameters: ToolParameter[];

  /** Executor type that determines how the tool is executed */
  @Column({
    type: 'enum',
    enum: ['http', 'sql', 'prompt', 'rag', 'mongo', 'redis'],
  })
  executorType: ExecutorType;

  /**
   * Executor-specific configuration (structure depends on executorType).
   * Sensitive values (API keys) do NOT go here — use tool_secrets with {{secret.KEY}}.
   */
  @Column({ type: 'jsonb' })
  executorConfig: ExecutorConfig;

  /** Tool enabled/disabled without deleting it */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * If true (default) the tool is injected into the "flat" context of the main
   * chat. If false it does NOT appear in chat: it remains reachable only through
   * an agent that includes it in its own `toolFilter` (hierarchical delegation).
   * Axis orthogonal to `Agent.exposeAsTool` — see loadToolsForUser({ flatOnly }).
   */
  @Column({ type: 'boolean', default: true })
  loadOnFirst: boolean;

  /**
   * Visibility scope:
   *   personal — visible/usable only by the creator
   *   team     — visible/usable by members of `teamId`; managed by admin or team owner
   *   org      — visible/usable by everyone; management reserved to admins
   */
  @Column({ type: 'varchar', length: 20, default: 'personal' })
  scope: ToolScope;

  /** Reference team when scope='team' (null otherwise). */
  @Column({ type: 'uuid', nullable: true, default: null })
  teamId: string | null;

  /** Encrypted secrets associated with the tool (API keys, tokens, etc.) */
  @OneToMany(() => ToolSecret, (s) => s.tool, { cascade: true, eager: false })
  secrets: ToolSecret[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
