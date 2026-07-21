/**
 * @file skill-project-assignment.entity.ts
 *
 * TypeORM entity for the assignment of a Skill to a specific project.
 *
 * When a skill is assigned to a project:
 *   1. The SKILL.md is injected into the system prompt as Level 2 (full instructions)
 *   2. The skill's scripts become tools available to all the project's chats
 *
 * A skill can be assigned to multiple projects; a project can have multiple skills.
 * The UNIQUE (skillId, projectId) constraint prevents duplicate assignments.
 *
 * Note: personal skills can only be assigned by the project owner.
 * Shared (approved) skills can be assigned by any member.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Skill } from './skill.entity';
import { Project } from '../projects/projects.entity';
import { User } from '../users/users.entity';

@Entity('skill_project_assignments')
@Unique(['skillId', 'projectId'])
export class SkillProjectAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Skill, (s) => s.projectAssignments, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'skillId' })
  skill: Skill;

  @Column({ type: 'uuid' })
  skillId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Column({ type: 'uuid' })
  projectId: string;

  /** User who made the assignment (for audit trail) */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assignedById' })
  assignedBy: User | null;

  @Column({ type: 'uuid', nullable: true })
  assignedById: string | null;

  @CreateDateColumn()
  assignedAt: Date;
}
