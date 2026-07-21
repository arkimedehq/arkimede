import React, { useState, useEffect, useCallback, useRef } from 'react'
// APP_NAME is injected by the main process via window.bridge or read from env
const APP_NAME = (window as any).__APP_NAME__ ?? 'Arkimede'
import { ConnectionCard } from './components/ConnectionCard'
import { ServersList } from './components/ServersList'
import { LogPanel } from './components/LogPanel'
import { SettingsModal } from './components/SettingsModal'
import { DepsPanel } from './components/DepsPanel'
import type { ServerState, LogEntry } from '../preload/index'

type NavItem = 'dashboard' | 'logs' | 'deps'

interface ConnectionStatus {
  connected: boolean
  connecting: boolean
  serverUrl: string
}

interface FullStatus {
  connected: boolean
  connecting: boolean
  serverUrl: string
  servers: ServerState[]
  uptime: number
  latency: number | null
}

export default function App(): React.ReactElement {
  const [nav, setNav] = useState<NavItem>('dashboard')
  const [showSettings, setShowSettings] = useState(false)
  const [status, setStatus] = useState<FullStatus>({
    connected: false,
    connecting: false,
    serverUrl: '',
    servers: [],
    uptime: 0,
    latency: null
  })
  const [logs, setLogs] = useState<(LogEntry & { id: number })[]>([])
  const logCounterRef = useRef(0)

  const addLog = useCallback((entry: LogEntry) => {
    const id = ++logCounterRef.current
    setLogs(prev => {
      const updated = [...prev, { ...entry, id }]
      return updated.length > 500 ? updated.slice(-500) : updated
    })
  }, [])

  useEffect(() => {
    // Load initial status
    window.bridge.getStatus().then(s => setStatus(s))

    // Listen for events
    const unsubStatus = window.bridge.onStatusChange((data: ConnectionStatus) => {
      setStatus(prev => ({ ...prev, ...data }))
      // Refresh full status
      window.bridge.getStatus().then(s => setStatus(s))
    })

    const unsubLog = window.bridge.onLog((entry: LogEntry) => {
      addLog(entry)
    })

    const unsubServers = window.bridge.onServersUpdate((servers: ServerState[]) => {
      setStatus(prev => ({ ...prev, servers }))
    })

    // Poll uptime
    const uptimeInterval = setInterval(() => {
      if (status.connected) {
        setStatus(prev => ({ ...prev, uptime: prev.uptime + 1000 }))
      }
    }, 1000)

    return () => {
      unsubStatus()
      unsubLog()
      unsubServers()
      clearInterval(uptimeInterval)
    }
  }, [addLog])

  const navItems: { id: NavItem; label: string; icon: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: '⊞' },
    { id: 'logs', label: 'Log', icon: '≡' },
    { id: 'deps', label: 'Dependencies', icon: '⬡' }
  ]

  const statusDot = status.connected
    ? 'bg-green-500'
    : status.connecting
      ? 'bg-yellow-500 animate-pulse'
      : 'bg-red-500'

  // Detect platform via userAgent (available in the Electron renderer)
  const isMac = navigator.userAgent.includes('Mac OS')
  const isWin = navigator.userAgent.includes('Windows')

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-100">

      {/* ── Titlebar — full-width draggable strip ─────────────────────────────
          Mac:     traffic lights (●●●) overlap on the left (x=16, y=12)
                   → 80px of left padding so they aren't covered
          Windows: titleBarOverlay DWM draws the Win11 buttons on the right side
                   → the strip only acts as a drag region
          Linux:   native bar on top → this strip is hidden
      ───────────────────────────────────────────────────────────────────────── */}
      {(isMac || isWin) && (
        <div
          className="h-10 flex-shrink-0 flex items-center bg-gray-950 border-b border-gray-800/60 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* Space for the traffic lights on Mac (80px) */}
          <div className={isMac ? 'w-20 flex-shrink-0' : 'w-3 flex-shrink-0'} />
          {/* Centered app name */}
          <span className="text-xs font-medium text-gray-500 tracking-wide">
            {APP_NAME} Bridge
          </span>
        </div>
      )}

      {/* ── Layout principale ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 flex flex-col bg-gray-950 border-r border-gray-800">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-xs font-bold text-white">
              AI
            </div>
            <div>
              <div className="text-sm font-semibold text-white leading-tight">{APP_NAME}</div>
              <div className="text-xs text-gray-500">Bridge v1.0</div>
            </div>
          </div>
        </div>

        {/* Status indicator */}
        <div className="px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${statusDot}`} />
            <span className="text-xs text-gray-400">
              {status.connected ? 'Connected' : status.connecting ? 'Connecting...' : 'Not connected'}
            </span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-1">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setNav(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                nav === item.id
                  ? 'bg-blue-600/20 text-blue-400 font-medium'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Settings button */}
        <div className="px-2 py-3 border-t border-gray-800">
          <button
            onClick={() => setShowSettings(true)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            <span className="text-base">⚙</span>
            Settings
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="px-6 py-4 border-b border-gray-800 flex items-center justify-between bg-gray-900/80 backdrop-blur-sm">
          <h1 className="text-lg font-semibold text-white">
            {nav === 'dashboard' && 'Dashboard'}
            {nav === 'logs' && 'System log'}
            {nav === 'deps' && 'Dependencies'}
          </h1>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            {status.connected && status.latency !== null && (
              <span className="text-green-400">
                {status.latency}ms latency
              </span>
            )}
            {status.connected && (
              <span className="text-gray-500">
                Uptime: {formatUptime(status.uptime)}
              </span>
            )}
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {nav === 'dashboard' && (
            <div className="space-y-6">
              <ConnectionCard status={status} />
              <ServersList servers={status.servers} />
            </div>
          )}
          {nav === 'logs' && (
            <LogPanel logs={logs} />
          )}
          {nav === 'deps' && (
            <DepsPanel />
          )}
        </div>
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onStatusChange={(s) => setStatus(prev => ({ ...prev, ...s }))}
        />
      )}
      </div> {/* end flex flex-1 overflow-hidden */}
    </div>
  )
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
