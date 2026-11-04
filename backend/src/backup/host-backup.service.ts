// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { encrypt, decrypt } from '../custom-tools/crypto.utils';
import { fileshareDriver } from '../datasources/fileshare/fileshare.driver';
import {
  buildDestinationUrl, describeDestination, destinationFields,
  HostBackupDestinationInput, HostBackupNetworkType, HOST_BACKUP_NETWORK_TYPES,
} from './host-backup-destination';
import { DEFAULT_BACKUP_SCHEDULE, isValidBackupSchedule } from './backup-schedule';

export type HostBackupDestType = 'local' | HostBackupNetworkType;

export interface HostBackupConfigUpdate {
  schedule?: string;
  keepDaily?: number;
  keepBase?: number;
  baseWeekday?: number;
  walArchiving?: boolean;
  destType?: HostBackupDestType;
  /** Network destination; `password` empty/absent keeps the stored one. */
  destination?: Omit<HostBackupDestinationInput, 'type' | 'password'> & { password?: string };
}

/**
 * Settings and status of the host-level scheduled backups. The work itself is done on
 * the host by scripts/backup.sh (root cron): it reads this configuration with psql and
 * writes its runs and WAL-shipping state back. This service only edits the settings,
 * tests a network destination and renders the state for Settings → Backup.
 */
@Injectable()
export class HostBackupService {
  private readonly logger = new Logger(HostBackupService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async getStatus() {
    const [cfg] = await this.db.query(`SELECT * FROM host_backup_config WHERE id = 1`);
    const runs = await this.db.query(
      `SELECT id, kind, status, "startedAt", "finishedAt", "sizeBytes", location, message
         FROM host_backup_runs ORDER BY "startedAt" DESC LIMIT 30`,
    );
    const [archiver] = await this.db.query(
      `SELECT current_setting('archive_mode') AS "archiveMode", archived_count AS "archivedCount",
              last_archived_wal AS "lastArchivedWal", last_archived_time AS "lastArchivedTime",
              failed_count AS "failedCount", last_failed_wal AS "lastFailedWal",
              last_failed_time AS "lastFailedTime"
         FROM pg_stat_archiver`,
    );
    let destination: ReturnType<typeof destinationFields> | null = null;
    if (cfg?.destEncryptedUrl) {
      try {
        destination = destinationFields(decrypt(cfg.destEncryptedUrl));
      } catch (e: any) {
        this.logger.warn(`Host backup destination unreadable: ${e.message}`);
      }
    }
    const lastOf = (kind: string) => runs.find((r: any) => r.kind === kind) ?? null;
    return {
      settings: {
        schedule: cfg?.schedule ?? DEFAULT_BACKUP_SCHEDULE,
        keepDaily: cfg?.keepDaily ?? 7,
        keepBase: cfg?.keepBase ?? 4,
        baseWeekday: cfg?.baseWeekday ?? 0,
        walArchiving: cfg?.walArchiving ?? false,
        destType: (cfg?.destType ?? 'local') as HostBackupDestType,
        destination,
        hasPassword: !!cfg?.destEncryptedUrl,
      },
      state: {
        destResolved: cfg?.destResolved ?? null,
        destReachable: cfg?.destReachable ?? null,
        destCheckedAt: cfg?.destCheckedAt ?? null,
        walAppliedMode: cfg?.walAppliedMode ?? null,
        walShippedAt: cfg?.walShippedAt ?? null,
        walLastSegment: cfg?.walLastSegment ?? null,
        walSpoolBytes: cfg?.walSpoolBytes != null ? Number(cfg.walSpoolBytes) : null,
        walGapSegment: cfg?.walGapSegment ?? null,
        archiver: archiver ?? null,
        lastDaily: lastOf('daily'),
        lastBase: lastOf('base'),
        alertWebhookConfigured: !!process.env.HOST_BACKUP_ALERT_WEBHOOK,
      },
      runs: runs.map((r: any) => ({ ...r, sizeBytes: r.sizeBytes != null ? Number(r.sizeBytes) : null })),
    };
  }

  async updateConfig(dto: HostBackupConfigUpdate) {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`"${col}" = $${params.length}`); };

    if (dto.schedule !== undefined) {
      const schedule = dto.schedule.trim().replace(/\s+/g, ' ');
      if (!isValidBackupSchedule(schedule)) throw new BadRequestException('backup.host.invalidSchedule');
      set('schedule', schedule);
    }
    if (dto.keepDaily !== undefined) set('keepDaily', dto.keepDaily);
    if (dto.keepBase !== undefined) set('keepBase', dto.keepBase);
    if (dto.baseWeekday !== undefined) set('baseWeekday', dto.baseWeekday);
    if (dto.walArchiving !== undefined) set('walArchiving', dto.walArchiving);
    if (dto.destType !== undefined) {
      set('destType', dto.destType);
      if (dto.destType === 'local') {
        set('destEncryptedUrl', null);
        set('destLabel', null);
      } else {
        const url = await this.networkUrl(dto.destType, dto.destination);
        set('destEncryptedUrl', encrypt(url));
        set('destLabel', describeDestination(url));
      }
    }
    if (sets.length) {
      sets.push(`"updatedAt" = now()`);
      await this.db.query(`UPDATE host_backup_config SET ${sets.join(', ')} WHERE id = 1`, params);
    }
    return this.getStatus();
  }

  /**
   * Connects to a network destination and writes + deletes a probe file in its folder.
   * Tests the form's values (stored password when the field is left empty).
   */
  async testDestination(type: HostBackupNetworkType, dest: HostBackupConfigUpdate['destination']) {
    const url = await this.networkUrl(type, dest);
    const probe = `.arkimede-backup-probe-${Date.now()}`;
    try {
      await fileshareDriver.testConnection(type, url);
    } catch (e: any) {
      return { ok: false, stage: 'connect', error: String(e?.message ?? e) };
    }
    try {
      await fileshareDriver.execute(type, url, { op: 'write', path: probe, content: Buffer.from('ok').toString('base64') });
      await fileshareDriver.execute(type, url, { op: 'delete', path: probe });
    } catch (e: any) {
      return { ok: false, stage: 'write', error: String(e?.message ?? e) };
    }
    return { ok: true, label: describeDestination(url) };
  }

  /** Full URL from the form; an empty password reuses the stored one. */
  private async networkUrl(type: HostBackupDestType, dest: HostBackupConfigUpdate['destination']): Promise<string> {
    if (!HOST_BACKUP_NETWORK_TYPES.includes(type as HostBackupNetworkType)) {
      throw new BadRequestException('backup.host.invalidDestination');
    }
    if (!dest?.host?.trim() || !dest.username?.trim()) throw new BadRequestException('backup.host.destinationIncomplete');
    if (type === 'smb' && !dest.share?.trim()) throw new BadRequestException('backup.host.shareRequired');
    let password = dest.password ?? '';
    if (!password) {
      const [cfg] = await this.db.query(`SELECT "destEncryptedUrl" FROM host_backup_config WHERE id = 1`);
      if (!cfg?.destEncryptedUrl) throw new BadRequestException('backup.host.passwordRequired');
      password = new URL(decrypt(cfg.destEncryptedUrl)).password;
      password = decodeURIComponent(password);
    }
    return buildDestinationUrl({ ...dest, type: type as HostBackupNetworkType, password });
  }
}
