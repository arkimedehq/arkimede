import api from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export type VectorDbProvider = 'qdrant' | 'pgvector' | 'chroma' | 'astradb';

export interface VectorDbConfig {
  id:               number;
  provider:         VectorDbProvider;
  url:              string | null;
  connectionString: string | null;
  hasApiKey:        boolean;
  extraConfig:      Record<string, any> | null;
  updatedAt:        string;
}

export interface UpdateVectorDbConfigPayload {
  provider:          VectorDbProvider;
  url?:              string | null;
  connectionString?: string | null;
  /** Non-empty string → save, null → clear, undefined → keep */
  apiKey?:           string | null;
  extraConfig?:      Record<string, any> | null;
}

export interface VectorCollection {
  id:          string;
  name:        string;
  description: string | null;
  isDefault:   boolean;
  createdAt:   string;
  updatedAt:   string;
}

export interface CreateCollectionPayload {
  name:         string;
  description?: string | null;
  isDefault?:   boolean;
  /** Also auto-create the org-wide semantic search tool for this collection (default true). */
  createSearchTool?: boolean;
}

export interface UpdateCollectionPayload {
  name?:        string;
  description?: string | null;
  isDefault?:   boolean;
}

// ── Client ────────────────────────────────────────────────────────────────────

export const vectorDbApi = {
  // ── Config ─────────────────────────────────────────────────────────────────

  /** GET /api/admin/vector-db/config */
  getConfig: (): Promise<VectorDbConfig> =>
    api.get('/admin/vector-db/config').then((r) => r.data),

  /** PATCH /api/admin/vector-db/config */
  updateConfig: (payload: UpdateVectorDbConfigPayload): Promise<VectorDbConfig> =>
    api.patch('/admin/vector-db/config', payload).then((r) => r.data),

  // ── Collections ─────────────────────────────────────────────────────────────

  /** GET /api/admin/vector-db/collections */
  listCollections: (): Promise<VectorCollection[]> =>
    api.get('/admin/vector-db/collections').then((r) => r.data),

  /** POST /api/admin/vector-db/collections */
  createCollection: (payload: CreateCollectionPayload): Promise<VectorCollection> =>
    api.post('/admin/vector-db/collections', payload).then((r) => r.data),

  /** PATCH /api/admin/vector-db/collections/:id */
  updateCollection: (id: string, payload: UpdateCollectionPayload): Promise<VectorCollection> =>
    api.patch(`/admin/vector-db/collections/${id}`, payload).then((r) => r.data),

  /** POST /api/admin/vector-db/collections/:id/default */
  setDefault: (id: string): Promise<VectorCollection> =>
    api.post(`/admin/vector-db/collections/${id}/default`).then((r) => r.data),

  /** DELETE /api/admin/vector-db/collections/:id */
  deleteCollection: (id: string): Promise<void> =>
    api.delete(`/admin/vector-db/collections/${id}`).then(() => undefined),

  /**
   * DELETE /api/embed/collections/:name
   * Empties all vectors of the collection and recreates it empty.
   * ⚠️ Irreversible — does not delete the DB record, only the vectors.
   */
  clearCollection: (name: string): Promise<{ cleared: boolean; collection: string }> =>
    api.delete(`/embed/collections/${name}`).then((r) => r.data),
};
