// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/// <reference types="vite/client" />

import type { BridgeAPI } from '../preload/index'

declare global {
  interface Window {
    bridge: BridgeAPI
  }
}
