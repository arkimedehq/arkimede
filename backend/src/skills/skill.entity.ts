/**
 * @file skill.entity.ts
 *
 * TypeORM entity for Skills — packages of specialized instructions +
 * executable scripts (JS/Python) uploaded as a ZIP by the user.
 *
 * Lifecycle:
 *   Upload ZIP → status 'pending'
 *   → skill-executor installs deps → status 'installing'
 *   → deps ready → status 'ready' | 'error'
 *
 * Scope (same pattern as CustomTool):
 *   personal — visible/usable only by the creator
 *   shared   — visible to everyone; requires is_approved=true to be activated
 *
 * System prompt integration (3 levels):
 *   Level 1 → (name, description) always injected as <available_skills> metadata
 *   Level 2 → SKILL.md read from filesystem and injected for skills assigned to the project
 *   Level 3 → scripts executed on-demand via LangGraph tools
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn, Unique,
} from 'typeorm';
import { User } from '../users/users.entity';
import { SkillScript } from './skill-script.entity';
import { SkillProjectAssignment } from './skill-project-assignment.entity';
import { SkillConfigVar } from './skill-config-var.entity';

export type SkillStatus = 'pending' | 'installing' | 'ready' | 'error';
export type SkillScope  = 'personal' | 'team' | 'org';

/**
 * Spec of a single configuration variable declared in SKILL.md.
 * Stored as JSONB in the skill's `configSpec` column.
 */
export interface SkillConfigSpec {
  key:          string;
  description:  string;
  default?:     string;   // may contain ${SYSTEM_VAR} (e.g. "${UPLOAD_DIR}/pdfs")
  required:     boolean;
  secret:       boolean;  // if true: never exposed in API responses
  /**
   * Value type:
   *   'text'       — single-line input (default)
   *   'json'       — multi-line textarea for JSON objects
   *   'datasource' — dropdown with the connections configured by the user; stores the ID
   *   'collection' — dropdown with the configured vector collections; stores the name
   */
  type?:        'text' | 'json' | 'datasource' | 'collection';
  /**
   * Only for type='datasource': filters the dropdown to only the DataSources of
   * the given family (e.g. 'fileshare' → smb/sftp/webdav). Absent = all.
   */
  family?:      'relational' | 'document' | 'keyvalue' | 'fileshare';
}

