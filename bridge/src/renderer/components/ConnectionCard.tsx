import React from 'react'

interface Status {
  connected: boolean
  connecting: boolean
  serverUrl: string
  servers: unknown[]
  uptime: number
  latency: number | null
}

interface Props {
  status: Status
}

export function ConnectionCard({ status }: Props): React.ReactElement {
  const runningServers = (status.servers as Array<{ status: string }>).filter(s => s.status === 'running').length

  const handleConnect = async (): Promise<void> => {
    await window.bridge.connect()
  }

  const handleDisconnect = async (): Promise<void> => {
    await window.bridge.disconnect()
  }

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Connection</h2>
        <div className="flex items-center gap-2">
          {status.connected && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded-full">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-400 font-medium">Live</span>
            </div>
          )}
        </div>
      </div>

      <div className="p-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            label="Status"
            value={
              status.connected
                ? 'Connected'
                : status.connecting
                  ? 'Connecting...'
                  : 'Disconnected'
            }
            valueClass={
              status.connected
                ? 'text-green-400'
                : status.connecting
                  ? 'text-yellow-400'
                  : 'text-red-400'
            }
          />
          <Stat
            label="Server"
            value={status.serverUrl ? new URL(status.serverUrl.replace(/^ws/, 'http')).hostname : '—'}
          />
          <Stat
            label="Server MCP"
            value={`${runningServers} attivi`}
          />
          <Stat
            label="Latency"
            value={status.latency !== null ? `${status.latency}ms` : '—'}
            valueClass={
              status.latency !== null
                ? status.latency < 100
                  ? 'text-green-400'
                  : status.latency < 300
                    ? 'text-yellow-400'
                    : 'text-red-400'
                : undefined
            }
          />
        </div>

        <div className="mt-5 flex gap-3">
          {!status.connected && !status.connecting && (
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Connetti
            </button>
          )}
          {status.connecting && (
            <button
              disabled
              className="px-4 py-2 bg-gray-700 text-gray-400 text-sm font-medium rounded-lg cursor-not-allowed flex items-center gap-2"
            >
              <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-white rounded-full animate-spin" />
              Connecting...
            </button>
          )}
          {status.connected && (
            <button
              onClick={handleDisconnect}
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 text-sm font-medium rounded-lg transition-colors"
            >
              Disconnetti
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass = 'text-white'
}: {
  label: string
  value: string
  valueClass?: string
}): React.ReactElement {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-sm font-semibold ${valueClass}`}>{value}</div>
    </div>
  )
}
