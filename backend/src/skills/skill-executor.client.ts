/**
 * @file skill-executor.client.ts
 *
 * HTTP client to the `skill-executor` service (Docker sidecar container).
 *
 * Exposes two operations:
 *   install()  → installs the Python/JS dependencies of a skill into the shared volume
 *   execute()  → executes a skill script with the provided parameters
 *
 * The base URL is read from SKILL_EXECUTOR_URL (default: http://skill-executor:4000).
 * In local development (outside Docker) the service may be unavailable:
 * the methods throw SkillExecutorUnavailableError in that case.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NetworkMode } from './skill-networks';

export interface InstallResult {
  ok: boolean;
  log: string;
  duration_ms: number;
}

export interface ExecuteRequest {
  skill_id:  string;
  filename:  string;
  /** 'python' | 'javascript' (isolated-vm) | 'node' (Node.js subprocess with npm deps) */
  language:  'python' | 'javascript' | 'node';
  input:     Record<string, unknown>;
  timeout_ms?: number;
  /** Resolved config vars (system + user override). Injected into the script by the executor. */
  config?:   Record<string, string>;
  /** Identity the skill runs as (C2) → USER_ID in the subprocess env. */
  user_id?:  string;
  /** Signed run token → INTERNAL_TOKEN in the subprocess env (internal API auth). */
  run_token?: string;
  /** Network tier: 'internet' when the skill declared external domains (runtime.network),
   * else omitted ('internal' baseline). The internal BE network is always attached. */
  network?:  NetworkMode;
  /** Reserved Docker networks granted to this skill by the admin (resolved docker names,
   * Phase 3). The job is multi-homed onto them; the broker re-validates each. */
  grantedNetworks?: string[];
  /** Authorized files to stage in the job's work dir (copy-in C2). */
  files?:    { param: string; hostPath: string; name: string }[];
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  /** Top-level deliverables materialized in the per-user skills-output dir this run. */
  outputs?: string[];
}

/** Request to execute arbitrary code/shell in the sandbox (run_in_sandbox tool). */
export interface SandboxRequest {
  /** Session = per-chat persistent workspace (keyed by chatId). */
  session_id: string;
  language:   'python' | 'node' | 'shell';
  /** Code/command to execute, written by the agent at runtime. */
  code:       string;
  user_id:    string;
  /** Signed run token → INTERNAL_TOKEN in the env (internal API auth). */
  run_token?: string;
  timeout_ms?: number;
  /** Job network tier: 'none' | 'internal' (backend) | 'internet' (allowlist) | 'open' (full). */
  network?:   NetworkMode;
  /** Execution profile: 'hardened' (default) | 'trusted' (writable rootfs + root). */
  exec_mode?: 'hardened' | 'trusted';
  /** Descriptive skills to copy into /workspace/skills/<name>/ (agentskills.io via sandbox). */
  skills?:    { name: string; hostPath: string; version?: string }[];
  /** Chat attachments to copy into inputs/ in the workspace (paths already ACL-checked). */
  attachments?: { name: string; hostPath: string }[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  /** Files present in the workspace after execution (relative paths), best-effort. */
  files?: string[];
  /** Top-level deliverables materialized in the per-user skills-output dir this run. */
  outputs?: string[];
  /** true = broker container-job; false = in-process (dev, NOT isolated). */
  isolated?: boolean;
}

/** Sandbox runtime mode reported by the executor's /health. */
export type SandboxRuntimeMode = 'broker' | 'in-process' | 'unavailable';

export interface DaemonStartRequest {
  skill_id:  string;
  daemon_id: string;
  filename:  string;
  language:  'python' | 'node';
  config?:   Record<string, string>;
  user_id:   string;
  push_url:  string;
  /** Signed daemon token → INTERNAL_TOKEN in the env (push events auth + internal APIs). */
  daemon_token?: string;
}

export interface DaemonStartResult {
  daemon_id:  string;
  pid:        number;
  started_at: string;
}

export interface DaemonStatusEntry {
  daemon_id:  string;
  skill_id:   string;
  filename:   string;
  user_id:    string;
  pid:        number;
  running:    boolean;
  started_at: string;
}

/** Result of an inline JS evaluation in the sandbox (Flow `transform` node). */
export interface EvalJsResult {
  ok:      boolean;
  output?: unknown;
  error?:  string;
}

export class SkillExecutorUnavailableError extends Error {
  constructor(cause?: string) {
    super(`skill-executor non raggiungibile${cause ? `: ${cause}` : ''}`);
    this.name = 'SkillExecutorUnavailableError';
  }
}

@Injectable()
export class SkillExecutorClient {
  private readonly logger  = new Logger(SkillExecutorClient.name);
  private readonly baseUrl: string;
  /** Service mesh secret (x-service-key header) to the executor. */
  private readonly serviceKey: string;

