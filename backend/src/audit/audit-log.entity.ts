import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Audit log row (E4): a relevant security event.
 *
 * The DB copy serves the admin viewer; the tamper-evident copy is the structured
 * JSON row emitted on stdout (→ CloudWatch / S3 Object Lock in prod).
 *
 * Rule: NEVER secrets/contents/PII in `ctx` — only identifiers, shape, outcome.
 */
@Entity('audit_log')
@Index(['action', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn()
  @Index()
  createdAt: Date;

  /** Who acted (null for system / unauthenticated actions). */
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', nullable: true })
  actorName: string | null;

  /** "Impersonated" identity (runs-as) if different from the actor — e.g. automations. */
  @Column({ type: 'uuid', nullable: true })
  actAsId: string | null;

  /** Action, e.g. 'mcp.create', 'skill.registry_install', 'auth.login'. */
  @Column({ type: 'varchar' })
  action: string;

  /** Touched resource (id or name), optional. */
  @Column({ type: 'varchar', nullable: true })
  resource: string | null;

  /** Outcome: 'ok' | 'denied' | 'error'. */
  @Column({ type: 'varchar' })
  outcome: string;

  /** Extra context (no secrets/PII). */
  @Column({ type: 'jsonb', nullable: true })
  ctx: Record<string, unknown> | null;
}
