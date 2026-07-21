// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

interface ImportMetaEnv {
    readonly VITE_APP_NAME: string;
    readonly VITE_BACKEND_URL: string;
    readonly VITE_WS_URL: string;
    readonly VITE_API_URL: string;
    readonly VITE_BRIDGE_REPO: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
