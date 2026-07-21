import React, { useState, useEffect } from 'react'
import type { DepResult } from '../../preload/index'

export function DepsPanel(): React.ReactElement {
  const [deps, setDeps] = useState<DepResult[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = async (): Promise<void> => {
    setRefreshing(true)
    const result = await window.bridge.checkDeps()
    setDeps(result)
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => { load() }, [])

  const missing = deps.filter(d => !d.available)
  const available = deps.filter(d => d.available)

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">System dependencies</h2>
          <p className="text-xs text-gray-500 mt-1">
            Tools required to start the MCP servers
          </p>
        </div>
        <button
          onClick={load}
          disabled={refreshing}
          className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {refreshing && (
            <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-white rounded-full animate-spin" />
          )}
          Re-check
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-gray-400 text-sm py-8">
          <span className="inline-block w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
          Checking dependencies...
        </div>
      ) : (
        <>
          {missing.length > 0 && (
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-red-400 text-base">⚠</span>
                <h3 className="text-sm font-semibold text-red-400">
                  {missing.length} missing dependenc{missing.length === 1 ? 'y' : 'ies'}
                </h3>
              </div>
              <div className="space-y-3">
                {missing.map(dep => (
                  <DepCard key={dep.name} dep={dep} />
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Available ({available.length})
            </h3>
            <div className="space-y-1.5">
              {available.map(dep => (
                <DepCard key={dep.name} dep={dep} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function DepCard({ dep }: { dep: DepResult }): React.ReactElement {
  const [showHint, setShowHint] = useState(false)

  return (
    <div className={`rounded-lg border px-4 py-3 ${
      dep.available
        ? 'bg-gray-800 border-gray-700'
        : 'bg-red-500/5 border-red-500/20'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dep.available ? 'bg-green-500' : 'bg-red-500'}`} />
          <div>
            <code className={`text-sm font-mono font-semibold ${dep.available ? 'text-white' : 'text-red-300'}`}>
              {dep.name}
            </code>
            {dep.version && (
              <span className="ml-2 text-xs text-gray-500">{dep.version.slice(0, 40)}</span>
            )}
          </div>
        </div>

        {!dep.available && dep.installHint && (
          <button
            onClick={() => setShowHint(v => !v)}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            {showHint ? 'Hide' : 'How to install'}
          </button>
        )}
      </div>

      {!dep.available && showHint && dep.installHint && (
        <div className="mt-3 pt-3 border-t border-red-500/20">
          <p className="text-xs text-red-300 mb-2">{dep.installHint}</p>
          {dep.installUrl && (
            <a
              href={dep.installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              onClick={(e) => {
                e.preventDefault()
                // In Electron, open external links via shell
                window.open(dep.installUrl)
              }}
            >
              Open site ↗
            </a>
          )}
        </div>
      )}
    </div>
  )
}
