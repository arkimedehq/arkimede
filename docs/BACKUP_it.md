# Backup e ripristino

*[English](BACKUP.md)*

Arkimede ha due tipi di backup:

| | Backup programmati sul server (questa guida) | Backup su richiesta |
|---|---|---|
| Chi li fa | `scripts/backup.sh`, cron di root sul server | il backend, pulsante *Crea backup* |
| Dove | una cartella del server (`HOST_BACKUP_DIR`) o una condivisione di rete (SMB / SFTP / WebDAV) | il volume `backups`, scaricabili |
| Ripristino a un istante | sì, con l'archiviazione WAL accesa | no |
| Impostazioni e stato | **Impostazioni → Backup** | stessa pagina |

Una copia sullo stesso disco dei dati si perde con quel disco: manda i backup programmati su
un altro disco o su un NAS.

## 1. Cosa viene salvato

Secondo la pianificazione (predefinita ogni notte alle 02:15, §2) `<destinazione>/arkimede-backup-<timestamp>/`:

| File | Contenuto |
|---|---|
| `db.sql.gz`, `globals.sql.gz` | dump logico del database di Arkimede, e i ruoli |
| `uploads.tgz` | file degli utenti (volume `uploads`) |
| `skills_data.tgz` | skill (volume `skills_data`) |
| `qdrant_data.tgz` | vettori (Qdrant messo in pausa durante la copia, pochi secondi) — vedi §6 |
| `host-data.tgz` | `HOST_DATA_DIR`: `skills`, `state` (es. sessioni delle skill), `skills-output`, `sandbox` (solo profilo broker) |
| `config.tgz` | file `.env`, `scripts/.compose-profile`, overlay compose. **Senza `TOOL_SECRETS_KEY` i segreti cifrati nel dump non si rileggono.** Permessi 0600 |
| `SHA256SUMS` | checksum, verificati dalla prova di ripristino |

Con l'archiviazione WAL accesa (§3), in più:

```
<destinazione>/wal/base/base-<timestamp>/   base.tar.gz, START_WAL, SHA256SUMS   (settimanale)
<destinazione>/wal/archive/                 segmenti WAL, gzip                    (continuo)
```

Non salvati di proposito: Redis (coda e cache, transitori), lo store Nix e i modelli ML
(si riscaricano).

**Recordare** (o qualunque altro database sullo stesso Postgres) *non* è nel dump dello snapshot —
fa il suo backup — ma *è* nei backup base e nell'archivio WAL, che coprono l'intera istanza
Postgres.

Un backup si scrive come `<nome>.part` e si rinomina solo quando è completo: un giro fallito
o interrotto non lascia mezzo backup con un nome vero (il `.part` rimasto lo toglie il giro
successivo).

## 2. Configurazione

### Sul server (una volta)

1. Nel `.env` (tutte facoltative — vedi `.env.example`):

   | Variabile | Significato |
   |---|---|
   | `HOST_BACKUP_DIR` | cartella del server per i backup (assoluta). Vuota = `./backups` |
   | `HOST_BACKUP_REQUIRE_MOUNT` | punto di mount che deve essere montato, es. `/mnt/backup` con `HOST_BACKUP_DIR=/mnt/backup/arkimede`. Se non è montato o non risponde: errore chiaro, niente scritto (niente finisce sul disco locale sotto il mount vuoto) |
   | `HOST_BACKUP_ALERT_WEBHOOK` | URL a cui fare POST di errori e allarmi (JSON `host`, `kind`, `subject`, `value`, `message`) — es. un webhook di un Flow che inoltra a Telegram |
   | `HOST_BACKUP_WAL_SPOOL_MB` | limite dello spool WAL mentre la destinazione non risponde (predefinito 1024) |
   | `HOST_BACKUP_WAL_TIMEOUT` | attesa massima prima di archiviare un segmento WAL non pieno, secondi (predefinito 300) |
   | `HOST_BACKUP_QDRANT` | `on`/`off`: vettori nello snapshot (predefinito `on`) |

