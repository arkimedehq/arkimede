import api from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SkillStatus = 'pending' | 'installing' | 'ready' | 'error';
export type SkillScope  = 'personal' | 'team' | 'org';
export type ScriptLang  = 'python' | 'javascript' | 'node';
/**
 * Script execution mode:
 *   'task'   — one-shot, invoked by the LLM as a tool or by the user manually
 *   'daemon' — long-running process started by the user, managed by DaemonsService
 *   'info'   — status/diagnostics script run automatically by the UI
 *              when opening the drawer. Not exposed to the LLM. No input required.
 */
export type ScriptMode  = 'task' | 'daemon' | 'info';

export interface SkillScript {
  id:          string;
  skillId:     string;
  filename:    string;
  language:    ScriptLang;
  /** 'task' (default) = invoked by the LLM; 'daemon' = background process */
  mode:        ScriptMode;
  /**
   * If false, the script is invocable only via the inter-skill bus —
   * it is not exposed to the LLM as a LangGraph tool.
   */
  llmCallable:  boolean;
  description:  string;
  inputSchema:  Record<string, unknown> | null;
  /** Free note injected into the LLM tool description. Null = no note. */
  contextNote:     string | null;
  /** Last output of the skill's info script. Automatic fallback if contextNote is null. */
  lastInfoOutput:  string | null;
}

/** Result of a manual script execution */
export interface ExecuteScriptResult {
  success:     boolean;
  /** Stdout parsed as JSON, null if it was not valid JSON */
  output:      unknown | null;
  /** Raw stdout */
  raw:         string;
  duration_ms: number;
  exit_code:   number;
  stderr?:     string;
}

export interface SkillConfigSpecEntry {
  key:         string;
  description: string;
  default?:    string;
  required:    boolean;
  secret:      boolean;
  /** 'text' = single-line input (default); 'json' = textarea; 'datasource' = connections dropdown; 'collection' = vector collections dropdown */
  type?:       'text' | 'json' | 'datasource' | 'collection';
  /** type='datasource' only: filters the dropdown to the indicated family (e.g. 'fileshare'). */
  family?:     'relational' | 'document' | 'keyvalue' | 'fileshare';
}

export interface Skill {
  id:          string;
  ownerId:     string;
  name:        string;
  version:     string;
  description: string;
  author:      string | null;
  license:     string | null;
  status:      SkillStatus;
  /** 'typed' = scripts as typed tools; 'descriptive' = SKILL.md only, run via sandbox. */
  kind:        'typed' | 'descriptive';
  /** Successful sandbox runs attributed to the (descriptive) skill — compile suggestion at ≥5. */
  sandboxRuns?: number;
  installLog:  string | null;
  scope:       SkillScope;
  teamId:      string | null;
  isApproved:  boolean;
  /** Skill enabled/disabled without deleting it. Default true. */
  enabled:     boolean;
  /** If false, the skill's script-tools do not enter the chat's flat context (only via agent). */
  loadOnFirst: boolean;
  packagePath: string;
  pythonDeps:  string[];
  jsDeps:      string[];
  /** External domains the skill declared (SKILL.md runtime.network) → egress allowlist. */
  networkDomains?: string[];
  /** Reserved networks granted to this skill by an admin (catalog ids, Phase 3). */
  grantedNetworks?: string[];
  scripts:     SkillScript[];
  configSpec:  SkillConfigSpecEntry[] | null;
  /**
   * ID of the source skill this one was installed from (marketplace or registry).
   * Null if the skill was uploaded directly as a ZIP.
   * Present → shows the "Sync from marketplace" button.
   */
  sourceSkillId: string | null;
  createdAt:   string;
  updatedAt:   string;
}

/** Typed manifest (S3): proposed by the AI and confirmed by the user. */
export interface CompiledScript {
  filename:     string;
  language:     string;
  description:  string;
  input_schema: Record<string, unknown>;
  llm_callable?: boolean;
  /** AI-generated source (synthesis): written to disk on compilation. */
  code?:        string;
}

export interface SkillProjectAssignment {
  id:         string;
  skillId:    string;
  projectId:  string;
  assignedAt: string;
}

export interface UpdateSkillPayload {
  description?: string;
  scope?:       SkillScope;
  teamId?:      string | null;
  loadOnFirst?: boolean;
}

// ── Registry types ────────────────────────────────────────────────────────────

