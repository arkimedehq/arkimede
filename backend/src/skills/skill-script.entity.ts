/**
 * @file skill-script.entity.ts
 *
 * TypeORM entity for the executable scripts of a Skill.
 *
 * Each record corresponds to a file declared in the `scripts` section of SKILL.md.
 * It is denormalized from the YAML at upload time to allow:
 *   - fast queries without re-reading the ZIP
 *   - generation of LangGraph tools (one per script)
 *   - display in the UI without filesystem access
 *
 * Each script becomes a LangChain DynamicStructuredTool with name:
 *   skill_{skill.name}_{filename_sanitized}
 *   e.g.: skill_data_analyzer_analyze_py
 *
 * Execution is delegated to the skill-executor service via HTTP.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { Skill } from './skill.entity';

/**
 * Execution mode for JavaScript scripts:
 *   - 'isolated' (default): V8 isolate via isolated-vm — pure sandbox, no Node APIs
 *   - 'node': real Node.js subprocess — full access to Node APIs and npm deps
 *
 * Python scripts ignore this field (they always use the subprocess runner).
 */
export type ScriptSandbox = 'isolated' | 'node';
/**
 * Execution mode:
 *   'task'   — one-shot, invoked by the LLM as a tool or by the user manually
 *   'daemon' — long-running process started by the user (not exposed to the LLM)
 *   'info'   — status/diagnostics script, run automatically by the UI
 *              when the drawer opens. Not exposed to the LLM. No input required.
 *              Returns JSON with runtime data (e.g. list of trained models).
 */
export type ScriptMode = 'task' | 'daemon' | 'info';
export type ScriptLanguage = 'python' | 'javascript' | 'node';

@Entity('skill_scripts')
export class SkillScript {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Skill, (s) => s.scripts, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'skillId' })
  skill: Skill;

  @Column({ type: 'uuid' })
  skillId: string;

  /**
   * Relative path of the file within the ZIP package.
   * E.g.: "scripts/analyze.py", "scripts/transform.js"
   * Must correspond to a file present at packagePath + "/" + filename.
   */
  @Column({ type: 'varchar', length: 256 })
  filename: string;

  /**
   * Script language.
   *   'python'     → Python subprocess (always, ignores sandbox)
   *   'javascript' → isolated-vm sandbox (default for JS)
   *   'node'       → Node.js subprocess with npm deps (explicitly declared in SKILL.md)
   */
  @Column({
    type: 'enum',
    enum: ['python', 'javascript', 'node'],
  })
  language: ScriptLanguage;

  /**
   * Description for the LLM — becomes the description of the DynamicStructuredTool.
   * Must explain when to invoke this specific script.
   * E.g.: "Analyzes a CSV file and returns descriptive statistics (mean, median, etc.)"
   */
  @Column({ type: 'text' })
  description: string;

  /**
   * JSON Schema of the input expected by the script.
   * It is converted into a Zod schema by the factory at tool creation time.
   * Structure: { type: 'object', properties: { param: { type: 'string', description: '...' } } }
   */
  @Column({ type: 'jsonb', default: { type: 'object', properties: {} } })
  inputSchema: Record<string, unknown>;

  /**
   * Execution mode:
   *   'task'   (default) — one-shot script invoked by the LLM as a tool
   *   'daemon' — long-running process started by the user, communicates via PUSH_URL
   *
   * Daemon scripts are NOT exposed as LangGraph tools (they do not appear in loadToolsForUser).
   * They are instead handled by DaemonsService through their own API endpoints.
   */
  @Column({ type: 'varchar', length: 16, default: 'task' })
  mode: ScriptMode;

  /**
   * Controls whether the script is exposed to the LLM as a LangGraph DynamicStructuredTool.
   *
   * true  (default) — the script becomes a tool the agent can invoke autonomously.
   * false           — the script is executable ONLY via the inter-skill bus
   *                   (POST /internal/skills/:id/invoke) or by other automations.
   *                   It does not appear in the agent's context, does not consume tool-selection tokens.
   *
   * Typical use cases for llmCallable=false:
   *   - Inference scripts meant to be called by other skills (e.g. recommend.py)
   *   - Internal utility scripts not relevant to the end user
   *   - Scripts with technical output not intended for the conversation
   *
   * Note: this flag does not affect /internal/skills/:id/invoke — the direct
   * invocation always works regardless of the llmCallable value.
   */
  @Column({ type: 'boolean', default: true })
  llmCallable: boolean;

  /**
   * Free-form note editable by the user, injected by the agent service into the
   * DynamicStructuredTool's description. Used to communicate runtime details
   * to the LLM: trained models, available profiles, active dataset, etc.
   * Null = no additional note.
   */
  @Column({ type: 'text', nullable: true, default: null })
  contextNote: string | null;

  /**
   * Last stdout of the info script (mode='info') of the same skill.
   * Updated automatically by invoke() every time the info script
   * runs successfully (exit_code === 0).
   * Injected into the tool description as a fallback when contextNote is null.
   */
  @Column({ type: 'text', nullable: true, default: null })
  lastInfoOutput: string | null;
}
