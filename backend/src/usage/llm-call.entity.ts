import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

/**
 * Call-level LLM serving log (one row per model invocation, ANY caller: agent,
 * multi-agent, flows, custom tools, enrichment). Complementary to the token
 * aggregation derived from `messages` (chat only): this is where latency, errors
 * and — once the scheduler lands — queue time live. Retention: 30 days (GC in
 * LlmMetricsService).
 */
@Entity('llm_calls')
export class LlmCall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_llm_calls_created')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Config the model was built from (null: config deleted afterwards is fine — no FK). */
  @Index('IDX_llm_calls_config')
  @Column({ type: 'uuid', nullable: true })
  llmConfigId: string | null;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  model: string | null;

  /** Wall-clock of the model call (streaming: start → last chunk). */
  @Column({ type: 'int' })
  latencyMs: number;

  @Column({ type: 'int', default: 0 })
  inputTokens: number;

  @Column({ type: 'int', default: 0 })
  outputTokens: number;

  @Column({ type: 'int', default: 0 })
  cacheReadTokens: number;

  @Column({ type: 'int', default: 0 })
  cacheWriteTokens: number;

  @Column({ type: 'boolean', default: true })
  ok: boolean;

  /** Error class/message head when ok=false (e.g. 'RateLimitError'). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  errorKind: string | null;

  /** Time spent waiting in the dispatcher queue. Null until the scheduler (P1) exists. */
  @Column({ type: 'int', nullable: true })
  queuedMs: number | null;

  /** Scheduling class ('interactive' | 'background' | 'batch'). Null until P1. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  priority: string | null;

  /** Attribution (filled when the call context carries it; null in P2-F1). */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** Caller kind ('chat' | 'automation' | 'flow' | 'team' | ...). Null in P2-F1. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  origin: string | null;
}
