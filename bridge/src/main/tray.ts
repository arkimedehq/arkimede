import { Tray, Menu, nativeImage } from 'electron'
import { BRIDGE_NAME } from './app.config'
import path from 'path'
import NativeImage = Electron.NativeImage;
type TrayStatus = 'connected' | 'disconnected' | 'connecting'

interface TrayOptions {
  onShow: () => void
  onQuit: () => void
  onToggleAutostart: () => Promise<boolean>
  getAutostartEnabled: () => Promise<boolean>
}

let tray: Tray | null = null
let currentStatus: TrayStatus = 'disconnected'
let options: TrayOptions

// Lazy-loaded after app.whenReady() — always PNG, nativeImage doesn't support SVG via createFromPath
let iconCache: Record<TrayStatus, NativeImage> | null = null

function loadTrayIcon(name: string): NativeImage {
  const isMac = process.platform === 'darwin'

  // On macOS we use monochrome icons (black + alpha) with setTemplateImage(true):
  // the system automatically tints them black/white based on the menu bar theme.
  // On Windows/Linux we use the normal colored icons.
  const fileName = isMac ? `${name}-template.png` : `${name}.png`

  const iconPath = path.join(
    __dirname,
    '..',
    '..',
    'resources',
    'tray-icons',
    fileName
  )

  let image = nativeImage.createFromPath(iconPath)

  if (image.isEmpty()) {
    console.warn(`[Tray] Icon not found: ${iconPath}`)
    // Fallback to the colored icon if the template doesn't exist
    const fallback = path.join(__dirname, '..', '..', 'resources', 'tray-icons', `${name}.png`)
    image = nativeImage.createFromPath(fallback)
  }

  // Standard sizes: 18px on macOS (menu bar @1x), 16px on Windows/Linux
  const size = isMac ? 18 : 16
  image = image.resize({ width: size, height: size, quality: 'best' })

  // Template mode on macOS: automatically adapts to light/dark theme
  if (isMac) {
    image.setTemplateImage(true)
  }

  return image
}

function getIconCache(): Record<TrayStatus, NativeImage> {
  if (!iconCache) {
    iconCache = {
      connected:    loadTrayIcon('connected'),
      connecting:   loadTrayIcon('connecting'),
      disconnected: loadTrayIcon('disconnected'),
    }
  }
  return iconCache
}

function buildContextMenu(): Electron.Menu {
  const statusLabel =
    currentStatus === 'connected'
      ? '● Connected'
      : currentStatus === 'connecting'
        ? '◌ Connecting...'
        : '✗ Not connected'

  return Menu.buildFromTemplate([
    {
      label: BRIDGE_NAME,
      enabled: false
    },
    {
      label: statusLabel,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open window',
      click: () => options.onShow()
    },
    {
      label: `Start with ${getOSName()}`,
      type: 'checkbox',
      checked: false,
      click: async (menuItem) => {
        const enabled = await options.onToggleAutostart()
        menuItem.checked = enabled
        rebuildMenu()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => options.onQuit()
    }
  ])
}

function getOSName(): string {
  switch (process.platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'Mac'
    default: return 'Linux'
  }
}

async function rebuildMenu(): Promise<void> {
  if (!tray) return
  const enabled = await options.getAutostartEnabled()
  const menu = Menu.buildFromTemplate([
    {
      label: BRIDGE_NAME,
      enabled: false
    },
    {
      label:
        currentStatus === 'connected'
          ? '● Connected'
          : currentStatus === 'connecting'
            ? '◌ Connecting...'
            : '✗ Not connected',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open window',
      click: () => options.onShow()
    },
    {
      label: `Start with ${getOSName()}`,
      type: 'checkbox',
      checked: enabled,
      click: async (menuItem) => {
        const result = await options.onToggleAutostart()
        menuItem.checked = result
        rebuildMenu()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => options.onQuit()
    }
  ])
  tray.setContextMenu(menu)
}

export function setupTray(opts: TrayOptions): void {
  options = opts

  // Linux libappindicator check
  if (process.platform === 'linux') {
    try {
      // Attempt to create tray — will throw if libappindicator not available
    } catch {
      console.warn('[Tray] libappindicator not available on Linux. The tray may not work.')
    }
  }

  tray = new Tray(getIconCache().disconnected)
  tray.setToolTip(BRIDGE_NAME)
  tray.setContextMenu(buildContextMenu())

  tray.on('double-click', () => options.onShow())

  // Initial async menu build with autostart state
  rebuildMenu()
}

export function updateTrayStatus(status: TrayStatus): void {
  if (!tray) return
  currentStatus = status
  const icon = getIconCache()[status]

  tray.setImage(icon)

  if (process.platform === 'darwin') {
    tray.setPressedImage(icon)
  }
  rebuildMenu()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
