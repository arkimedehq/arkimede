/**
 * @file local-mcp-process.ts
 *
 * Management of a local stdio MCP process launched directly by the NestJS backend.
 *
 * Used by the 'local' transport (backend and program on the same machine).
 * The 'remote' transport uses the Electron bridge instead (McpBridgeGateway).
 *
 * Architecture:
 *   - Spawns the command as a child_process with stdio: pipe
 *   - Communicates via JSON-RPC over stdin/stdout (MCP protocol)
 *   - Runs initialize → notifications/initialized → tools/list on startup
 *   - Keeps the tools in cache; re-discovers them only on restart
 *   - Auto-restart with a fixed 5s backoff on crash
 *   - `stop()` disables the restart and terminates the process (SIGTERM → SIGKILL)
 *
 * Port of McpProcess from the Electron bridge (bridge/src/main/mcp-process.ts),
 * adapted for NestJS (Logger instead of callback, no EventEmitter).
 */
import { spawn, execSync, ChildProcess } from 'child_process';
import { Logger } from '@nestjs/common';

// ── Login shell PATH ────────────────────────────────────────────────────
// NestJS processes launched as services/daemons don't inherit the full PATH
// (nvm, Homebrew, pyenv, Cargo…). We resolve it once.
let _shellPath: string | null = null;

