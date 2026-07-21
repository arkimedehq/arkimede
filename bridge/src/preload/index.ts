import { contextBridge, ipcRenderer } from 'electron'

export interface BridgeAPI {
  // Config
  getConfig: () => Promise<{
    serverUrl: string
    token: string
    autostart: boolean
  }>
  setConfig: (cfg: Partial<{
    serverUrl: string
    token: string
    autostart: boolean
  }>) => Promise<{ serverUrl: string; token: string; autostart: boolean }>

  // Connection
  getStatus: () => Promise<{
    connected: boolean
    connecting: boolean
    serverUrl: string
    servers: ServerState[]
    uptime: number
    latency: number | null
  }>
  connect: () => Promise<{ success: boolean; error?: string }>
  disconnect: () => Promise<{ success: boolean }>

  // Autostart
  getAutostart: () => Promise<boolean>
  setAutostart: (enabled: boolean) => Promise<{ success: boolean }>

  // Per-tool enable/disable of an MCP server
  setToolEnabled: (serverId: string, toolName: string, enabled: boolean) => Promise<{ success: boolean }>

  // Deps
  checkDeps: () => Promise<DepResult[]>

  // Events (main → renderer)
  onStatusChange: (cb: (data: { connected: boolean; connecting: boolean; serverUrl: string }) => void) => () => void
  onLog: (cb: (entry: LogEntry) => void) => () => void
  onServersUpdate: (cb: (servers: ServerState[]) => void) => () => void
}

export interface ServerState {
  id: string
  name: string
  status: 'starting' | 'running' | 'stopped' | 'error'
  pid?: number
  error?: string
  /** Tools actually exposed to the agent (total minus the disabled ones). */
  toolsCount: number
  /** Every tool the MCP server declares, disabled ones included. */
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  /** Names the user turned off: not exposed to the agent, not callable. */
  disabledTools: string[]
}

export interface LogEntry {
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
  timestamp: number
}

export interface DepResult {
  name: string
  available: boolean
  version?: string
  installHint?: string
  installUrl?: string
}

const bridgeAPI: BridgeAPI = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),

  getStatus: () => ipcRenderer.invoke('get-status'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),

  setToolEnabled: (serverId, toolName, enabled) =>
    ipcRenderer.invoke('set-tool-enabled', serverId, toolName, enabled),

  checkDeps: () => ipcRenderer.invoke('check-deps'),

  onStatusChange: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof cb>[0]): void => cb(data)
    ipcRenderer.on('status-change', listener)
    return () => ipcRenderer.removeListener('status-change', listener)
  },

  onLog: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, entry: LogEntry): void => cb(entry)
    ipcRenderer.on('log', listener)
    return () => ipcRenderer.removeListener('log', listener)
  },

  onServersUpdate: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, servers: ServerState[]): void => cb(servers)
    ipcRenderer.on('servers-update', listener)
    return () => ipcRenderer.removeListener('servers-update', listener)
  }
}

contextBridge.exposeInMainWorld('bridge', bridgeAPI)
