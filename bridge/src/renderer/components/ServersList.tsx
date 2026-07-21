import React, { useState } from 'react'
import type { ServerState } from '../../preload/index'

interface Props {
  servers: ServerState[]
}

export function ServersList({ servers }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (servers.length === 0) {
    return (
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-8 text-center">
        <div className="text-4xl mb-3">⬡</div>
        <p className="text-gray-400 text-sm">No active MCP servers.</p>
        <p className="text-gray-600 text-xs mt-1">
          Connect to the server to receive the configuration.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
        Server MCP ({servers.length})
      </h2>
      {servers.map(server => (
        <ServerCard
          key={server.id}
          server={server}
          expanded={expanded.has(server.id)}
          onToggle={() => toggle(server.id)}
        />
      ))}
    </div>
  )
}

function ServerCard({
  server,
  expanded,
  onToggle
}: {
  server: ServerState
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  const statusConfig = {
    running: { label: 'Running', dot: 'bg-green-500', badge: 'bg-green-500/10 text-green-400 border-green-500/20' },
    starting: { label: 'Starting...', dot: 'bg-yellow-500 animate-pulse', badge: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    stopped: { label: 'Stopped', dot: 'bg-gray-500', badge: 'bg-gray-500/10 text-gray-400 border-gray-500/20' },
    error: { label: 'Error', dot: 'bg-red-500', badge: 'bg-red-500/10 text-red-400 border-red-500/20' }
  }

  const cfg = statusConfig[server.status] ?? statusConfig.stopped
  const disabled = new Set(server.disabledTools ?? [])

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
      <div
        className="px-5 py-4 flex items-center justify-between cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
          <div>
            <div className="text-sm font-medium text-white">{server.name}</div>
            {server.pid && (
              <div className="text-xs text-gray-500">PID: {server.pid}</div>
            )}
            {server.error && (
              <div className="text-xs text-red-400 truncate max-w-xs">{server.error}</div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={`px-2 py-0.5 rounded-full text-xs border ${cfg.badge}`}>
            {cfg.label}
          </span>
          <span className="text-xs text-gray-500 bg-gray-700 px-2 py-0.5 rounded-full">
            {server.toolsCount}
            {server.tools.length !== server.toolsCount && `/${server.tools.length}`} tool
          </span>
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {expanded && server.tools.length > 0 && (
        <div className="border-t border-gray-700 bg-gray-900/50">
          <div className="px-5 py-3">
            <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">
              Available tools — uncheck to hide a tool from the agent
            </p>
            <div className="space-y-2">
              {server.tools.map(tool => {
                const enabled = !disabled.has(tool.name)
                return (
                  <label
                    key={tool.name}
                    className={`flex items-start gap-3 bg-gray-800 rounded-lg px-4 py-3 border cursor-pointer transition-colors ${
                      enabled
                        ? 'border-gray-700 hover:border-gray-600'
                        : 'border-gray-800 opacity-50 hover:opacity-75'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={e =>
                        window.bridge.setToolEnabled(server.id, tool.name, e.target.checked)
                      }
                      className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-gray-600 bg-gray-900 text-blue-500 focus:ring-1 focus:ring-blue-500 cursor-pointer"
                    />
                    <div className="min-w-0">
                      <code
                        className={`text-xs font-mono font-semibold ${
                          enabled ? 'text-blue-400' : 'text-gray-500 line-through'
                        }`}
                      >
                        {tool.name}
                      </code>
                      {tool.description && (
                        <p className="text-xs text-gray-400 mt-0.5">{tool.description}</p>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {expanded && server.tools.length === 0 && server.status === 'running' && (
        <div className="border-t border-gray-700 px-5 py-3">
          <p className="text-xs text-gray-500">No tools available.</p>
        </div>
      )}
    </div>
  )
}
