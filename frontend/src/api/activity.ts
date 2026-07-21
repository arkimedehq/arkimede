import api from './client';

export interface ActivityDaemon {
  id: string;
  skillId: string | null;
  script: string | null;
  status: string;
  startedAt: string | null;
  lastEventAt: string | null;
}

export interface ActivityAutomation {
  id: string;
  title: string | null;
  scheduleType: 'cron' | 'scheduled';
  cron: string | null;
  runAt: string | null;
  status: 'pending' | 'active' | 'done' | 'error';
  enabled: boolean;
  lastRunAt: string | null;
  lastTokens: number;
  totalTokens: number;
}

export interface ActivityScheduledFlow {
  id: string;
  name: string;
  type: 'cron' | 'scheduled';
  cron: string | null;
  runAt: string | null;
}

export interface ActivityRun {
  id: string;
  flowName: string | null;
  status: string;
  triggeredBy: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ActivitySnapshot {
  counts: {
    daemons: number;
    automationsActive: number;
    automationsPending: number;
    scheduledFlows: number;
  };
  daemons: ActivityDaemon[];
  automations: ActivityAutomation[];
  scheduledFlows: ActivityScheduledFlow[];
  recentRuns: ActivityRun[];
}

export const activityApi = {
  get: (): Promise<ActivitySnapshot> => api.get('/activity').then((r) => r.data),
};
