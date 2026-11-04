# Backups and restore

*[Italiano](BACKUP_it.md)*

Arkimede has two kinds of backup:

| | Scheduled host backups (this guide) | On-demand backups |
|---|---|---|
| Made by | `scripts/backup.sh`, root's cron on the server | the backend, *Create backup* button |
| Where | a server folder (`HOST_BACKUP_DIR`) or a network share (SMB / SFTP / WebDAV) | the `backups` volume, downloadable |
| Point-in-time recovery | yes, with WAL archiving on | no |
| Settings and state | **Settings → Backup** | same page |

A copy on the same disk as the data is lost with that disk: send the scheduled backups to
another disk or to a NAS.

## 1. What is saved

On the schedule (default every night at 02:15, §2) `<destination>/arkimede-backup-<timestamp>/`:

| File | Content |
|---|---|
| `db.sql.gz`, `globals.sql.gz` | logical dump of the Arkimede database, and the roles |
| `uploads.tgz` | user files (the `uploads` volume) |
| `skills_data.tgz` | skills (the `skills_data` volume) |
| `qdrant_data.tgz` | vectors (Qdrant is paused for the copy, a few seconds) — see §6 |
| `host-data.tgz` | `HOST_DATA_DIR`: `skills`, `state` (e.g. skill sessions), `skills-output`, `sandbox` (broker profile only) |
| `config.tgz` | `.env` files, `scripts/.compose-profile`, compose overlays. **Without `TOOL_SECRETS_KEY` the encrypted secrets in the dump cannot be read back.** Mode 0600 |
| `SHA256SUMS` | checksums, checked by the restore test |

With WAL archiving on (§3), also:

```
<destination>/wal/base/base-<timestamp>/   base.tar.gz, START_WAL, SHA256SUMS   (weekly)
<destination>/wal/archive/                 WAL segments, gzip                    (continuous)
```

Not saved on purpose: Redis (queue and cache, transient), the Nix store and the ML models
(downloaded again).

**Recordare** (or any other database on the same Postgres) is *not* in the snapshot dump — it
makes its own backup — but it *is* in the base backups and the WAL archive, which cover the
whole Postgres instance.

A backup is written as `<name>.part` and renamed only when complete: a run that fails or is
interrupted leaves no half backup under a real name (the leftover `.part` is removed by the next
run).

## 2. Set-up

### Server side (once)

1. In `.env` (all optional — see `.env.example`):

   | Variable | Meaning |
   |---|---|
   | `HOST_BACKUP_DIR` | server folder for the backups (absolute). Empty = `./backups` |
   | `HOST_BACKUP_REQUIRE_MOUNT` | mount point that must be mounted, e.g. `/mnt/backup` when `HOST_BACKUP_DIR=/mnt/backup/arkimede`. If it is not mounted or does not answer: clear error, nothing written (nothing ends up on the local disk under the empty mount point) |
   | `HOST_BACKUP_ALERT_WEBHOOK` | URL POSTed on failures and alarms (JSON `host`, `kind`, `subject`, `value`, `message`) — e.g. a Flow webhook that sends to Telegram |
   | `HOST_BACKUP_WAL_SPOOL_MB` | WAL spool limit while the destination is unreachable (default 1024) |
   | `HOST_BACKUP_WAL_TIMEOUT` | longest wait before a partly filled WAL segment is archived, seconds (default 300) |
   | `HOST_BACKUP_QDRANT` | `on`/`off`: vectors in the snapshot (default `on`) |

2. Install the job, **as root** (it must be able to write the destination, e.g. a share mounted
   for root only, and to run `docker`):

   ```bash
   sudo ./scripts/backup.sh install-cron
   ```

   It writes `/etc/cron.d/arkimede-backup`: a single line running `backup.sh tick` every
   minute (`backups/scheduler.log`, silent when there is nothing to do). The tick starts a
   snapshot when the schedule set in Settings → Backup fires (`backups/backup.log`) and ships
   the WAL. The schedule lives in the database, so changing it needs nothing on the server.
   Remove any older crontab line that runs `backup.sh`.

3. Update the stack once so Postgres gets the `wal_spool` volume:
   `./scripts/compose.sh up -d postgres` (a few seconds of downtime).

### Settings → Backup (admin)

- **When to take the snapshot**: every day at a time, every N hours, every week on a day and
  time, or a custom cron expression (`minute hour day month weekday`, e.g. `0 */6 * * *`,
  `30 1 * * 1-5`; `*`, `a-b`, `/n` steps and comma lists; no names or `@daily`). Server local
  time; the minute must be fixed, so at most one snapshot an hour. Default `15 2 * * *`. A
  snapshot still running when the next one is due makes that one skip. A time missed while
  the server was off is not recovered: the next one runs on schedule.
