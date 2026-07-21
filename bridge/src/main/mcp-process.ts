import { spawn, execSync, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { APP_NAME } from './app.config'

// ── Login shell PATH ────────────────────────────────────────────────────────
// Desktop apps don't inherit the full shell PATH (no nvm, no homebrew, etc.)
// We read it once by running a login shell and cache it.
let _shellPath: string | null = null

function getShellPath(): string {
  if (_shellPath !== null) return _shellPath

  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // -i = interactive, -l = login  →  loads .zshrc/.bashrc/nvm/homebrew/pyenv
    _shellPath = execSync(`${shell} -ilc 'echo $PATH' 2>/dev/null`, {
      encoding: 'utf8',
      timeout:  4000,
    }).trim()
  } catch {
    // Fallback: process PATH + common paths
    _shellPath = [
      process.env.PATH,
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ].filter(Boolean).join(':')
  }

  return _shellPath!
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type McpProcessStatus = 'starting' | 'running' | 'stopped' | 'error'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpProcess extends EventEmitter {
  private process: ChildProcess | null = null
  private buffer = ''
  private pendingRequests = new Map<number | string, PendingRequest>()
  private _requestId = 100
  private _status: McpProcessStatus = 'stopped'
  private _tools: McpTool[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private shouldRestart = true

  constructor(
    public readonly config: McpServerConfig,
    private onLog: (level: 'info' | 'warn' | 'error', msg: string) => void
  ) {
    super()
  }

  get status(): McpProcessStatus { return this._status }
  get tools(): McpTool[] { return this._tools }
  get pid(): number | undefined { return this.process?.pid }

  private nextId(): number {
    return ++this._requestId
  }

  private setStatus(s: McpProcessStatus, error?: string): void {
    this._status = s
    this.emit('status', { serverId: this.config.id, status: s, pid: this.pid, error })
  }

  async start(): Promise<void> {
    this.shouldRestart = true
    await this.spawnProcess()
  }

  private async spawnProcess(): Promise<void> {
    if (this.process) {
      this.process.removeAllListeners()
      this.process.kill('SIGKILL')
      this.process = null
    }

    this.buffer = ''
    this.setStatus('starting')
    this.onLog('info', `[${this.config.name}] Starting process: ${this.config.command} ${this.config.args.join(' ')}`)

    // Split the command string: "uvx freecad-mcp" → cmd="uvx", extraArgs=["freecad-mcp"]
    // The user often writes the full command in a single field (e.g. "npx -y pkg" or "uvx tool")
    const cmdParts = this.config.command.trim().split(/\s+/)
    let cmd = cmdParts[0]
    const args = [...cmdParts.slice(1), ...this.config.args]

    // On Windows the npm/npx commands need the .cmd extension
    if (process.platform === 'win32' && !cmd.endsWith('.exe') && !cmd.endsWith('.cmd')) {
      cmd = cmd + '.cmd'
    }

    // Full login shell PATH (includes nvm, homebrew, pyenv, cargo…)
    const shellPath = getShellPath()

    const env = {
      ...process.env,
      ...this.config.env,
      PATH: shellPath,
    }

    try {
      this.process = spawn(cmd, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.onLog('error', `[${this.config.name}] Unable to start: ${msg}`)
      this.setStatus('error', msg)
      this.scheduleRestart()
      return
    }

    this.process.stdout?.setEncoding('utf8')
    this.process.stderr?.setEncoding('utf8')

    this.process.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk
      this.processBuffer()
    })

    this.process.stderr?.on('data', (chunk: string) => {
      this.onLog('warn', `[${this.config.name}] stderr: ${chunk.trim()}`)
    })

    this.process.on('error', (err) => {
      this.onLog('error', `[${this.config.name}] Process error: ${err.message}`)
      this.setStatus('error', err.message)
      this.scheduleRestart()
    })

    this.process.on('exit', (code, signal) => {
      this.onLog('warn', `[${this.config.name}] Process exited (code=${code}, signal=${signal})`)
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`MCP process exited (code=${code})`))
      }
      this.pendingRequests.clear()

      if (this._status !== 'stopped') {
        this.setStatus('stopped')
      }
      if (this.shouldRestart) {
        this.scheduleRestart()
      }
    })

    // Initialize MCP
    try {
      await this.initialize()
      this._tools = await this.listTools()
      this.setStatus('running')
      this.onLog('info', `[${this.config.name}] Pronto. Tool: ${this._tools.map(t => t.name).join(', ')}`)
      this.emit('tools', this._tools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.onLog('error', `[${this.config.name}] Initialization failed: ${msg}`)
      this.setStatus('error', msg)
      this.scheduleRestart()
    }
  }

  private scheduleRestart(): void {
    if (!this.shouldRestart) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.onLog('info', `[${this.config.name}] Restarting in 5s...`)
    this.restartTimer = setTimeout(() => {
      if (this.shouldRestart) {
        this.spawnProcess().catch(() => {})
      }
    }, 5000)
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>
        this.handleMessage(msg)
      } catch {
        // Not JSON — could be startup text
        this.onLog('info', `[${this.config.name}] stdout: ${trimmed}`)
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const id = msg.id as number | string
      const pending = this.pendingRequests.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(id)
        if ('error' in msg) {
          const rpcErr = msg.error as { message?: string; code?: number }
          pending.reject(new Error(rpcErr.message ?? 'RPC error'))
        } else {
          pending.resolve(msg.result)
        }
      }
    }
    // JSON-RPC notification (no id) — ignore for now
  }

  private sendRequest(method: string, params: unknown, id?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Process not available'))
        return
      }

      const requestId = id ?? this.nextId()
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params
      }) + '\n'

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Timeout for ${method} (id=${requestId})`))
      }, 30000)

      this.pendingRequests.set(requestId, { resolve, reject, timer })
      this.process.stdin.write(request, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pendingRequests.delete(requestId)
          reject(err)
        }
      })
    })
  }

  async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: `${APP_NAME}-bridge`, version: '1.0.0' }
    }, 1) as { protocolVersion?: string }

    // Send initialized notification
    if (this.process?.stdin?.writable) {
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      }) + '\n'
      this.process.stdin.write(notification)
    }

    this.onLog('info', `[${this.config.name}] Initialized. Protocol: ${result?.protocolVersion ?? 'unknown'}`)
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest('tools/list', {}, 2) as {
      tools?: Array<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>
    }
    return (result?.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {}
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const id = this.nextId()
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args
    }, id) as {
      content?: Array<{ type: string; text?: string } | { type: string; data?: string }>
      isError?: boolean
    }

    if (result?.isError) {
      const errContent = result.content?.find(c => c.type === 'text') as { text?: string } | undefined
      throw new Error(errContent?.text ?? 'Tool call error')
    }

    // Text-only results travel as plain text. When non-text blocks are present
    // (e.g. base64 screenshots) the STRUCTURED result is sent instead: the
    // backend sanitizes it (extracts the text, saves images as downloadable
    // files) — the old text-only join silently dropped the images.
    const blocks = result?.content ?? []
    const text = blocks
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n')
    const hasBinary = blocks.some(c => c.type !== 'text')

    return hasBinary || !text ? JSON.stringify(result) : text
  }

  async stop(): Promise<void> {
    this.shouldRestart = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Process stopped'))
    }
    this.pendingRequests.clear()

    if (this.process) {
      this.setStatus('stopped')
      this.process.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const t = setTimeout(() => {
          this.process?.kill('SIGKILL')
          resolve()
        }, 3000)
        this.process?.on('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
      this.process = null
    }
  }
}
