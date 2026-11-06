// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The per-skill persistent state directory (T5a), the same for every way a skill runs: the broker mounts it at
 * /skill-state in a job, while daemons and in-process tasks get its path directly, so a daemon and the skill's task
 * scripts share their state (e.g. one login, one connection: a daemon serves the tasks' requests).
 */
import * as fs from 'fs';
import * as path from 'path';

/** Host root for the per-skill persistent state; when unset, the state lives in the skill's own folder. */
const STATE_HOST  = process.env.SKILL_STATE_HOST_BASE || '';
const SKILLS_BASE = process.env.SKILLS_BASE_PATH ?? '/app/skills';

/** The host state dir under SKILL_STATE_HOST_BASE (created, writable by the runner uid), or null when not configured. */
export function hostStateDir(skillId: string): string | null {
  if (!STATE_HOST) return null;
  const dir = path.join(STATE_HOST, skillId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777); // writable by the container uid (non-root runner)
    return dir;
  } catch {
    return null;
  }
}

/** The state dir for a daemon or an in-process task: the host one, else `<skill>/.state`. */
export function skillStateDir(skillId: string): string | undefined {
  const host = hostStateDir(skillId);
  if (host) return host;
  const dir = path.join(SKILLS_BASE, skillId, '.state');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}