- **Snapshots to keep** (default 7), **base backups to keep** (default 4 = four weeks of
  point-in-time recovery), **base backup day** (default Sunday).
- **Continuous WAL archiving** — §3.
- **Where backups go**: the server folder of `HOST_BACKUP_DIR`, or a **network share with a
  username and password**: SMB/CIFS (host, share, optional domain, folder), SFTP or WebDAV
  (optionally HTTPS). *Test connection* connects and writes and deletes a probe file. The
  password is encrypted in the database (`TOOL_SECRETS_KEY`, like the DataSources); the server
  uses the share directly, without mounting it: the files are moved by an `rclone` container
  (`rclone/rclone`, image set by `HOST_BACKUP_RCLONE_IMAGE`). A server path cannot be chosen
  from the interface on purpose: the job runs as root.
- State: destination and reachability, last snapshot and base backup, WAL archiving (last
  segment shipped, spool size, failures), the latest runs and alarms.

From the shell:

```bash
./scripts/backup.sh status    # settings, destination, snapshots, base backups, recent runs
./scripts/backup.sh run       # a snapshot now (the schedule does not matter)
./scripts/backup.sh base      # a base backup now (WAL archiving on)
```

## 3. Continuous WAL archiving (point-in-time recovery)

A snapshot brings you back to when it was taken. With WAL archiving on, Postgres archives
every change and the database can be brought back to **any moment** covered by the archive
(from the oldest base backup kept, up to a few minutes ago).

How it works:

1. **Switch it on** in Settings → Backup. Within a minute the job sets `archive_mode`,
   `archive_command`, `archive_timeout` and `wal_recycle=off` with `ALTER SYSTEM` and restarts
   Postgres (a few seconds). Switching it off undoes the same settings. If the switch fails it
   raises an alarm and does not retry until the setting changes.
2. Postgres hands each finished WAL segment to `scripts/pg-wal-archive.sh`, which only
   compresses it into a **local spool** (the `wal_spool` volume): archiving never waits on the
   network.
3. Every minute `backup.sh wal-ship` moves the spool to `<destination>/wal/archive/`.
   `archive_timeout` closes a segment at least every 5 minutes, so at most ~6 minutes of work
   are exposed.
4. Every week (the day you chose; also the first time, and whenever the newest one is older
   than 7 days) the snapshot run takes a **base backup** (`pg_basebackup`, consistent, with the
   WAL needed to open it). Old base backups beyond the number kept are deleted with the WAL
   older than the oldest one kept.

**If the destination is unreachable** WAL waits in the spool. It never fills the disk:

- at half the spool limit → alarm;
- at the limit, new segments are **dropped** (instead of failing — a failing archive makes
  Postgres keep all WAL in `pg_wal` and can fill the disk) and the first one dropped is
  recorded (`GAP`) → alarm. Point-in-time recovery cannot cross that gap;
- when the destination comes back the spool is shipped and **a new base backup is taken
  automatically**: point-in-time recovery works again from that moment. Alarm cleared.

## 4. Alarms

Raised by the job, listed in Settings → Backup and POSTed to `HOST_BACKUP_ALERT_WEBHOOK` if set.
Each condition alarms once when it starts and once when it clears:

- snapshot failed / destination unavailable (nothing written);
- destination unreachable for WAL shipping;
- WAL spool over half its limit; WAL archive gap;
- WAL archiving switch not applied.

## 5. Restore test (always on a throwaway container)

`scripts/restore-test.sh` proves that a backup restores, without touching the running stack:
its own Postgres container with no network and its own temporary volume, both removed at the
end. From a network destination the files are first copied to a temporary folder.

```bash
# Snapshot (default: the newest): checksums, archives readable, dump loaded into an
# empty Postgres, row counts (users, chats, messages, files, newest message, last migration)
./scripts/restore-test.sh snapshot [arkimede-backup-20261102-021501]

# Point in time: base backup + archived WAL replayed up to the target (default: the end of
# the archive), then the same row counts. Postgres logs where it stopped.
./scripts/restore-test.sh pitr --target "2026-11-02 14:30:00+01"
./scripts/restore-test.sh pitr --base base-20261101-021712
```

Run it after setting up, after changing destination, and from time to time: a backup
never restored is a hope, not a backup. It also tells you which moment to choose before a
real restore.

## 6. Restore

Always: first run the restore test on the same backup, then **keep the current data aside**
(never delete them before the restore is verified). Commands below use the compose project
`arkimede`; see `docker volume ls` for yours. Volumes are `<project>_<name>`.

### 6.1 From a snapshot (whole platform, or a new server)

