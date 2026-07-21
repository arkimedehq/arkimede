import api from './client';
import type { ToolLoadingStrategy, ToolSchemaFormat } from './appConfig';

export interface UserProfile {
  id:           string;
  email:        string;
  name:         string;
  role:         string;
  systemPrompt: string | null;
  /** Interface/response language ('it' | 'en'); null = auto-detect from browser. */
  language:     string | null;
  /** null = use the global default configured by the admin */
  toolLoadingStrategy: ToolLoadingStrategy | null;
  toolLoadingMaxTools: number | null;
  toolSchemaFormat:    ToolSchemaFormat | null;
  /** Shows the input/output token count under each assistant response. */
  showTokenCount: boolean;
  /** Conversation history token limit; null = use the admin's global default. */
  maxHistoryTokens: number | null;
  /** Persistent user memory: automatic extraction of durable facts. */
  autoMemoryEnabled: boolean;
  /** Memory extraction threshold override (n. messages); null = global default. */
  memoryThreshold: number | null;
  createdAt:    string;
  updatedAt:    string;
}

export const profileApi = {
  get: (): Promise<UserProfile> =>
    api.get('/users/me').then((r) => r.data),

  update: (data: {
    name?: string;
    email?: string;
    systemPrompt?: string | null;
    language?: string | null;
    toolLoadingStrategy?: ToolLoadingStrategy | null;
    toolLoadingMaxTools?: number | null;
    toolSchemaFormat?: ToolSchemaFormat | null;
    showTokenCount?: boolean;
    maxHistoryTokens?: number | null;
    autoMemoryEnabled?: boolean;
    memoryThreshold?: number | null;
  }): Promise<UserProfile> =>
    api.patch('/users/me', data).then((r) => r.data),

  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    api.post('/users/me/change-password', { currentPassword, newPassword }).then(() => undefined),
};
