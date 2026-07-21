/**
 * @file notifications.ts
 *
 * API client for persistent notifications.
 * All routes are authenticated (JWT via Authorization header).
 *
 * The backend returns records with { id, userId, source, sourceId,
 * eventType, payload, read, createdAt }.
 * We map them to the Zustand store's SkillNotification format for
 * compatibility with the existing components.
 */
import api from './client';
import type { SkillNotification } from '../store/useStore';

/** Maps the DB record to the format used in the store. */
function mapNotification(raw: any): SkillNotification {
  return {
    id:        raw.id,
    daemonId:  raw.sourceId ?? '',
    skillId:   (raw.payload?._skill_id as string) ?? '',
    eventType: raw.eventType,
    payload:   raw.payload ?? {},
    timestamp: raw.createdAt,
    read:      raw.read,
  };
}

export const notificationsApi = {
  /** Loads the user's latest notifications from the DB. */
  list: (): Promise<SkillNotification[]> =>
    api.get('/notifications').then((r) => r.data.map(mapNotification)),

  /** Marks a notification as read. */
  markRead: (id: string): Promise<void> =>
    api.patch(`/notifications/${id}/read`).then(() => undefined),

  /** Marks all notifications as read. */
  markAllRead: (): Promise<void> =>
    api.patch('/notifications/read-all').then(() => undefined),

  /** Deletes a specific notification. */
  delete: (id: string): Promise<void> =>
    api.delete(`/notifications/${id}`).then(() => undefined),

  /** Deletes all the user's notifications. */
  deleteAll: (): Promise<void> =>
    api.delete('/notifications').then(() => undefined),
};
