import { io, Socket } from 'socket.io-client'
import { McpProcess, McpServerConfig, McpTool } from './mcp-process'

type EmitFn = (channel: string, data: unknown) => void

export interface BridgeStatus {
  connected: boolean
  connecting: boolean
  serverUrl: string
  servers: ServerState[]
  uptime: number
  latency: number | null
}

export interface ServerState {
  id: string
  name: string
  status: 'starting' | 'running' | 'stopped' | 'error'
  pid?: number
  error?: string
  /** Tools actually exposed to the server (total minus the disabled ones). */
  toolsCount: number
  /** Every tool the MCP process declares, disabled ones included. */
  tools: McpTool[]
  /** Names excluded by the user: never registered, never callable. */
  disabledTools: string[]
}

/** Disabled tool names per server id, as persisted by the main process. */
export type DisabledToolsMap = Record<string, string[]>

interface ToolCallPayload {
  callId: string
  serverId: string
  tool: string
  args: Record<string, unknown>
}

interface ConfigPayload {
  servers: McpServerConfig[]
}

export class BridgeManager {
  private socket: Socket | null = null
  private processes = new Map<string, McpProcess>()
  private _connected = false
  private _connecting = false
  private _serverUrl = ''
  private connectedSince: number | null = null
  private latency: number | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** serverId → names of the tools the user turned off. */
  private disabled = new Map<string, Set<string>>()

  constructor(
    private emit: EmitFn,
    disabled: DisabledToolsMap = {},
    private persistDisabled: (map: DisabledToolsMap) => void = () => {}
  ) {
    for (const [serverId, names] of Object.entries(disabled)) {
      if (names.length > 0) this.disabled.set(serverId, new Set(names))
    }
  }

  getStatus(): BridgeStatus {
    const servers: ServerState[] = []
    for (const [id, proc] of this.processes) {
      servers.push({
        id,
        name: proc.config.name,
        status: proc.status,
        pid: proc.pid,
        toolsCount: this.enabledTools(id, proc.tools).length,
        tools: proc.tools,
        disabledTools: [...(this.disabled.get(id) ?? [])]
      })
    }

    return {
      connected: this._connected,
      connecting: this._connecting,
      serverUrl: this._serverUrl,
      servers,
      uptime: this.connectedSince ? Date.now() - this.connectedSince : 0,
      latency: this.latency
    }
  }

  private log(level: 'info' | 'success' | 'warn' | 'error', message: string): void {
    this.emit('log', { level, message, timestamp: Date.now() })
  }

  async connect(serverUrl: string, token: string): Promise<void> {
    if (this._connected || this._connecting) {
      await this.disconnect()
    }

    this._serverUrl = serverUrl
    this._connecting = true
    this.emitStatus()

    this.log('info', `Connecting to ${serverUrl}...`)

    this.socket = io(`${serverUrl}/mcp-bridge`, {
      auth: { token },
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
      transports: ['websocket']
    })

    this.socket.on('connect', () => {
      this._connected = true
      this._connecting = false
      this.connectedSince = Date.now()
      this.emitStatus()
      this.log('success', `Connected to ${serverUrl}`)
      // Processes may already be running (backend restart, dropped socket):
      // republish their tools, otherwise the agent would see none.
      for (const id of this.processes.keys()) this.registerTools(id)
      this.startLatencyPing()
    })

    this.socket.on('disconnect', (reason) => {
      this._connected = false
      this._connecting = true
      this.connectedSince = null
      this.latency = null
      this.emitStatus()
      this.log('warn', `Disconnected: ${reason}. Reconnecting...`)
    })

    this.socket.on('connect_error', (err) => {
      this._connecting = true
      this.emitStatus()
      this.log('error', `Connection error: ${err.message}`)
    })

    this.socket.on('reconnect', () => {
      this._connected = true
      this._connecting = false
      this.connectedSince = Date.now()
      this.emitStatus()
      this.log('success', 'Reconnected!')
    })

    // Server sends config with list of MCP servers to spawn
    this.socket.on('config', (payload: ConfigPayload) => {
      this.log('info', `Config received: ${payload.servers.length} servers`)
      this.handleConfig(payload)
    })

    // Server requests a tool call
    this.socket.on('tool:call', (payload: ToolCallPayload) => {
      this.handleToolCall(payload)
    })

    // Pong for latency
    this.socket.on('pong', (serverTime: number) => {
      this.latency = Date.now() - serverTime
      this.emitStatus()
    })
  }

  private startLatencyPing(): void {
    const ping = (): void => {
      if (this._connected && this.socket?.connected) {
        this.socket.emit('ping', Date.now())
        setTimeout(ping, 10000)
      }
    }
    setTimeout(ping, 2000)
  }

  private async handleConfig(payload: ConfigPayload): Promise<void> {
    const incoming = new Set(payload.servers.map(s => s.id))

    // Stop processes no longer in config
    for (const [id, proc] of this.processes) {
      if (!incoming.has(id)) {
        this.log('info', `Stopping removed server: ${proc.config.name}`)
        await proc.stop()
        this.processes.delete(id)
      }
    }

    // Start / update processes
    for (const serverConfig of payload.servers) {
      const existing = this.processes.get(serverConfig.id)
      if (existing) {
        // Server already active: restart only if command/args/env changed,
        // so a config change applies without restarting the bridge.
        if (configEquals(existing.config, serverConfig)) continue

        this.log('info', `[${serverConfig.name}] Config changed: restarting process`)
        await existing.stop()
        this.processes.delete(serverConfig.id)
      }

      this.spawnServer(serverConfig)
    }
  }