export interface RegistrySkill {
  name:         string;
  version:      string;
  description:  string;
  author:       string;
  license:      string;
  languages:    ('python' | 'node' | 'javascript')[];
  tags:         string[];
  scriptCount:  number;
  dependencies: { python: string[]; javascript: string[] };
  downloadUrl:  string;
  homepage?:    string;
  publishedAt:  string;
  checksum?:    string;
}

export interface RegistryIndex {
  version:   string;
  updatedAt: string;
  skills:    RegistrySkill[];
}

export interface RejectPayload {
  reason: string;
}

/** A reserved network the operator provisioned and can grant to skills (Phase 3). */
export interface SkillNetwork {
  id:            string;
  dockerNetwork: string;
  label:         string;
  description:   string;
  /** 'lan' = well-known LAN/VPN preset, 'custom' = arbitrary operator-defined network. */
  kind:          'lan' | 'custom';
}

// ── Config vars ───────────────────────────────────────────────────────────────

export interface ConfigVarEntry {
  key:          string;
  description:  string;
  default?:     string;
  required:     boolean;
  secret:       boolean;
  /** 'text' = single-line input (default); 'json' = textarea; 'datasource' = connections dropdown; 'collection' = vector collections dropdown */
  type?:        'text' | 'json' | 'datasource' | 'collection';
  /** type='datasource' only: filters the dropdown to the indicated family (e.g. 'fileshare'). */
  family?:      'relational' | 'document' | 'keyvalue' | 'fileshare';
  /** Value set by the user (null = use default). Secrets show '••••'. */
  value:        string | null;
  /** Resolved value (empty for secrets). */
  resolved:     string;
  isOverridden: boolean;
}

export interface SkillConfigResponse {
  systemVars:      Record<string, string>;
  systemVarNames:  string[];
  vars:            ConfigVarEntry[];
}

// ── API client ────────────────────────────────────────────────────────────────

