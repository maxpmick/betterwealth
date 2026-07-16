# Bare-metal self-hosting runbook

This runbook deploys BetterWealth as two unprivileged, loopback-only Bun services behind Caddy. It assumes a current Linux distribution with systemd, a dedicated hostname, and DNS already pointing at the server.

The supplied units use these fixed locations:

| Purpose | Path |
| --- | --- |
| Application checkout | `/opt/betterwealth` |
| Runtime environment | `/etc/betterwealth.env` |
| SQLite database | `/opt/betterwealth/data/betterwealth.sqlite` |
| Managed backups | `/opt/betterwealth/backups` |
| API / web listeners | `127.0.0.1:3001` / `127.0.0.1:4173` |

Do not expose either Bun listener to the network. Only ports 80 and 443 should be public.

## 1. Host and runtime

Install Caddy, `curl`, Git, and the Bun version in the root `package.json`. Copy the self-contained Bun binary to the path used by systemd; do not point the units into an administrator's home directory because `ProtectHome=true` intentionally blocks it.

```bash
bun --version
sudo install -o root -g root -m 0755 "$(command -v bun)" /usr/local/bin/bun
/usr/local/bin/bun --version

sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin betterwealth
sudo install -d -o betterwealth -g betterwealth -m 0700 \
  /opt/betterwealth/data /opt/betterwealth/backups
```

Place the release checkout at `/opt/betterwealth`. Code may be owned by the deployment operator, but it must not be writable by `betterwealth`. Make it readable by the service group after every update:

```bash
cd /opt/betterwealth
bun install --frozen-lockfile
bun run test
bun run build
sudo chgrp -R betterwealth /opt/betterwealth
sudo chmod -R g+rX,o-rwx /opt/betterwealth
sudo chown -R betterwealth:betterwealth /opt/betterwealth/data /opt/betterwealth/backups
sudo chmod 0700 /opt/betterwealth/data /opt/betterwealth/backups
```

Run the complete `bun run test:all` release gate in CI or on a build host with Playwright's browser dependencies. `bun run test` plus `bun run build` is the minimum on-host artifact check, not a substitute for the full gate.

## 2. Production environment

Start from `.env.example`, then edit the installed copy without putting secrets in the checkout:

```bash
sudo install -o root -g root -m 0600 .env.example /etc/betterwealth.env
sudoedit /etc/betterwealth.env
```

At minimum, change these values:

```dotenv
APP_ENV=production
API_HOST=127.0.0.1
API_PORT=3001
WEB_ORIGIN=https://finance.example.com
DATABASE_URL=./data/betterwealth.sqlite
ENCRYPTION_KEY=<64 hexadecimal characters from openssl rand -hex 32>
COOKIE_SECURE=true
TRUST_PROXY=true
REGISTRATION_MODE=closed
```

`WEB_ORIGIN` is one exact origin: HTTPS, hostname, optional non-default port, and no trailing slash. `TRUST_PROXY=true` is safe only while the API listener remains loopback-only behind the supplied Caddy proxy; it allows rate limits and session metadata to use Caddy's validated client address. Leave it false if clients can reach Bun directly. The supplied web server and proxy assume API port 3001. Changing it requires changing both proxy configurations.

Back up `ENCRYPTION_KEY` in a password manager separately from every database backup. A database without its original encryption key cannot recover provider credentials. The database and key stored together defeat field-level encryption.

Production must not contain `/opt/betterwealth/.env.local`; process environment from systemd has final precedence, but a second secret source makes audits and rotations ambiguous. Validate the finished host without printing values:

```bash
cd /opt/betterwealth
sudo bash deploy/preflight.sh /etc/betterwealth.env
```

Preflight also requires `TRUST_PROXY=true` for the supplied loopback Caddy topology, validates the backup-retention range, resolves `DATABASE_URL` before confirming it stays inside the sandboxed data directory, and rejects origins with credentials or URL suffixes.

## 3. Bootstrap once

Bootstrap can create the owner, store the AI configuration with field-level encryption, claim a one-time SimpleFIN setup token, and perform the first sync. Put only the bootstrap inputs you intend to use in `/etc/betterwealth.env`, then run the isolated one-shot unit:

```bash
sudo install -o root -g root -m 0644 \
  deploy/betterwealth-bootstrap.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start betterwealth-bootstrap.service
sudo journalctl -u betterwealth-bootstrap.service --no-pager -n 100
```

