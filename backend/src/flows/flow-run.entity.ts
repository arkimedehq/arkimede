/**
 * @file flow-run.entity.ts
 *
 * Execution history of a Flow (observability + debug).
 *
 * Each run saves the final state (`state`: input + output per node) and a
 * per-node timeline (`nodeRuns`: status/duration/error). The flow can be
 * deleted without losing the history → FK ON DELETE SET NULL on flowId.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';
import { FlowRunState, FlowRunStatus, FlowTriggeredBy, NodeRunRecord } from './flow.types';

@Entity('flow_runs')
export class FlowRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  flowId: string | null;

  /** Snapshot of the flow name at run time (survives deletion). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  flowName: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'uuid', nullable: true })
  projectId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'manual' })
  triggeredBy: FlowTriggeredBy;

  @Column({ type: 'varchar', length: 16, default: 'running' })
  status: FlowRunStatus;

  /** input + nodes[].output at the end (or on error) of the run. */
  @Column({ type: 'jsonb', default: { input: {}, nodes: {} } })
  state: FlowRunState;

  /** Per-node timeline (debug). */
  @Column({ type: 'jsonb', default: [] })
  nodeRuns: NodeRunRecord[];

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt: Date | null;
}
