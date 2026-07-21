/**
 * @file tool-secret.entity.ts
 *
 * TypeORM entity for the encrypted secrets of custom tools (API keys, tokens, etc.).
 *
 * The values are encrypted with AES-256-CBC using the TOOL_SECRETS_KEY key
 * present in .env. The `encryptedValue` field is never returned
 * in the REST APIs — only the tool factory decrypts it internally
 * at execution time.
 *
 * Usage in the executorConfig:
 *   "Authorization": "Bearer {{secret.MY_API_KEY}}"
 *   "api_key": "{{secret.TAVILY_API_KEY}}"
 *
 * The {{secret.KEY_NAME}} placeholder is resolved at runtime with the
 * decrypted value of the ToolSecret with keyName === KEY_NAME.
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { CustomTool } from './custom-tool.entity';

@Entity('tool_secrets')
@Unique(['toolId', 'keyName'])
export class ToolSecret {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => CustomTool, (t) => t.secrets, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'toolId' })
  tool: CustomTool;

  @Column({ type: 'uuid' })
  toolId: string;

  /**
   * Variable name — corresponds to the part after "secret." in the placeholder.
   * E.g.: if the placeholder is {{secret.TAVILY_API_KEY}}, keyName = "TAVILY_API_KEY"
   */
  @Column({ type: 'varchar', length: 64 })
  keyName: string;

  /**
   * Value encrypted with AES-256-CBC.
   * Format: "<iv_hex>:<ciphertext_hex>"
   * NEVER exposed in the API responses.
   */
  @Column({ type: 'text', select: false })
  encryptedValue: string;
}
