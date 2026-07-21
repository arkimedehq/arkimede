/**
 * @file mcp-server.entity.ts
 *
 * TypeORM entity for the MCP servers configured by the user.
 *
 * Transport types:
 *   http   — POST JSON-RPC to a remote HTTP endpoint
 *   sse    — remote Server-Sent Events (HTTP streaming)
 *   local  — local stdio process, proxied via the Electron bridge
 *
 * For the http/sse transports the backend calls the endpoint directly.
 * For 'local', the backend delegates to the user's WebSocket bridge.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { McpServerSecret } from './mcp-server-secret.entity';

export type McpTransport = 'http' | 'sse' | 'local' | 'remote';

@Entity('mcp_servers')
export class McpServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /** Name displayed in the UI — need not be unique */
  @Column({ type: 'varchar', length: 128 })
  name: string;

  /** Optional description for the user */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Transport type:
   *   http  — classic RPC via POST
   *   sse   — streaming via Server-Sent Events
   *   local — stdio process proxied by the Electron bridge
   */
  @Column({ type: 'enum', enum: ['http', 'sse', 'local', 'remote'] })
  transport: McpTransport;

  /**
   * For http/sse: URL of the remote MCP endpoint.
   * For local: null (the command is used).
   */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  url: string | null;

  /**
   * For local: command to execute (e.g. "npx -y @modelcontextprotocol/server-filesystem").
   * For http/sse: null.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  command: string | null;

  /**
   * Additional arguments for the local command (e.g. ["/home/user/docs"]).
   * Null for http/sse.
   */
  @Column({ type: 'jsonb', nullable: true })
  args: string[] | null;

  /**
   * Additional HTTP headers (e.g. { "Authorization": "Bearer {{secret.TOKEN}}" }).
   * Supports {{secret.KEY}} and {{env.VAR}} templates.
   */
  @Column({ type: 'jsonb', nullable: true })
  headers: Record<string, string> | null;

  /**
   * Extra environment variables for the local process.
   * Supports {{secret.KEY}} templates.
   */
  @Column({ type: 'jsonb', nullable: true })
  env: Record<string, string> | null;

  /** Enabled/disabled without deleting the configuration */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * If false, this MCP server's tools don't enter the chat's flat
   * context: they remain usable only via an agent that includes them. Default true.
   */
  @Column({ type: 'boolean', default: true })
  loadOnFirst: boolean;

  /** Associated encrypted secrets (API key, token, etc.) */
  @OneToMany(() => McpServerSecret, (s) => s.server, { cascade: true, eager: false })
  secrets: McpServerSecret[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