```bash
B=/path/to/arkimede-backup-<timestamp>          # copied from the destination
cd /opt/arkimede
# configuration (a new server: before the first start)
tar xzf $B/config.tgz                            # .env, .env.executor, overlays…
./scripts/compose.sh stop backend executor        # nobody writes while restoring

# database: fresh empty database, then the dump
./scripts/compose.sh exec -T postgres psql -U postgres -c 'DROP DATABASE arkimede WITH (FORCE)' -c 'CREATE DATABASE arkimede'
gunzip -c $B/db.sql.gz | ./scripts/compose.sh exec -T postgres psql -U postgres -d arkimede -v ON_ERROR_STOP=1

# volumes (one per archive)
for v in uploads skills_data qdrant_data; do
  docker run --rm -v arkimede_$v:/dst -v $B:/b:ro alpine sh -c "rm -rf /dst/* && tar xzf /b/$v.tgz -C /dst"
done
# host data (broker profile)
sudo tar xzf $B/host-data.tgz -C /path/of/HOST_DATA_DIR

./scripts/compose.sh up -d
```

### 6.2 Database to a moment in time (point-in-time recovery)

Restores the **whole Postgres instance** (Arkimede and every other database on it, Recordare
included) to the chosen moment.

```bash
P=arkimede; IMG=pgvector/pgvector:pg16
T="2026-11-02 14:30:00+01"                      # checked first with restore-test.sh pitr
BASE=/path/to/wal/base/base-<timestamp>          # newest base backup BEFORE $T
WAL=/path/to/wal/archive                          # the archive (only segments >= START_WAL are needed)

./scripts/compose.sh stop                         # the whole stack
# keep the current data aside
docker run --rm -v ${P}_postgres_data:/d -v /root:/out alpine tar czf /out/pgdata-before-restore.tgz -C /d .

docker run --rm -v ${P}_postgres_data:/d -v $BASE:/base:ro -v $WAL:/wal:ro $IMG bash -ec '
  find /d -mindepth 1 -delete
  tar xzf /base/base.tar.gz -C /d
  mkdir /d/restore-wal && cp /wal/* /d/restore-wal/'
# recovery settings (later lines win over the archiving ones saved in the base backup)
docker run --rm -i -v ${P}_postgres_data:/d $IMG bash -ec '
  cat >> /d/postgresql.auto.conf
  touch /d/recovery.signal
  chown -R postgres:postgres /d && chmod 700 /d' <<EOF
archive_mode = off
restore_command = 'gunzip -c /var/lib/postgresql/data/restore-wal/%f.gz > %p'
recovery_target_time = '$T'
recovery_target_action = 'promote'
EOF

./scripts/compose.sh up -d postgres
./scripts/compose.sh logs -f postgres     # "recovery stopping before …", "selected new timeline ID"
```

Then: remove the recovery lines (`ALTER SYSTEM RESET restore_command; ALTER SYSTEM RESET
recovery_target_time; ALTER SYSTEM RESET recovery_target_action;`) and the `restore-wal`
folder, start the rest (`./scripts/compose.sh up -d`). The WAL archiving settings come back
within a minute (from Settings → Backup); take a new base backup right away
(`./scripts/backup.sh base`): the restored database is on a new timeline.

The files (`uploads`, skills) are not rolled back by WAL: take them from the snapshot
closest to the moment, as in §6.1.

### 6.3 A single volume

```bash
docker run --rm -v arkimede_uploads:/dst -v $B:/b:ro alpine sh -c 'rm -rf /dst/* && tar xzf /b/uploads.tgz -C /dst'
```

### 6.4 Vectors (Qdrant)

The vectors are derived data: everything they are computed from lives elsewhere. Options, from
quickest:

1. **Restore `qdrant_data.tgz`** of the snapshot (§6.3, with Qdrant stopped). Documents
   indexed after that night are missing: index them again.
2. **Regenerate** if the archive is missing or the model changed:
   - memories and feedback: their text is in Postgres — *Settings → Memory → re-index*
     (`POST /api/user-memory/reindex`) and the re-embed job (`POST /api/admin/vector-db/reembed`,
     docs/EMBEDDING_REEMBED_PLAN.md), which recomputes the vectors of an existing collection
     from the text kept with each point;
   - uploaded files: index them again from **Files** (the originals are in `uploads`);
   - DataSource files, RAG-tool texts, skill collections: run their ingestion again (the
     re-embed job reports them as "needs re-ingest" when the points carry no text).

`HOST_BACKUP_QDRANT=off` leaves them out of the snapshot on a large store, accepting the
re-indexing time.

## 7. Notes

- The job writes as root: on an SMB share mounted for root only (`uid=0`, `0700`) that is the
  only user that can write it. A network destination set in the interface has no such limit.
- `scripts/update.sh` still takes a snapshot before updating (to the configured destination).
- Logs: `backups/backup.log` (snapshots), `backups/scheduler.log` (tick, WAL shipping). Local state of the job (locks, alarm
  flags): `backups/.state/`.
