// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Prints the rclone env config of the host backups' network destination, one
 * KEY=value per line (docker --env-file format), for scripts/backup.sh:
 *
 *   docker compose exec -T backend node dist/backup/host-backup-destination.cli.js
 *
 * Runs inside the backend container because only it holds TOOL_SECRETS_KEY; whoever can
 * `docker exec` into it can read that key anyway, so this opens no new path to the secret.
 * Exit 2 when no network destination is configured.
 */
import { Client } from 'pg';
import { decrypt } from '../custom-tools/crypto.utils';
import { toRcloneEnv } from './host-backup-destination';

async function main(): Promise<number> {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'arkimede',
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT "destType", "destEncryptedUrl" FROM host_backup_config WHERE id = 1`,
    );
    const row = rows[0];
    if (!row || row.destType === 'local' || !row.destEncryptedUrl) return 2;
    for (const [k, v] of Object.entries(toRcloneEnv(decrypt(row.destEncryptedUrl)))) {
      if (/[\r\n]/.test(v)) throw new Error(`${k} contains a newline`);
      process.stdout.write(`${k}=${v}\n`);
    }
    return 0;
  } finally {
    await client.end();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`host-backup-destination: ${e?.message ?? e}\n`);
  process.exit(1);
});
