/// <reference types="vite/client" />

import type { BridgeAPI } from '../preload/index'

declare global {
  interface Window {
    bridge: BridgeAPI
  }
}