2. Installa il job, **come root** (deve poter scrivere la destinazione, es. una condivisione
   montata solo per root, e usare `docker`):

   ```bash
   sudo ./scripts/backup.sh install-cron
   ```

   Scrive `/etc/cron.d/arkimede-backup`: una sola riga che lancia `backup.sh tick` ogni minuto
   (`backups/scheduler.log`, muto quando non c'è niente da fare). Il tick avvia uno snapshot
   quando scatta la pianificazione impostata in Impostazioni → Backup (`backups/backup.log`) e
   invia il WAL. La pianificazione sta nel database: cambiarla non richiede niente sul server.
   Togli eventuali vecchie righe di crontab che lanciano `backup.sh`.

3. Aggiorna lo stack una volta perché Postgres abbia il volume `wal_spool`:
   `./scripts/compose.sh up -d postgres` (qualche secondo di fermo).

### Impostazioni → Backup (admin)

- **Quando fare lo snapshot**: ogni giorno a un'ora, ogni N ore, ogni settimana in un giorno
  e a un'ora, o un'espressione cron personalizzata (`minuto ora giorno mese giorno-settimana`,
  es. `0 */6 * * *`, `30 1 * * 1-5`; `*`, `a-b`, passi `/n` e liste con la virgola; niente nomi
  né `@daily`). Ora locale del server; il minuto deve essere fisso, quindi al più uno snapshot
  all'ora. Predefinita `15 2 * * *`. Se uno snapshot è ancora in corso quando scatta il
  successivo, quest'ultimo salta. Un orario perso a server spento non si recupera: il
  successivo parte all'ora prevista.
- **Snapshot da conservare** (predefinito 7), **backup base da conservare** (predefinito 4 =
  quattro settimane di ripristino a un istante), **giorno del backup base** (predefinito
  domenica).
- **Archiviazione continua WAL** — §3.
- **Dove vanno i backup**: la cartella del server di `HOST_BACKUP_DIR`, oppure una
  **condivisione di rete con utente e password**: SMB/CIFS (host, condivisione, dominio
  facoltativo, cartella), SFTP o WebDAV (anche HTTPS). *Prova connessione* si collega, scrive e
  cancella un file di prova. La password è cifrata nel database (`TOOL_SECRETS_KEY`, come le
  DataSource); il server usa la condivisione direttamente, senza montarla: i file li sposta un
  container `rclone` (`rclone/rclone`, immagine impostabile con `HOST_BACKUP_RCLONE_IMAGE`).
  Un percorso del server non si sceglie dall'interfaccia, di proposito: il job gira come root.
- Stato: destinazione e raggiungibilità, ultimo snapshot e backup base, archiviazione WAL
  (ultimo segmento inviato, dimensione dello spool, errori), ultime esecuzioni e allarmi.

Da shell:

```bash
./scripts/backup.sh status    # impostazioni, destinazione, snapshot, backup base, ultime esecuzioni
./scripts/backup.sh run       # uno snapshot adesso (indipendente dalla pianificazione)
./scripts/backup.sh base      # un backup base adesso (archiviazione WAL accesa)
```

## 3. Archiviazione continua WAL (ripristino a un istante)

Uno snapshot riporta al momento in cui è stato fatto. Con l'archiviazione WAL Postgres archivia ogni
modifica e il database si può riportare a **qualsiasi momento** coperto dall'archivio (dal
backup base più vecchio conservato fino a pochi minuti fa).

Come funziona:

1. **Accendila** in Impostazioni → Backup. Entro un minuto il job imposta `archive_mode`,
   `archive_command`, `archive_timeout` e `wal_recycle=off` con `ALTER SYSTEM` e riavvia
   Postgres (qualche secondo). Spegnendola si annullano le stesse impostazioni. Se il cambio
   fallisce manda un allarme e non riprova finché l'impostazione non cambia.
2. Postgres passa ogni segmento WAL finito a `scripts/pg-wal-archive.sh`, che lo comprime
   soltanto in uno **spool locale** (il volume `wal_spool`): l'archiviazione non aspetta mai
   la rete.
3. Ogni minuto `backup.sh wal-ship` sposta lo spool in `<destinazione>/wal/archive/`.
   `archive_timeout` chiude un segmento almeno ogni 5 minuti: al massimo ~6 minuti di lavoro
   sono scoperti.
