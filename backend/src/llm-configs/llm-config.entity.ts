import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { LlmProvider } from '../app-config/app-config.entity';

/**
 * A named LLM configuration — multi-record table that replaces
 * the llm* fields in the singleton app_config.
 *
 * Only one record can have isDefault = true (invariant maintained by
 * LlmConfigsService.setDefault). This record is the one used by the agent
 * for all conversations. The others are available for future uses
 * (e.g. per-user or per-project assignment).
 */
@Entity('llm_configs')
export class LlmConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Name displayed in the UI — e.g. "Claude Opus — produzione" */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 50 })
  provider: LlmProvider;

  /** Model name. If null, the provider default is used. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  model: string | null;

  /**
   * Encrypted API key (AES-256-CBC, same algorithm used for tool secrets).
   * If null, the service uses the provider's standard environment variable.
   */
  @Column({ type: 'text', nullable: true })
  apiKey: string | null;

  /** Base URL for local providers (Ollama, LM Studio) or OpenAI-compatible ones. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  baseUrl: string | null;

  /** Max tokens per response. If null, uses the provider default. */
  @Column({ type: 'int', nullable: true })
  maxTokens: number | null;

  /**
   * Cap on CONCURRENT calls to this config, enforced by the in-memory
   * dispatcher. Null = unlimited (pass-through) — right for cloud providers;
   * set a small value on finite capacity (self-hosted models).
   */
  @Column({ type: 'int', nullable: true })
  maxConcurrency: number | null;

  /** If true, this is the active config for the agent. Only one at a time. */
  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  /**
   * If true, this config is used to generate the history compaction
   * summaries (typically a cheap model). Only one at a time.
   * If none is designated, compaction uses the `isDefault` config.
   */
  @Column({ type: 'boolean', default: false })
  isSummarizer: boolean;

  /**
   * If true, this config is used for tasks requiring vision/multimodal
   * capabilities (e.g. image OCR for RAG). Only one at a time.
   * If none is designated, the `isDefault` config is used.
   */
  @Column({ type: 'boolean', default: false })
  isVision: boolean;

  /**
   * Price in $ per 1 million input/output tokens. Set by the admin and
   * used by the usage dashboard to estimate costs. null = unknown price
   * (messages from this model appear with cost "n/d").
   */
  @Column({ type: 'numeric', precision: 10, scale: 4, nullable: true })
  inputPricePerM: number | null;

  @Column({ type: 'numeric', precision: 10, scale: 4, nullable: true })
  outputPricePerM: number | null;

  /**
   * Price in $ per 1M cache tokens (read/write), from the provider's
   * price list (e.g. DeepSeek "cache hit", Anthropic "cache writes"). If null,
   * cost estimation uses the default per-provider multipliers (pricing.ts).
   * Scale 6: some cache price lists go below $0.0001/M.
   */
  @Column({ type: 'numeric', precision: 12, scale: 6, nullable: true })
  cacheReadPricePerM: number | null;

  @Column({ type: 'numeric', precision: 12, scale: 6, nullable: true })
  cacheWritePricePerM: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
