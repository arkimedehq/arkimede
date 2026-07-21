import api from './client';

export type ScheduleType = 'cron' | 'scheduled';
export type ScheduledTaskStatus = 'pending' | 'active' | 'done' | 'error';

export interface ScheduledTask {
  id: string;
  userId: string;
  instruction: string;
  title: string | null;
  scheduleType: ScheduleType;
  cron: string | null;
  runAt: string | null;
  timezone: string | null;
  projectId: string | null;
  enabled: boolean;
  status: ScheduledTaskStatus;
  lastRunAt: string | null;
  lastResult: string | null;
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  totalTokens: number;
  toolFilter: { mode: 'all' | 'names' | 'none'; names?: string[] };
  createdAt: string;
}

export const scheduledTasksApi = {
  list: (): Promise<ScheduledTask[]> => api.get('/scheduled-tasks').then((r) => r.data),
  activate: (id: string): Promise<ScheduledTask> =>
    api.post(`/scheduled-tasks/${id}/activate`).then((r) => r.data),
  /** Runs the automation now, out of schedule: the outcome arrives as a notification. */
  runNow: (id: string): Promise<{ queued: true }> =>
    api.post(`/scheduled-tasks/${id}/run`).then((r) => r.data),
  setEnabled: (id: string, enabled: boolean): Promise<ScheduledTask> =>
    api.patch(`/scheduled-tasks/${id}/enabled`, { enabled }).then((r) => r.data),
  remove: (id: string): Promise<void> => api.delete(`/scheduled-tasks/${id}`).then((r) => r.data),
};