4. Ogni settimana (il giorno scelto; anche la prima volta, e ogni volta che il più recente ha
   più di 7 giorni) il giro dello snapshot fa un **backup base** (`pg_basebackup`, coerente, con il
   WAL che serve ad aprirlo). I backup base oltre il numero conservato si cancellano insieme al
   WAL più vecchio del più vecchio rimasto.

**Se la destinazione non risponde** il WAL aspetta nello spool. Non riempie mai il disco:

- a metà del limite dello spool → allarme;
- al limite i nuovi segmenti vengono **scartati** (invece di fallire — un'archiviazione che
  fallisce fa tenere a Postgres tutto il WAL in `pg_wal` e può riempire il disco) e il primo
  scartato viene registrato (`GAP`) → allarme. Il ripristino a un istante non può superare quel
  buco;
- quando la destinazione torna lo spool viene inviato e **si fa da solo un nuovo backup
  base**: il ripristino a un istante funziona di nuovo da quel momento. Allarme rientrato.

## 4. Allarmi

Li solleva il job, sono elencati in Impostazioni → Backup e inviati con POST a
`HOST_BACKUP_ALERT_WEBHOOK` se impostato. Ogni condizione avvisa una volta quando inizia e una
quando rientra:

- snapshot fallito / destinazione non disponibile (niente scritto);
- destinazione non raggiungibile per l'invio del WAL;
- spool WAL oltre metà del limite; buco nell'archivio WAL;
- interruttore dell'archiviazione WAL non applicato.

## 5. Prova di ripristino (sempre su un container usa e getta)

`scripts/restore-test.sh` dimostra che un backup si ripristina, senza toccare lo stack in
funzione: un suo container Postgres senza rete e un suo volume temporaneo, entrambi rimossi
alla fine. Da una destinazione di rete i file vengono prima copiati in una cartella
temporanea.

```bash
# Snapshot (predefinito: il più recente): checksum, archivi leggibili, dump caricato
# in un Postgres vuoto, conteggi (utenti, chat, messaggi, file, ultimo messaggio, ultima migration)
./scripts/restore-test.sh snapshot [arkimede-backup-20261102-021501]

# A un istante: backup base + WAL archiviato rieseguito fino al target (predefinito: la fine
# dell'archivio), poi gli stessi conteggi. Postgres scrive nel log dove si è fermato.
./scripts/restore-test.sh pitr --target "2026-11-02 14:30:00+01"
./scripts/restore-test.sh pitr --base base-20261101-021712
```

Lanciala dopo la configurazione, dopo un cambio di destinazione e ogni tanto: un backup mai
ripristinato è una speranza, non un backup. Serve anche a scegliere l'istante giusto prima di
un ripristino vero.

## 6. Ripristino

Sempre: prima la prova di ripristino sullo stesso backup, poi **metti da parte i dati
attuali** (mai cancellarli prima di aver verificato il ripristino). I comandi usano il
progetto compose `arkimede`; vedi `docker volume ls` per il tuo. I volumi sono
`<progetto>_<nome>`.

### 6.1 Da uno snapshot (piattaforma intera, o server nuovo)

```bash
B=/percorso/di/arkimede-backup-<timestamp>      # copiato dalla destinazione
cd /opt/arkimede
# configurazione (server nuovo: prima del primo avvio)
tar xzf $B/config.tgz                            # .env, .env.executor, overlay…
./scripts/compose.sh stop backend executor        # nessuno scrive durante il ripristino

# database: database nuovo e vuoto, poi il dump
./scripts/compose.sh exec -T postgres psql -U postgres -c 'DROP DATABASE arkimede WITH (FORCE)' -c 'CREATE DATABASE arkimede'
gunzip -c $B/db.sql.gz | ./scripts/compose.sh exec -T postgres psql -U postgres -d arkimede -v ON_ERROR_STOP=1

# volumi (uno per archivio)
for v in uploads skills_data qdrant_data; do
  docker run --rm -v arkimede_$v:/dst -v $B:/b:ro alpine sh -c "rm -rf /dst/* && tar xzf /b/$v.tgz -C /dst"
done
# dati host (profilo broker)
sudo tar xzf $B/host-data.tgz -C /percorso/di/HOST_DATA_DIR

./scripts/compose.sh up -d
```

