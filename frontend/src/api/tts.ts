// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';

export const ttsApi = {
  /** GET /api/tts/status — true if read-aloud is enabled and its provider is available. */
  status: (): Promise<{ enabled: boolean }> =>
    api.get('/tts/status').then((r) => r.data),
};