@Entity('skills')
@Unique(['ownerId', 'name'])   // each user has its own namespace of names
export class Skill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @Column({ type: 'uuid' })
  ownerId: string;

  /**
   * Slug name of the skill — used as prefix for the generated LangGraph tools.
   * Format: lowercase letters, numbers, hyphens.
   * E.g.: "data-analyzer" generates the tool "skill_data_analyzer_analyze_py"
   */
  @Column({ type: 'varchar', length: 64 })
  name: string;

  /** Version declared in SKILL.md (e.g. "1.0.0") */
  @Column({ type: 'varchar', length: 32, default: '1.0.0' })
  version: string;

  /**
   * Description for the AI — Level 1 of the progressive-loading system.
   * ALWAYS injected into the system prompt as <available_skills> metadata.
   * Must answer: what it does, when to use it, when NOT to use it.
   */
  @Column({ type: 'text' })
  description: string;

  /** Author declared in SKILL.md (email or name) */
  @Column({ type: 'varchar', length: 256, nullable: true })
  author: string | null;

  /** License declared in SKILL.md */
  @Column({ type: 'varchar', length: 64, nullable: true })
  license: string | null;

  /**
   * Installation lifecycle status:
   *   pending    → skill uploaded, installation not yet started
   *   installing → skill-executor is installing the dependencies
   *   ready      → deps installed, scripts ready to run
   *   error      → installation failed (see installLog for details)
   */
  @Column({
    type: 'enum',
    enum: ['pending', 'installing', 'ready', 'error'],
    default: 'pending',
  })
  status: SkillStatus;

  /**
   * Skill kind:
   *   typed       → declares `runtime.scripts` with input_schema → each script is a LangGraph tool
   *   descriptive → only SKILL.md (+ bundled scripts/), no script manifest → "pure"
   *                 agentskills.io format: the agent reads the instructions and runs the files via sandbox.
   * Derived at install: presence of scripts in the manifest ? 'typed' : 'descriptive'.
   */
  @Column({ type: 'varchar', length: 16, default: 'typed' })
  kind: 'typed' | 'descriptive';

  /**
   * Successful sandbox executions attributed to this descriptive skill
   * (the executed code references `skills/<name>/`). At the threshold the owner
   * gets a "compile to tool" suggestion; reset to 0 by applyCompilation.
   */
  @Column({ type: 'int', default: 0 })
  sandboxRuns: number;

  /** Full installation log (stdout/stderr of pip+npm). Null if not yet started. */
  @Column({ type: 'text', nullable: true, default: null })
  installLog: string | null;

  /**
   * Visibility scope (identical to CustomTool):
   *   personal → only the creator can see and use the skill
   *   team     → visible to the members of `teamId`; the team owner publishes directly (no review)
   *   org      → visible to the whole org, but only after admin approval (isApproved=true)
   */
  @Column({ type: 'varchar', length: 20, default: 'personal' })
  scope: SkillScope;

  /** Reference team when scope='team' (null otherwise). */
  @Column({ type: 'uuid', nullable: true, default: null })
  teamId: string | null;

  /**
   * Admin review gate. Relevant only for scope='org'.
   * An org skill with isApproved=false is invisible to other users.
   * 'team' skills do not use this gate (direct publication by the owner).
   */
  @Column({ type: 'boolean', default: false })
  isApproved: boolean;

  /**
   * Enables/disables the skill without deleting it.
   * A disabled skill is not loaded as a LangGraph tool
   * nor injected into the system prompt — as if it did not exist for the agent.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * If false, the skill's script-tools do not enter the flat context of the
   * chat: they remain usable only via an agent that includes them. Default true.
   */
  @Column({ type: 'boolean', default: true })
  loadOnFirst: boolean;

  /**
   * Absolute path of the skill's directory on the shared volume.
   * Format: /app/skills/{id}
   * Populated right after the ZIP extraction.
   */
  @Column({ type: 'varchar', length: 512, nullable: true, default: null })
  packagePath: string | null;

  /**
   * Python dependencies declared in SKILL.md (e.g. ["pandas>=2.0", "numpy>=1.24"]).
   * Stored to allow reinstallation without re-reading the ZIP.
   */
  @Column({ type: 'jsonb', default: [] })
  pythonDeps: string[];

  /**
   * JavaScript dependencies declared in SKILL.md (e.g. ["lodash@4.17.21"]).
   * Stored to allow reinstallation without re-reading the ZIP.
   */
  @Column({ type: 'jsonb', default: [] })
  jsDeps: string[];

  /**
   * System dependencies declared in SKILL.md → dependencies.system.nix.
   * nixpkgs package names (e.g. ["cowsay", "imagemagick", "ffmpeg"]).
   * Stored to allow reinstallation without re-reading the ZIP.
   */
  @Column({ type: 'jsonb', default: [] })
  nixDeps: string[];

  /**
   * Network domains allowed to the skill (C1), from SKILL.md → `network:`.
   * Default [] = no egress (beyond the registries for the install). The egress-proxy
   * allowlist = registries ∪ union of the domains of the approved/enabled skills.
   */
  @Column({ type: 'jsonb', default: [] })
  networkDomains: string[];

  /**
   * Reserved networks GRANTED to this skill by an admin (Phase 3). Each entry is a
   * catalog `id` (see SKILL_NETWORK_CATALOG) mapping to an operator-provisioned Docker
   * network (LAN/VPN/subnet). Default [] = only the baseline internal BE network.
   * The domain egress (networkDomains) is separate and author-declared.
   */
  @Column({ type: 'jsonb', default: [] })
  grantedNetworks: string[];

  /**
   * Spec of the configuration variables declared in SKILL.md.
   * Null if SKILL.md has no `config:` section.
   */
  @Column({ type: 'jsonb', nullable: true, default: null })
  configSpec: SkillConfigSpec[] | null;

  /** Scripts exposed as LangGraph tools — denormalized from SKILL.md for fast queries */
  @OneToMany(() => SkillScript, (s) => s.skill, { cascade: true, eager: false })
  scripts: SkillScript[];

  /** Assignments of the skill to specific projects */
  @OneToMany(() => SkillProjectAssignment, (a) => a.skill, { cascade: true, eager: false })
  projectAssignments: SkillProjectAssignment[];

  /**
   * ID of the source skill this one was installed from (marketplace or registry).
   * Null if the skill was uploaded directly as a ZIP by the user.
   * Used for "Sync from marketplace": copies the updated files from the source
   * preserving the user's SkillConfigVars.
   * ON DELETE SET NULL — if the source is deleted, the copies remain.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  sourceSkillId: string | null;

  /** Configuration variables set by the user */
  @OneToMany(() => SkillConfigVar, (v) => v.skill, { cascade: true, eager: false })
  configVars: SkillConfigVar[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
