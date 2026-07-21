/**
 * @file mcp-server-secret.entity.ts
 *
 * Encrypted secrets (AES-256-CBC) associated with an McpServer.
 * Used as {{secret.KEY_NAME}} in the headers, env, url, command templates.
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { McpServer } from './mcp-server.entity';

@Entity('mcp_server_secrets')
export class McpServerSecret {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => McpServer, (s) => s.secrets, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'serverId' })
  server: McpServer;

  @Index()
  @Column({ type: 'uuid' })
  serverId: string;

  /** Key name (e.g. "API_KEY", "TOKEN") */
  @Column({ type: 'varchar', length: 64 })
  keyName: string;

  /** Value encrypted with AES-256-CBC */
  @Column({ type: 'text' })
  encryptedValue: string;
}
