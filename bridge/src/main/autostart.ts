import AutoLaunch from 'auto-launch'
import { app } from 'electron'
import { BRIDGE_NAME } from './app.config'

const autoLauncher = new AutoLaunch({
  name: BRIDGE_NAME,
  path: app.getPath('exe'),
  isHidden: false
})

export async function setAutostart(enabled: boolean): Promise<void> {
  try {
    if (enabled) {
      await autoLauncher.enable()
    } else {
      await autoLauncher.disable()
    }
  } catch (err) {
    console.error('[Autostart] Error configuring autostart:', err)
  }
}

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    return await autoLauncher.isEnabled()
  } catch {
    return false
  }
}