  /** Service-to-service headers common to all calls to the executor. */
  private svcHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-service-key': this.serviceKey, ...extra };
  }

  constructor(private readonly config: ConfigService) {
    this.serviceKey = config.get<string>('SERVICE_API_KEY', '');
    this.baseUrl = config.get<string>('SKILL_EXECUTOR_URL', 'http://skill-executor:4000');
  }

  /** Checks container reachability (used at startup for diagnostics). */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Installs the skill's Python, JS and system (Nix) dependencies into the shared volume.
   * The operation is potentially long (minutes for heavy deps) — the caller
   * must invoke it in the background and listen for the result to update the status.
   */
  async install(
    skillId:    string,
    pythonDeps: string[],
    jsDeps:     string[],
    nixDeps:    string[] = [],
  ): Promise<InstallResult> {
    return this.post<InstallResult>('/install', {
      skill_id:    skillId,
      python_deps: pythonDeps,
      js_deps:     jsDeps,
      nix_deps:    nixDeps,
    });
  }

  /**
   * Executes a skill script with the provided parameters.
   * Returns stdout, stderr, exit_code and duration.
   * exit_code !== 0 does not throw — the caller evaluates the result.
   */
  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    return this.post<ExecuteResult>('/execute', req);
  }

  /**
   * Executes arbitrary code/shell in the sandbox (per-session persistent workspace).
   * exit_code !== 0 does not throw — the caller evaluates the result.
   */
  async runSandbox(req: SandboxRequest): Promise<SandboxResult> {
    return this.post<SandboxResult>('/sandbox', req);
  }

  /**
   * Sandbox runtime mode from the executor's /health (best-effort):
   * null if the executor is unreachable or predates the `sandbox` field.
   */
  async sandboxRuntimeMode(): Promise<SandboxRuntimeMode | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return null;
      const body = await res.json() as { sandbox?: SandboxRuntimeMode };
      return body.sandbox ?? null;
    } catch { return null; }
  }

  /** Reads a file from the sandbox session workspace (download). null if absent. */
  async getSandboxFile(sessionId: string, filePath: string): Promise<{ name: string; mime: string; base64: string } | null> {
    const url = `${this.baseUrl}/sandbox/file`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.svcHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ session_id: sessionId, path: filePath }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ name: string; mime: string; base64: string }>;
    } catch (err: any) {
      throw new SkillExecutorUnavailableError(err.message);
    }
  }

  /**
   * Evaluates inline JS in the isolated-vm sandbox, with `input` as a global
   * variable and the last expression as output. Used by the Flow `transform` node
   * (the only place arbitrary server-side JS is allowed).
   */
  async evalJs(code: string, input: Record<string, unknown>, timeoutMs = 5000): Promise<EvalJsResult> {
    return this.post<EvalJsResult>('/eval', { code, input, timeout_ms: timeoutMs });
  }

  /** Starts a daemon process for a skill. Responds immediately (does not wait for completion). */
  async startDaemon(req: DaemonStartRequest): Promise<DaemonStartResult> {
    return this.post<DaemonStartResult>('/daemon/start', req);
  }

  /** Stops a running daemon process. */
  async stopDaemon(daemonId: string): Promise<{ daemon_id: string; stopped: boolean }> {
    return this.post('/daemon/stop', { daemon_id: daemonId });
  }

  /** Lists all daemons running in the executor. */
  async listDaemons(): Promise<DaemonStatusEntry[]> {
    const url = `${this.baseUrl}/daemon/list`;
    try {
      const res = await fetch(url, { headers: this.svcHeaders(), signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<DaemonStatusEntry[]>;
    } catch (err: any) {
      throw new SkillExecutorUnavailableError(err.message);
    }
  }

  /** Status of a single daemon. */
  async getDaemon(daemonId: string): Promise<DaemonStatusEntry | null> {
    const url = `${this.baseUrl}/daemon/${daemonId}`;
    try {
      const res = await fetch(url, { headers: this.svcHeaders(), signal: AbortSignal.timeout(5_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<DaemonStatusEntry>;
    } catch (err: any) {
      throw new SkillExecutorUnavailableError(err.message);
    }
  }

  // ─── Helper ───────────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;

    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.svcHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        // Generous timeout: install can take minutes
        signal: AbortSignal.timeout(360_000),
      });
    } catch (err: any) {
      this.logger.error(`skill-executor POST ${path} non raggiungibile: ${err.message}`);
      throw new SkillExecutorUnavailableError(err.message);
    }

    if (!res.ok && res.status !== 422) {
      const text = await res.text().catch(() => '');
      this.logger.error(`skill-executor POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new Error(`skill-executor error ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }
}