### 6.2 Database a un istante preciso

Riporta **l'intera istanza Postgres** (Arkimede e ogni altro database che ospita, Recordare
compreso) al momento scelto.

```bash
P=arkimede; IMG=pgvector/pgvector:pg16
T="2026-11-02 14:30:00+01"                      # verificato prima con restore-test.sh pitr
BASE=/percorso/di/wal/base/base-<timestamp>      # il backup base più recente PRIMA di $T
WAL=/percorso/di/wal/archive                      # l'archivio (servono solo i segmenti >= START_WAL)

./scripts/compose.sh stop                         # tutto lo stack
# metti da parte i dati attuali
docker run --rm -v ${P}_postgres_data:/d -v /root:/out alpine tar czf /out/pgdata-prima-del-ripristino.tgz -C /d .

docker run --rm -v ${P}_postgres_data:/d -v $BASE:/base:ro -v $WAL:/wal:ro $IMG bash -ec '
  find /d -mindepth 1 -delete
  tar xzf /base/base.tar.gz -C /d
  mkdir /d/restore-wal && cp /wal/* /d/restore-wal/'
# impostazioni di recovery (le righe in fondo vincono su quelle di archiviazione salvate nel backup base)
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

Poi: togli le righe di recovery (`ALTER SYSTEM RESET restore_command; ALTER SYSTEM RESET
recovery_target_time; ALTER SYSTEM RESET recovery_target_action;`) e la cartella
`restore-wal`, avvia il resto (`./scripts/compose.sh up -d`). Le impostazioni di archiviazione
WAL tornano entro un minuto (da Impostazioni → Backup); fai subito un nuovo backup base
(`./scripts/backup.sh base`): il database ripristinato è su una nuova timeline.

I file (`uploads`, skill) non tornano indietro col WAL: prendili dallo snapshot più
vicino al momento, come in §6.1.

### 6.3 Un singolo volume

```bash
docker run --rm -v arkimede_uploads:/dst -v $B:/b:ro alpine sh -c 'rm -rf /dst/* && tar xzf /b/uploads.tgz -C /dst'
```

### 6.4 Vettori (Qdrant)

I vettori sono dati derivati: tutto ciò da cui si calcolano sta altrove. Possibilità, dalla
più rapida:

1. **Ripristina `qdrant_data.tgz`** dello snapshot (§6.3, con Qdrant fermo). Mancano i
   documenti indicizzati dopo quella notte: indicizzali di nuovo.
2. **Rigenera** se l'archivio manca o il modello è cambiato:
   - memorie e feedback: il testo è in Postgres — *Impostazioni → Memoria → reindicizza*
     (`POST /api/user-memory/reindex`) e il job di re-embed (`POST /api/admin/vector-db/reembed`,
     docs/EMBEDDING_REEMBED_PLAN.md), che ricalcola i vettori di una collezione esistente dal
     testo conservato con ogni punto;
   - file caricati: indicizzali di nuovo da **File** (gli originali sono in `uploads`);
   - file delle DataSource, testi dei tool RAG, collezioni delle skill: rilancia la loro
     ingestione (il job di re-embed li segnala come "needs re-ingest" quando i punti non
     hanno il testo).

`HOST_BACKUP_QDRANT=off` li lascia fuori dallo snapshot su archivi grandi, accettando il tempo
di reindicizzazione.

## 7. Note

- Il job scrive come root: su una condivisione SMB montata solo per root (`uid=0`, `0700`) è
  l'unico utente che può scriverci. Una destinazione di rete impostata dall'interfaccia non ha
  questo limite.
- `scripts/update.sh` continua a fare uno snapshot prima dell'aggiornamento (nella
  destinazione configurata).
- Log: `backups/backup.log` (snapshot), `backups/scheduler.log` (tick, invio del WAL). Stato locale del job (lock, flag degli
  allarmi): `backups/.state/`.