export const skillsApi = {
  /** List personal + approved shared skills */
  list: () =>
    api.get<Skill[]>('/skills').then((r) => r.data),

  /** Skills for a specific project */
  listByProject: (projectId: string) =>
    api.get<Skill[]>(`/skills/project/${projectId}`).then((r) => r.data),

  /** Skills awaiting review (admin) */
  pendingReview: () =>
    api.get<Skill[]>('/skills/pending-review').then((r) => r.data),

  /** Single skill detail */
  getById: (id: string) =>
    api.get<Skill>(`/skills/${id}`).then((r) => r.data),

  /** Upload ZIP — uses FormData */
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<Skill>('/skills/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },

  /** Update description and/or scope */
  update: (id: string, payload: UpdateSkillPayload) =>
    api.patch<Skill>(`/skills/${id}`, payload).then((r) => r.data),

  /** Delete skill */
  remove: (id: string) =>
    api.delete<{ message: string }>(`/skills/${id}`).then((r) => r.data),

  /** Reinstall the dependencies */
  reinstall: (id: string) =>
    api.post<{ message: string }>(`/skills/${id}/reinstall`).then((r) => r.data),

  /** S3: the AI proposes a typed manifest (input_schema) for the descriptive skill's scripts. */
  proposeCompilation: (id: string) =>
    api.post<{ scripts: CompiledScript[] }>(`/skills/${id}/propose-compilation`).then((r) => r.data),

  /** S3: applies the confirmed compilation → the skill becomes typed. */
  compile: (id: string, scripts: CompiledScript[]) =>
    api.post<Skill>(`/skills/${id}/compile`, { scripts }).then((r) => r.data),

  /** Update an existing skill by uploading a new ZIP (preserves the config vars) */
  updateFromZip: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<Skill>(`/skills/${id}/upload-update`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },

  /** Sync the skill with the current version of the marketplace source (preserves the config vars) */
  syncFromSource: (id: string) =>
    api.post<Skill>(`/skills/${id}/sync-from-source`).then((r) => r.data),

  /** Enable or disable a skill */
  setEnabled: (id: string, enabled: boolean) =>
    api.patch<Skill>(`/skills/${id}/enabled`, { enabled }).then((r) => r.data),

  /** Toggle a script's LLM visibility (owner only, bidirectional). */
  setScriptLlmCallable: (skillId: string, scriptId: string, llmCallable: boolean) =>
    api.patch<SkillScript>(`/skills/${skillId}/scripts/${scriptId}/llm-callable`, { llmCallable })
      .then((r) => r.data),

  /** Save (or clear) the LLM context note for a script (owner only). */
  setScriptContextNote: (skillId: string, scriptId: string, contextNote: string | null) =>
    api.patch<SkillScript>(`/skills/${skillId}/scripts/${scriptId}/context-note`, { contextNote })
      .then((r) => r.data),

  /** Install a skill from the local marketplace into your own collection */
  install: (id: string) =>
    api.post<Skill>(`/skills/${id}/install`).then((r) => r.data),

  // ── Public registry ──────────────────────────────────────────────────

  /** Index of the public GitHub registry (cached 5 min server-side) */
  fetchRegistry: () =>
    api.get<RegistryIndex>('/skills/registry').then((r) => r.data),

  /** Install a skill from the registry by downloading the ZIP from GitHub */
  installFromRegistry: (downloadUrl: string) =>
    api.post<Skill>('/skills/registry/install', { downloadUrl }).then((r) => r.data),

  /** [Admin] Force registry cache refresh */
  refreshRegistry: () =>
    api.post<{ message: string }>('/skills/registry/refresh').then((r) => r.data),

  /** Assign to project */
  assign: (id: string, projectId: string) =>
    api.post<SkillProjectAssignment>(`/skills/${id}/assign/${projectId}`).then((r) => r.data),

  /** Remove from project */
  unassign: (id: string, projectId: string) =>
    api.delete<{ message: string }>(`/skills/${id}/assign/${projectId}`).then((r) => r.data),

  /** Approve shared skill (admin) */
  approve: (id: string) =>
    api.post<Skill>(`/skills/${id}/approve`).then((r) => r.data),

  /** Reject shared skill (admin) */
  reject: (id: string, reason: string) =>
    api.post<Skill>(`/skills/${id}/reject`, { reason } as RejectPayload).then((r) => r.data),

  // ── Reserved networks (admin, Phase 3) ─────────────────────────────────────

  /** [Admin] Catalog of assignable reserved networks (SKILL_NETWORK_CATALOG) */
  getNetworkCatalog: () =>
    api.get<SkillNetwork[]>('/skills/networks/catalog').then((r) => r.data),

  /** [Admin] Set the reserved networks granted to a skill (catalog ids) */
  setNetworks: (id: string, grantedNetworks: string[]) =>
    api.put<Skill>(`/skills/${id}/networks`, { grantedNetworks }).then((r) => r.data),

  // ── Config vars ──────────────────────────────────────────────────────────

  /** System variables available for the skill defaults */
  getSystemVars: () =>
    api.get<Record<string, string>>('/skills/system-vars').then((r) => r.data),

  /** Skill configuration state: spec + current values + resolved */
  getConfig: (id: string) =>
    api.get<SkillConfigResponse>(`/skills/${id}/config`).then((r) => r.data),

  /** Set or update a configuration value */
  setConfigVar: (id: string, key: string, value: string) =>
    api.put<{ message: string }>(`/skills/${id}/config/${key}`, { value }).then((r) => r.data),

  /** Removes the override — the variable reverts to the default value */
  resetConfigVar: (id: string, key: string) =>
    api.delete<{ message: string }>(`/skills/${id}/config/${key}`).then((r) => r.data),

  /**
   * Returns the content of the skill's documentation file.
   * Looks for SKILL.md first, then README.md.
   */
  getDocs: (id: string) =>
    api.get<{ filename: string; content: string }>(`/skills/${id}/docs`).then((r) => r.data),

  /**
   * Manually runs a task script (owner only, ready skill).
   *
   * @param skillId   Skill UUID
   * @param script    Script filename (e.g. "scripts/train.py")
   * @param input     Text/numeric input fields (non-file)
   * @param files     Files to upload: { fieldname → File }
   *                  The fieldname corresponds to the input key that will receive the path
   *                  (e.g. { csv_path: File } → input.csv_path = <temporary path>)
   * @param timeoutMs Timeout in ms (default 120000, max 600000)
   */
  executeScript: (
    skillId:    string,
    script:     string,
    input:      Record<string, unknown>,
    files?:     Record<string, File>,
    timeoutMs?: number,
  ): Promise<ExecuteScriptResult> => {
    const form = new FormData();
    form.append('script', script);
    form.append('input', JSON.stringify(input));
    if (timeoutMs != null) form.append('timeout_ms', String(timeoutMs));
    if (files) {
      for (const [fieldname, file] of Object.entries(files)) {
        form.append(fieldname, file, file.name);
      }
    }
    return api.post<ExecuteScriptResult>(`/skills/${skillId}/execute`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data);
  },
};
