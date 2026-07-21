import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { setupTray, updateTrayStatus } from './tray'
import { APP_ID } from './app.config'
import { setAutostart, isAutostartEnabled } from './autostart'
import { BridgeManager, DisabledToolsMap } from './bridge'
import { checkDependencies } from './deps-checker'

// Suppress deprecation warnings in dev
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

export interface AppConfig {
  serverUrl: string
  token: string
  autostart: boolean
}

const store = new Store<{ config: AppConfig; disabledTools: DisabledToolsMap }>({
  defaults: {
    config: {
      serverUrl: '',
      token: '',
      autostart: false
    },
    // serverId → tools the user turned off; survives restarts
    disabledTools: {}
  }
})

let mainWindow: BrowserWindow | null = null
let bridgeManager: BridgeManager | null = null

function createWindow(): void {
  const isMac   = process.platform === 'darwin'
  const isWin   = process.platform === 'win32'

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Mac:     "hiddenInset" — traffic lights overlapping the renderer, drag via CSS
    // Windows: "hidden"      — native bar hidden, we use titleBarOverlay (DWM)
    // Linux:   "default"     — standard native bar
    titleBarStyle: isMac ? 'hiddenInset' : isWin ? 'hidden' : 'default',
    // Positions the traffic lights centered in the 40px titlebar
    ...(isMac && { trafficLightPosition: { x: 16, y: 12 } }),
    // On Windows 11 use the DWM overlay: dark background, gray symbols, 40px height
    ...(isWin && {
      titleBarOverlay: {
        color:       '#030712',
        symbolColor: '#9ca3af',
        height:      40,
      },
    }),
    backgroundColor: '#030712',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Hide instead of close — app lives in tray
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function setupIpcHandlers(): void {
  ipcMain.handle('get-config', () => {
    return store.get('config')
  })

  ipcMain.handle('set-config', (_event, cfg: Partial<AppConfig>) => {
    const current = store.get('config')
    store.set('config', { ...current, ...cfg })
    return store.get('config')
  })

  ipcMain.handle('get-status', () => {
    return bridgeManager?.getStatus() ?? {
      connected: false,
      connecting: false,
      serverUrl: '',
      servers: [],
      uptime: 0,
      latency: null
    }
  })

  ipcMain.handle('connect', async () => {
    const config = store.get('config')
    if (!config.serverUrl || !config.token) {
      return { success: false, error: 'Server URL e token richiesti' }
    }
    try {
      await bridgeManager?.connect(config.serverUrl, config.token)
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('disconnect', async () => {
    await bridgeManager?.disconnect()
    return { success: true }
  })

  ipcMain.handle('get-autostart', async () => {
    return isAutostartEnabled()
  })

  ipcMain.handle('set-autostart', async (_event, enabled: boolean) => {
    await setAutostart(enabled)
    const cfg = store.get('config')
    store.set('config', { ...cfg, autostart: enabled })
    return { success: true }
  })

  ipcMain.handle('check-deps', async () => {
    return checkDependencies()
  })

  ipcMain.handle(
    'set-tool-enabled',
    (_event, serverId: string, toolName: string, enabled: boolean) => {
      bridgeManager?.setToolEnabled(serverId, toolName, enabled)
      return { success: true }
    }
  )
}

function emitToRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId(APP_ID)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Prevent multiple instances
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  createWindow()
  setupIpcHandlers()

  // Init bridge manager
  bridgeManager = new BridgeManager(
    (channel, data) => {
      emitToRenderer(channel, data)
      // Update tray based on status
      if (channel === 'status-change') {
        const status = data as { connected: boolean; connecting: boolean }
        if (status.connected) updateTrayStatus('connected')
        else if (status.connecting) updateTrayStatus('connecting')
        else updateTrayStatus('disconnected')
      }
    },
    store.get('disabledTools'),
    (map) => store.set('disabledTools', map)
  )

  // Setup tray
  setupTray({
    onShow: () => {
      mainWindow?.show()
      mainWindow?.focus()
    },
    onQuit: () => {
      app.isQuitting = true
      app.quit()
    },
    onToggleAutostart: async () => {
      const current = await isAutostartEnabled()
      await setAutostart(!current)
      return !current
    },
    getAutostartEnabled: isAutostartEnabled
  })

  // Auto-connect if config exists
  const config = store.get('config')
  if (config.serverUrl && config.token) {
    setTimeout(() => {
      bridgeManager?.connect(config.serverUrl, config.token).catch(() => {})
    }, 1500)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray even without windows
  if (process.platform !== 'darwin') {
    // Don't quit — stays in tray
  }
})

app.on('before-quit', async () => {
  app.isQuitting = true
  await bridgeManager?.disconnect()
})

// isQuitting is declared in electron-app.d.ts
app.isQuitting = false

export { emitToRenderer }