function getShellPath(): string {
  if (_shellPath !== null) return _shellPath;

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    _shellPath = execSync(`${shell} -ilc 'echo $PATH' 2>/dev/null`, {
      encoding: 'utf8',
      timeout:  4000,
    }).trim();
  } catch {
    _shellPath = [
      process.env.PATH,
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ].filter(Boolean).join(':');
  }

  return _shellPath!;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type LocalMcpStatus = 'stopped' | 'starting' | 'running' | 'error';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject:  (reason: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

// ── Class ────────────────────────────────────────────────────────────────────

export class LocalMcpProcess {
  private process: ChildProcess | null = null;
  private buffer = '';
  private pendingRequests = new Map<number | string, PendingRequest>();
  private _requestId = 100;
  private _status: LocalMcpStatus = 'stopped';
  private _tools: LocalMcpTool[] = [];
  private _error?: string;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private shouldRestart = true;

  constructor(
    /** McpServer record ID — used for logging */
    public readonly serverId:   string,
    /** Display name — used for logging */
    public readonly serverName: string,
    /**
     * Command to execute. May contain spaces (e.g. "npx -y @mcp/server"):
     * it is automatically split into [cmd, ...extraArgs] + args.
     */
    private readonly command:   string,
    /** Extra arguments passed after the command */
    private readonly args:      string[],
    /** Additional environment variables (already with interpolated secrets) */
    private readonly env:       Record<string, string>,
    private readonly logger:    Logger,
  ) {}

  get status(): LocalMcpStatus { return this._status; }
  get tools():  LocalMcpTool[] { return this._tools; }
  get error():  string | undefined { return this._error; }

  // ── Startup ─────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.shouldRestart = true;
    await this.spawnProcess();
  }

  private async spawnProcess(): Promise<void> {
    // Clean up the previous process if present
    if (this.process) {
      this.process.removeAllListeners();
      this.process.kill('SIGKILL');
      this.process = null;
    }

    this.buffer = '';
    this._status = 'starting';
    this.logger.log(`[${this.serverName}] Starting: ${this.command} ${this.args.join(' ')}`);

    // Split the command: "npx -y @mcp/server-fs" → cmd="npx", extraArgs=["-y","@mcp/server-fs"]
    const cmdParts = this.command.trim().split(/\s+/);
    let cmd = cmdParts[0];
    const allArgs = [...cmdParts.slice(1), ...this.args];

    // Windows: npm/npx/python require the .cmd extension
    if (process.platform === 'win32' && !cmd.endsWith('.exe') && !cmd.endsWith('.cmd')) {
      cmd = cmd + '.cmd';
    }

    const spawnEnv = {
      ...process.env,
      ...this.env,
      PATH: getShellPath(),
    };

    try {
      this.process = spawn(cmd, allArgs, {
        env:   spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.serverName}] Unable to start: ${msg}`);
      this._status = 'error';
      this._error  = msg;
      this.scheduleRestart();
      return;
    }

    this.process.stdout?.setEncoding('utf8');
    this.process.stderr?.setEncoding('utf8');

    this.process.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    this.process.stderr?.on('data', (chunk: string) => {
      this.logger.warn(`[${this.serverName}] stderr: ${chunk.trim()}`);
    });

    this.process.on('error', (err) => {
      this.logger.error(`[${this.serverName}] Process error: ${err.message}`);
      this._status = 'error';
      this._error  = err.message;
      this.scheduleRestart();
    });

    this.process.on('exit', (code, signal) => {
      this.logger.warn(`[${this.serverName}] Terminated (code=${code}, signal=${signal})`);

      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP process terminated (code=${code})`));
      }
      this.pendingRequests.clear();

      if (this._status !== 'stopped') {
        this._status = 'stopped';
      }
      if (this.shouldRestart) {
        this.scheduleRestart();
      }
    });

    // MCP handshake
    try {
      await this.initialize();
      this._tools  = await this.listTools();
      this._status = 'running';
      this._error  = undefined;
      this.logger.log(
        `[${this.serverName}] Ready. Tools: ${this._tools.map((t) => t.name).join(', ') || '(none)'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.serverName}] Initialization failed: ${msg}`);
      this._status = 'error';
      this._error  = msg;
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (!this.shouldRestart) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.logger.log(`[${this.serverName}] Restarting in 5s...`);
    this.restartTimer = setTimeout(() => {
      if (this.shouldRestart) {
        this.spawnProcess().catch(() => {});
      }
    }, 5_000);
  }

  // ── Buffer JSON-RPC ───────────────────────────────────────────────────────

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer  = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        // Not JSON — process startup output
        this.logger.debug(`[${this.serverName}] stdout: ${trimmed}`);
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response: has `id` + (`result` or `error`)
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const id      = msg.id as number | string;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        if ('error' in msg) {
          const rpcErr = msg.error as { message?: string };
          pending.reject(new Error(rpcErr.message ?? 'RPC error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
    // Notifications (no id) — ignored
  }

  private sendRequest(method: string, params: unknown, id?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Process not available'));
        return;
      }

      const requestId = id ?? ++this._requestId;
      const payload   = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n';

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timeout for "${method}" (id=${requestId})`));
      }, 30_000);

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      this.process.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          reject(err);
        }
      });
    });
  }

  // ── MCP protocol ───────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    await this.sendRequest(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        clientInfo:      { name: 'Arkimede-local', version: '1.0.0' },
      },
      1,
    );

    // "initialized" notification required by some MCP servers
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
      );
    }
  }

  private async listTools(): Promise<LocalMcpTool[]> {
    const result = (await this.sendRequest('tools/list', {}, 2)) as {
      tools?: Array<{
        name:        string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };

    return (result?.tools ?? []).map((t) => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? {},
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.sendRequest(
      'tools/call',
      { name, arguments: args },
    )) as {
      content?:  Array<{ type: string; text?: string }>;
      isError?:  boolean;
    };

    if (result?.isError) {
      const errText = result.content?.find((c) => c.type === 'text')?.text;
      throw new Error(errText ?? 'Tool call error');
    }

    const text = (result?.content ?? [])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    return text || JSON.stringify(result);
  }

  // ── Stop ─────────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.shouldRestart = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Process stopped'));
    }
    this.pendingRequests.clear();
    this._status = 'stopped';

    if (this.process) {
      this.process.kill('SIGTERM');
      // Waits up to 3s, then SIGKILL
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 3_000);
        this.process?.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
      this.process = null;
    }
  }
}
