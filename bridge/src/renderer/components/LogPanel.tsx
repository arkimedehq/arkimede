import React, { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '../../preload/index'

type LogFilter = 'all' | 'info' | 'success' | 'warn' | 'error'

interface LogEntryWithId extends LogEntry {
  id: number
}

interface Props {
  logs: LogEntryWithId[]
}

export function LogPanel({ logs }: Props): React.ReactElement {
  const [filter, setFilter] = useState<LogFilter>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [filtered, autoScroll])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(atBottom)
  }

  const levelConfig = {
    info: { label: 'INFO', class: 'text-gray-400', dot: 'bg-gray-500' },
    success: { label: 'OK', class: 'text-green-400', dot: 'bg-green-500' },
    warn: { label: 'WARN', class: 'text-yellow-400', dot: 'bg-yellow-500' },
    error: { label: 'ERR', class: 'text-red-400', dot: 'bg-red-500' }
  }

  const filters: { id: LogFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: logs.length },
    { id: 'error', label: 'Errors', count: logs.filter(l => l.level === 'error').length },
    { id: 'warn', label: 'Warning', count: logs.filter(l => l.level === 'warn').length },
    { id: 'success', label: 'OK', count: logs.filter(l => l.level === 'success').length },
    { id: 'info', label: 'Info', count: logs.filter(l => l.level === 'info').length }
  ]

  return (
    <div className="flex flex-col h-full bg-gray-800 rounded-xl border border-gray-700 overflow-hidden" style={{ maxHeight: 'calc(100vh - 140px)' }}>
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1">
          {filters.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                filter === f.id
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
              }`}
            >
              {f.label}
              {f.count > 0 && (
                <span className="ml-1.5 text-gray-500">({f.count})</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
              className="w-3 h-3 accent-blue-500"
            />
            Auto-scroll
          </label>
          <span className="text-xs text-gray-600">{filtered.length} entries</span>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-2 font-mono text-xs"
      >
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-600">
            No logs
          </div>
        ) : (
          filtered.map(entry => {
            const cfg = levelConfig[entry.level]
            return (
              <div
                key={entry.id}
                className="flex gap-3 px-2 py-1 rounded hover:bg-gray-700/50 transition-colors group"
              >
                <span className="text-gray-600 flex-shrink-0 tabular-nums">
                  {formatTime(entry.timestamp)}
                </span>
                <span className={`flex-shrink-0 font-semibold w-8 ${cfg.class}`}>
                  {cfg.label}
                </span>
                <span className={`flex-1 break-all ${cfg.class}`}>
                  {entry.message}
                </span>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0')
}
