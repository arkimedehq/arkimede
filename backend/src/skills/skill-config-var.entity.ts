/**
 * @file skill-config-var.entity.ts
 *
 * Configuration variables set by the user for a skill.
 *
 * The variables allow customizing the skill's behavior without modifying
 * the package. Each variable corresponds to an entry declared in the
 * `runtime.config` section of the SKILL.md frontmatter.
 *
 * Example (SKILL.md frontmatter):
 *   runtime:
 *     config:
 *       - key: OUTPUT_DIR
 *         default: "${UPLOAD_DIR}/pdfs"
 *       - key: API_KEY
 *         secret: true
 *
 * Values not set by the user use the spec `default` (with resolution of
 * system variables ${UPLOAD_DIR}, ${APP_NAME}, …).
 *
 * `isSecret` values are masked in API responses (never exposed).
 */
import {
  Column, CreateDateColumn, Entity, JoinColumn,
  ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from 'typeorm';
import { Skill } from './skill.entity';

@Entity('skill_config_vars')
@Unique(['skillId', 'key'])
export class SkillConfigVar {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  skillId: string;

  @ManyToOne(() => Skill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'skillId' })
  skill: Skill;

  /** Variable name, corresponds to the key in the SKILL.md config spec */
  @Column({ type: 'varchar', length: 128 })
  key: string;

  /** Value set by the user (null = use the spec default) */
  @Column({ type: 'text', nullable: true })
  value: string | null;

  /**
   * If true: the value is never exposed in the API response.
   * Determined by the spec declared in SKILL.md (secret: true).
   */
  @Column({ type: 'boolean', default: false })
  isSecret: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