  /** Creates an McpProcess, attaches its listeners, and starts it. */
  private spawnServer(serverConfig: McpServerConfig): void {
    const proc = new McpProcess(serverConfig, (level, msg) => {
      this.log(level, msg)
    })

    proc.on('status', (statusEvent) => {
      this.socket?.emit('server:status', statusEvent)
      this.emitStatus()
    })

    proc.on('tools', () => {
      this.registerTools(serverConfig.id)
      this.emitStatus()
    })

    this.processes.set(serverConfig.id, proc)

    proc.start().catch((err: Error) => {
      this.log('error', `[${serverConfig.name}] Startup failed: ${err.message}`)
    })
  }

  // ── Per-tool enable/disable ─────────────────────────────────────────────────

  /** Tools of a server minus the ones the user disabled. */
  private enabledTools(serverId: string, tools: McpTool[]): McpTool[] {
    const off = this.disabled.get(serverId)
    return off ? tools.filter(t => !off.has(t.name)) : tools
  }

  /**
   * Publishes a server's ENABLED tools to the backend. The backend replaces the
   * whole list for that server id, so this is also how a tool disappears from
   * (or comes back to) the agent without restarting the MCP process.
   */
  private registerTools(serverId: string): void {
    const proc = this.processes.get(serverId)
    if (!proc) return

    const tools = this.enabledTools(serverId, proc.tools)
    this.socket?.emit('tools:register', { serverId, tools })

    const offCount = proc.tools.length - tools.length
    this.log(
      'success',
      `[${proc.config.name}] ${tools.length} tools registered` +
        (offCount > 0 ? ` (${offCount} disabled)` : '')
    )
  }

  /**
   * Turns a single tool of a server on or off. A disabled tool is not exposed to
   * the agent and is refused if it is called anyway (stale registration).
   */
  setToolEnabled(serverId: string, toolName: string, enabled: boolean): void {
    const off = this.disabled.get(serverId) ?? new Set<string>()
    if (enabled) off.delete(toolName)
    else off.add(toolName)

    if (off.size > 0) this.disabled.set(serverId, off)
    else this.disabled.delete(serverId)

    const map: DisabledToolsMap = {}
    for (const [id, names] of this.disabled) map[id] = [...names]
    this.persistDisabled(map)

    const proc = this.processes.get(serverId)
    this.log('info', `[${proc?.config.name ?? serverId}] Tool ${toolName} ${enabled ? 'enabled' : 'disabled'}`)

    this.registerTools(serverId)
    this.emitStatus()
  }

  private async handleToolCall(payload: ToolCallPayload): Promise<void> {
    const { callId, serverId, tool, args } = payload
    this.log('info', `Tool call: ${tool} on server ${serverId} (callId=${callId})`)

    if (this.disabled.get(serverId)?.has(tool)) {
      this.log('warn', `Tool ${tool} is disabled in the bridge: call refused`)
      this.socket?.emit('tool:result', {
        callId,
        error: `Tool "${tool}" is disabled in the bridge and cannot be called.`
      })
      return
    }

    const proc = this.processes.get(serverId)
    if (!proc) {
      this.socket?.emit('tool:result', {
        callId,
        error: `MCP server not found: ${serverId}`
      })
      return
    }

    if (proc.status !== 'running') {
      this.socket?.emit('tool:result', {
        callId,
        error: `MCP server not running: ${proc.status}`
      })
      return
    }

    try {
      const result = await proc.callTool(tool, args)
      this.log('success', `Tool ${tool} completed`)
      this.socket?.emit('tool:result', { callId, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log('error', `Tool ${tool} failed: ${message}`)
      this.socket?.emit('tool:result', { callId, error: message })
    }
  }

  private emitStatus(): void {
    this.emit('status-change', {
      connected: this._connected,
      connecting: this._connecting,
      serverUrl: this._serverUrl
    })
    this.emit('servers-update', this.getStatus().servers)
  }

  async disconnect(): Promise<void> {
    this._connected = false
    this._connecting = false

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Stop all MCP processes
    const stopPromises = Array.from(this.processes.values()).map(p => p.stop())
    await Promise.allSettled(stopPromises)
    this.processes.clear()

    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.disconnect()
      this.socket = null
    }

    this.connectedSince = null
    this.latency = null
    this.emitStatus()
    this.log('info', 'Disconnected')
  }
}

/**
 * Compares two MCP server configs to decide whether the process must be restarted.
 * Considers command, args and env (the id is already guaranteed equal; the name is
 * just a label and does not require a restart).
 */
function configEquals(a: McpServerConfig, b: McpServerConfig): boolean {
  if (a.command !== b.command) return false

  const argsA = a.args ?? []
  const argsB = b.args ?? []
  if (argsA.length !== argsB.length) return false
  if (argsA.some((v, i) => v !== argsB[i])) return false

  const envA = a.env ?? {}
  const envB = b.env ?? {}
  const keysA = Object.keys(envA)
  const keysB = Object.keys(envB)
  if (keysA.length !== keysB.length) return false
  return keysA.every(k => envA[k] === envB[k])
}
