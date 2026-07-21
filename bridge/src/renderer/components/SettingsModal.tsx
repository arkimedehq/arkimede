import React, { useState, useEffect } from 'react'

interface Props {
  onClose: () => void
  onStatusChange: (s: { connected: boolean; connecting: boolean }) => void
}

interface Config {
  serverUrl: string
  token: string
  autostart: boolean
}

export function SettingsModal({ onClose, onStatusChange }: Props): React.ReactElement {
  const [config, setConfig] = useState<Config>({ serverUrl: '', token: '', autostart: false })
  const [tokenVisible, setTokenVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [autostartEnabled, setAutostartEnabled] = useState(false)

  useEffect(() => {
    window.bridge.getConfig().then(c => setConfig(c))
    window.bridge.getAutostart().then(e => setAutostartEnabled(e))
  }, [])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    await window.bridge.setConfig(config)
    setSaving(false)
    onClose()
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      await window.bridge.setConfig(config)
      const result = await window.bridge.connect()
      if (result.success) {
        setTestResult({ ok: true, message: 'Connection successful!' })
        onStatusChange({ connected: true, connecting: false })
      } else {
        setTestResult({ ok: false, message: result.error ?? 'Connection failed' })
      }
    } catch (err) {
      setTestResult({ ok: false, message: String(err) })
    }
    setTesting(false)
  }

  const handleDisconnect = async (): Promise<void> => {
    await window.bridge.disconnect()
    onStatusChange({ connected: false, connecting: false })
    onClose()
  }

  const handleCopyToken = async (): Promise<void> => {
    await navigator.clipboard.writeText(config.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleAutostartToggle = async (): Promise<void> => {
    const next = !autostartEnabled
    await window.bridge.setAutostart(next)
    setAutostartEnabled(next)
    setConfig(prev => ({ ...prev, autostart: next }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-gray-800 rounded-2xl border border-gray-700 w-full max-w-md mx-4 shadow-2xl">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-700 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Bridge Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors p-1"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Server URL */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Server URL</label>
            <input
              type="text"
              value={config.serverUrl}
              onChange={e => setConfig(prev => ({ ...prev, serverUrl: e.target.value }))}
              placeholder="wss://yourserver.com"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
            <p className="text-xs text-gray-600 mt-1">
              WebSocket URL of the NestJS server (ws:// or wss://)
            </p>
          </div>

          {/* Token */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">JWT Token</label>
            <div className="relative">
              <input
                type={tokenVisible ? 'text' : 'password'}
                value={config.token}
                onChange={e => setConfig(prev => ({ ...prev, token: e.target.value }))}
                placeholder="eyJhbGciOiJIUzI1..."
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 pr-20 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors font-mono"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                <button
                  type="button"
                  onClick={() => setTokenVisible(v => !v)}
                  className="p-1.5 text-gray-400 hover:text-gray-200 transition-colors"
                  title={tokenVisible ? 'Hide' : 'Show'}
                >
                  {tokenVisible ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="p-1.5 text-gray-400 hover:text-gray-200 transition-colors"
                  title="Copy token"
                >
                  {copied ? (
                    <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-600 mt-1">
              Copy the token from the Settings section of the web frontend
            </p>
          </div>

          {/* Autostart toggle */}
          <div className="flex items-center justify-between py-1">
            <div>
              <div className="text-sm text-white font-medium">Start with the system</div>
              <div className="text-xs text-gray-500 mt-0.5">
                Start automatically at login
              </div>
            </div>
            <button
              onClick={handleAutostartToggle}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                autostartEnabled ? 'bg-blue-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  autostartEnabled ? 'translate-x-4.5' : 'translate-x-0.5'
                }`}
                style={{ transform: autostartEnabled ? 'translateX(18px)' : 'translateX(2px)' }}
              />
            </button>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`rounded-lg px-4 py-3 text-sm ${
              testResult.ok
                ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                : 'bg-red-500/10 border border-red-500/20 text-red-400'
            }`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
          <button
            onClick={handleDisconnect}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Disconnect
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleTest}
              disabled={testing || !config.serverUrl || !config.token}
              className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {testing && <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-white rounded-full animate-spin" />}
              Test connection
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
