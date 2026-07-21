/**
 * @file datasource.entity.ts
 *
 * TypeORM entity for external data sources configured by the user.
 *
 * A DataSource represents a connection to an external database (MySQL, PostgreSQL)
 * reusable by multiple custom SQL tools.
 *
 * Separation of concerns with respect to the custom SQL tool:
 *   DataSource  → WHAT the database is (connection, schema, relations)
 *   CustomTool  → HOW to query it (query template, column prefetch, limits)
 *
 * The connection string is encrypted at rest with AES-256-CBC (same algorithm
 * used for custom tool secrets, same TOOL_SECRETS_KEY key).
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../users/users.entity';
import { SchemaManifest } from './schema-manifest.types';
import { DocumentManifest } from './document-manifest.types';
import { KeyspaceManifest } from './keyspace-manifest.types';
import { DataSourceEngine } from './engine.types';

export type DataSourceScope = 'personal' | 'team' | 'org';

@Entity('data_sources')
export class DataSourceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  userId: string;

  /** Name displayed in the UI — e.g. "Gestionale Aziendale" */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Database description for internal documentation */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * DBMS engine (relational: postgres|mysql|mariadb|mssql|oracle|sqlite;
   * document: mongodb). Selects driver and family (relational|document);
   * it is NO LONGER inferred from the connection string prefix.
   */
  @Column({ type: 'varchar', length: 20, default: 'postgres' })
  engine: DataSourceEngine;

  /**
   * Connection string encrypted with AES-256-GCM.
   * The format depends on the engine (e.g. postgresql://… , mysql://… , mssql://… ,
   * oracle://host:1521/service , sqlite:///path.db).
   * ⚠️ The plaintext value is NEVER returned in API responses.
   */
  @Column({ type: 'text' })
  encryptedConnectionString: string;

  /**
   * Schema relations and notes — free text read by the LLM before prefetch.
   * Use for legacy DBs without declared FKs:
   *   "fornitore.COD_FOR → ordini.COD_FOR_ORD\nFLAGSTORICO=1 = storicizzato"
   */
  @Column({ type: 'text', nullable: true })
  schemaHints: string | null;

  /**
   * If true, queries INFORMATION_SCHEMA.KEY_COLUMN_USAGE to detect
   * the FKs declared in the DB and include them as relations in the prefetch.
   */
  @Column({ type: 'boolean', default: false })
  prefetchRelations: boolean;

  /**
   * Enriched schema (tables, columns, comments, relations, deny flag) generated
   * by introspection + AI and editable by the user. When present it feeds the
   * SQL prefetch (instead of live introspection) and the `deny` enforcement in the guard.
   * It lives only in the app: it is NEVER written to the external DB.
   */
  @Column({ type: 'jsonb', nullable: true })
  schemaManifest: SchemaManifest | DocumentManifest | KeyspaceManifest | null;

  /**
   * Visibility scope:
   *   personal — visible/usable only by the creator
   *   team     — visible/usable by members of `teamId`; managed by admin or team owner
   *   org      — visible/usable by everyone; management reserved to admins
   */
  @Column({ type: 'varchar', length: 20, default: 'personal' })
  scope: DataSourceScope;

  /** Reference team when scope='team' (null otherwise). */
  @Column({ type: 'uuid', nullable: true, default: null })
  teamId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