Do not rerun a consumed SimpleFIN setup token. Bootstrap stores the resulting access URL so a later run can retry sync without reclaiming the token.

Immediately clear `BOOTSTRAP_USER_PASSWORD`, `BOOTSTRAP_SIMPLEFIN_SETUP_TOKEN`, and `BOOTSTRAP_OPENROUTER_API_KEY` from `/etc/betterwealth.env`. The long-running API and backup units explicitly unset these variables as defense in depth. Keep registration closed unless you intentionally invite another user.

### Lost-password recovery

BetterWealth intentionally has no email reset flow until an email delivery provider is configured. A host operator can reset one known account locally. The command prompts twice with terminal echo disabled, hashes with the same production Argon2id parameters as registration, revokes every session and personal access token for that user, and writes a system audit event in each of the user's households. It never prints or accepts the password as a command-line argument.

Run it through a transient systemd service as `betterwealth`. The recovery command needs only database access; it does not load the encryption key or provider secrets:

```bash
sudo systemd-run --quiet --wait --collect --pty \
  --unit=betterwealth-password-recovery \
  --uid=betterwealth --gid=betterwealth \
  --working-directory=/opt/betterwealth \
  --property=UMask=0077 \
  /usr/local/bin/bun run auth:reset-password -- --email user@example.com
```

If `DATABASE_URL` is not the default `./data/betterwealth.sqlite`, append `--database /absolute/path/to/betterwealth.sqlite`.

Log in with the new password after completion; every previous browser and API token must authenticate again. If no TTY is available, the command accepts matching transient `BETTERWEALTH_NEW_PASSWORD` and `BETTERWEALTH_NEW_PASSWORD_CONFIRM` environment variables. Do not put them in `/etc/betterwealth.env`, shell history, a unit file, or the command line. Inject them through your secret runner for only this process and unset them immediately afterward.

## 4. Install services and TLS proxy

Install the API, web, backup, and local health units:

```bash
sudo install -o root -g root -m 0644 \
  deploy/betterwealth-api.service \
  deploy/betterwealth-web.service \
  deploy/betterwealth-backup.service \
  deploy/betterwealth-backup.timer \
  deploy/betterwealth-healthcheck.service \
  deploy/betterwealth-healthcheck.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now betterwealth-api.service betterwealth-web.service
sudo systemctl enable --now betterwealth-backup.timer betterwealth-healthcheck.timer
```

The API unit runs idempotent migrations before every start and fails its start if local readiness is not reached. The web unit starts after the API. Both run with an empty capability set, a read-only filesystem sandbox, private temporary/device namespaces, and access only to the required address families. Bun's JIT means `MemoryDenyWriteExecute=true` is intentionally not used.

Copy the Caddy example, replace `finance.example.com` with the exact public hostname used by `WEB_ORIGIN`, and validate before reload:

```bash
sudo install -o root -g root -m 0644 deploy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo install -d -o caddy -g caddy -m 0750 /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy terminates TLS, sends `/api/*` and `/health` directly to the API, and sends all other paths to the web process. It rotates JSON access logs at 25 MiB, retaining ten files for at most 30 days. Access logs still contain request path and query metadata; keep `/var/log/caddy` restricted and do not send it to third-party analytics.

Validate both loopback services and the public edge:

```bash
cd /opt/betterwealth
sudo -u betterwealth bash deploy/healthcheck.sh --all
curl --fail --silent --show-error https://finance.example.com/health
curl --fail --silent --show-error --output /dev/null https://finance.example.com/
```

Use an external HTTPS monitor for real alerting. The five-minute local timer records failures in the journal but cannot report a total host, DNS, ISP, or Caddy outage from outside the machine.

## 5. Backups

The live database runs in WAL mode. Never back up its main `.sqlite` file with plain `cp`, `rsync`, or a filesystem watcher: recent committed pages may still be in the WAL. The application backup command uses SQLite's online `VACUUM INTO` snapshot mechanism, verifies the copy, forces standalone DELETE journaling, writes it atomically with mode 0600, and prunes managed files according to `BACKUP_RETENTION_DAYS`. Temporary databases and every WAL, SHM, or rollback-journal sidecar are removed on both success and failure.

The scheduled unit then reopens the finished file read-only and runs `PRAGMA quick_check`, `PRAGMA foreign_key_check`, header/size/schema/journal-mode checks, and rejects a backup that depends on adjacent WAL/SHM files:

```bash
sudo systemctl start betterwealth-backup.service
sudo journalctl -u betterwealth-backup.service --no-pager -n 50
sudo -u betterwealth /usr/local/bin/bun run --cwd /opt/betterwealth ops:verify-backup
```

Run the slower full integrity check periodically or before a restore:

```bash
sudo -u betterwealth /usr/local/bin/bun \
  /opt/betterwealth/deploy/verify-backup.ts --full \
  /opt/betterwealth/backups/betterwealth-YYYY-MM-DDTHH-MM-SS.sqlite
```

Local retention does not protect against disk loss, theft, or ransomware. After local verification, copy the standalone DELETE-journal backup file (no `-wal` or `-shm` companion is required) to encrypted off-host storage with a tool such as restic or borg. Keep at least one versioned, immutable/offline copy. Monitor the timer and backup age:

```bash
systemctl list-timers betterwealth-backup.timer
systemctl status betterwealth-backup.service
find /opt/betterwealth/backups -maxdepth 1 -name 'betterwealth-*.sqlite' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort
```

## 6. Restore drill

Practice this procedure on a disposable host before relying on it. A restore is an operator action and is deliberately not exposed as a browser upload.

1. Confirm the encryption key in `/etc/betterwealth.env` belongs to the selected backup.
2. Run the full verification command above.
3. Stop both application services.
4. Preserve the entire current SQLite file set, including WAL/SHM, before installing the snapshot.
5. Start the API (which applies forward migrations), then the web process, and verify login, balances, recent transactions, and one report.

```bash
sudo systemctl stop betterwealth-web.service betterwealth-api.service
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o betterwealth -g betterwealth -m 0700 \
  "/opt/betterwealth/backups/pre-restore-$stamp"
sudo find /opt/betterwealth/data -maxdepth 1 \
  \( -name 'betterwealth.sqlite' -o -name 'betterwealth.sqlite-wal' -o -name 'betterwealth.sqlite-shm' \) \
  -exec mv -t "/opt/betterwealth/backups/pre-restore-$stamp" {} +
sudo install -o betterwealth -g betterwealth -m 0600 \
  /path/to/verified-backup.sqlite /opt/betterwealth/data/betterwealth.sqlite
sudo systemctl start betterwealth-api.service betterwealth-web.service
sudo -u betterwealth bash /opt/betterwealth/deploy/healthcheck.sh --all
```

Do not leave an old `betterwealth.sqlite-wal` beside a restored main database. Preserving the old set in its own directory avoids accidentally replaying pages from a different database generation.

## 7. Updates and rollback

Use a tagged commit or recorded commit SHA. Before every update, create and verify a backup. To avoid serving HTML that points to half-replaced hashed assets, stop the services during an in-place build:

```bash
sudo systemctl start betterwealth-backup.service
sudo systemctl is-failed --quiet betterwealth-backup.service && exit 1
sudo systemctl stop betterwealth-web.service betterwealth-api.service

cd /opt/betterwealth
git fetch --tags --prune
git checkout <reviewed-tag-or-commit>
bun install --frozen-lockfile
bun run test
bun run build
sudo chgrp -R betterwealth /opt/betterwealth
sudo chmod -R g+rX,o-rwx /opt/betterwealth
sudo chown -R betterwealth:betterwealth data backups
sudo chmod 0700 data backups

sudo systemctl start betterwealth-api.service betterwealth-web.service
sudo -u betterwealth bash deploy/healthcheck.sh --all
```

The API service applies forward migrations. A code-only rollback after a migration may be unsafe; restore the pre-update backup and matching encryption key when schema compatibility is uncertain.

## 8. Logs and incident checks

Application logs go to journald and intentionally avoid secrets and financial payloads. Configure journald retention at the host level, because its quota is shared with other services. For example, a root-owned `/etc/systemd/journald.conf.d/retention.conf` can set `SystemMaxUse=1G`, `MaxRetentionSec=30day`, and `Compress=yes`; choose limits appropriate for the whole host.

```bash
journalctl -u betterwealth-api.service -u betterwealth-web.service --since today
journalctl -u betterwealth-backup.service -u betterwealth-healthcheck.service --since '7 days ago'
systemctl status betterwealth-api.service betterwealth-web.service
ss -ltnp | grep -E ':(3001|4173)[[:space:]]'
```

Expected listener addresses are only `127.0.0.1:3001` and `127.0.0.1:4173`. If a provider credential may have leaked, rotate/revoke it at the provider, update the encrypted integration, invalidate active sessions, and create a fresh verified backup after the incident is contained.
