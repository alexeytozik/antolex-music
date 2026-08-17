# Single-server production runbook

This runbook deploys ANTOLEX Music to `atozik@193.180.208.19` as one Docker Compose stack behind Caddy at `music.antolex.net`. GitHub Actions creates immutable release directories below `/home/atozik/antolex-music/releases` and changes the `current` symlink only after API, web, and HTTPS health checks pass. It does not create DNS records or R2 buckets.

The server layout is:

```text
/home/atozik/antolex-music/
  current -> releases/<commit>-<run>-<attempt>
  releases/
  shared/.env
  incoming/
```

## Before the maintenance window

1. Point the domain's `A`/`AAAA` records at `193.180.208.19` and allow inbound TCP 80/443 plus UDP 443 for HTTP/3.
2. Install Docker Engine with the Compose plugin, `curl`, `tar`, and `sha256sum`. The `atozik` account must be able to run non-interactive `sudo` for the deployment commands; verify `sudo -n docker compose version` before enabling the workflow.
3. Create the shared production environment and keep it outside every release:

```bash
install -d -m 755 /home/atozik/antolex-music/{releases,incoming}
install -d -m 700 /home/atozik/antolex-music/shared
if [[ ! -e /home/atozik/antolex-music/shared/.env ]]; then
  install -m 600 /dev/null /home/atozik/antolex-music/shared/.env
fi
```

Fill `/home/atozik/antolex-music/shared/.env` from `.env.example`. Explicitly set `APP_ENV=production`, `SESSION_COOKIE_SECURE=true`, `ADMIN_EMAILS=tozikalexey@gmail.com`, `HLS_PLAYBACK_ENABLED=false`, and a random `JWT_SECRET` of at least 32 characters. If the prior release used another JWT secret, put it temporarily in `LEGACY_JWT_SECRET` so old localStorage sessions can exchange once; remove it after the migration window. Set the same strong database credentials in `POSTGRES_*`, `COMPOSE_DATABASE_URL`, and `DATABASE_URL`, URL-encoding special characters. Never paste this file into Actions logs or tickets.

If an existing deployment lives elsewhere, copy its `.env` into `shared/.env`, verify mode `600`, and point `current` at that exact old release before the first workflow deployment. This gives the workflow an automatic application rollback target:

```bash
ln -s /absolute/path/to/existing/antolex-music /home/atozik/antolex-music/current
```

Do not create `current` as a directory; the workflow deliberately refuses to replace a non-symlink path.

4. Add these GitHub Actions repository secrets:

- `DEPLOY_HOST`: `193.180.208.19`
- `DEPLOY_USER`: `atozik`
- `DEPLOY_SSH_KEY`: the dedicated private deployment key
- `DEPLOY_KNOWN_HOSTS`: the server host-key line obtained through a trusted channel and checked against the server fingerprint

Do not build `DEPLOY_KNOWN_HOSTS` blindly during the workflow. Strict host-key checking is intentional, and the workflow never prints any secret value.

5. Create the `antolex-music` R2 bucket and apply CORS only for `https://music.antolex.net`, `http://localhost:5173`, and `http://127.0.0.1:5173`. Allow `GET`, `HEAD`, `PUT`, and expose `ETag` for multipart uploads. Configure `R2_SOURCE_ACCESS_KEY_ID`/`R2_SOURCE_SECRET_ACCESS_KEY` with read-only access to the old bucket and `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` with read/write access only to the new bucket.
6. Use the authenticated Mailjet sender `ANTOLEX Music <auth@antolex.net>`. Keep the Cloudflare SPF, DKIM, ownership, and DMARC TXT records in place; do not fall back to a free-mail `From` address.
7. Keep the old R2 bucket available. Do not enable an object lifecycle deletion rule during migration.
8. Validate an existing release without starting anything:

```bash
cd /home/atozik/antolex-music/current
sudo docker compose \
  --env-file /home/atozik/antolex-music/shared/.env \
  --profile production config --quiet
```

## Legacy migration gate

Generate the full-file legacy manifest, review its JSON duplicate groups, and run the canonical backfill in its default rollback mode:

```bash
ANTOLEX_REPORT_DIR=./migration-reports ./scripts/legacy-r2-hash-report.sh
./scripts/backfill-legacy-sha256.sh
```

The manifest/backfill output is authoritative for legacy content because the six retained duplicate rows intentionally keep `sha256=NULL`. For the current migration it must show 11 manifest rows, 5 canonical contents, and 6 duplicate rows. `scripts/duplicate-report.sh` only reports hashes already stored in PostgreSQL and therefore cannot rediscover those retained NULL rows.

After the counts and canonical assignments are reviewed, apply only the canonical hashes, then preview the R2 copy:

```bash
./scripts/backfill-legacy-sha256.sh --apply
./scripts/r2-migration-dry-run.sh
```

Stop if any count differs or the R2 inventory is unexpected. The hash backfill does not delete or merge anything; exact duplicate deletion and like reassignment remain a separately approved operation.

During the approved maintenance window, perform the local staged copy and the
post-copy SHA-256 verification exactly as documented in
[the R2 migration runbook](r2-migration.md). A direct bucket-to-bucket
`aws s3 sync` cannot use the two bucket-scoped credentials safely.

## Continuous integration and deploy

`.github/workflows/ci-deploy.yml` runs on every pull request and every push to `main`:

- `npm ci`, frontend tests, and the production frontend build;
- `go test ./...` and `go vet ./...`;
- `docker compose --profile production config --quiet`.

A push to `main`, or a manual `workflow_dispatch` explicitly run from `main`, deploys only after all three checks pass. Production deployments are serialized and never cancel an active deployment.

Regular pushes leave `HLS_PLAYBACK_ENABLED` in the shared production environment
unchanged. For a staged manual deployment, select `keep`, `false`, or `true` in
the Actions form. The equivalent CLI command for the initial fallback-only
release is:

```bash
gh workflow run ci-deploy.yml \
  --repo AlexeyTozik/antolex-music \
  --ref main \
  -f hls_playback_enabled=false
```

The workflow validates the value and atomically changes only
`HLS_PLAYBACK_ENABLED` in `shared/.env`, preserving mode `600`, immediately
before the remote Compose build. The `keep` choice performs no environment
write.

The deploy job uses only the system `ssh` and `scp` clients. It verifies the pinned host key, uploads a SHA-256-checked `git archive`, extracts a unique release directory, links the shared `.env`, and validates Compose. If an `antolex-music` PostgreSQL container already exists, deployment stops unless it is running.

The workflow then runs `sudo docker compose --profile production up -d --build --remove-orphans` and waits up to five minutes for all of these checks:

- `http://127.0.0.1:8080/api/v1/health`;
- `http://127.0.0.1:5173/`;
- `https://music.antolex.net/api/v1/health` through local Caddy with certificate verification.

Only then is `current` atomically switched to the new release. On failure it keeps the old symlink and, when an older release is known, attempts to restore that release's Compose stack. Failed release directories remain available for diagnosis.

After a successful deployment, verify the Actions run and then check a sign-in flow on one iPhone and one Android phone: request/resend code, search, like, upload a small file, wait for processing, play with the screen locked, and use headset play/pause/next controls.

## Staged HLS rollout

The HLS transport is deliberately enabled in two releases. Keep
`HLS_PLAYBACK_ENABLED=false` for the first release. Migration `0009` is applied
idempotently by both API and worker under the migration advisory lock, and the
worker then creates bounded-retry `prepare_hls` jobs for the existing ready
library. Users continue to receive the progressive M4A player during this
stage.

Monitor the structured worker errors and run this read-only readiness query
from the active release:

```bash
root=/home/atozik/antolex-music
cd "$root/current"
sudo docker compose \
  --env-file "$root/shared/.env" \
  --profile production exec -T postgres \
  sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT
  (SELECT COUNT(*) FROM library_tracks WHERE status='ready') AS ready_tracks,
  (SELECT COUNT(*)
     FROM library_tracks track
    WHERE track.status='ready'
      AND EXISTS (
        SELECT 1 FROM track_playback_assets asset
         WHERE asset.track_id=track.id
           AND asset.status='ready'
           AND asset.retired_at IS NULL
      )) AS hls_ready,
  (SELECT COUNT(*)
     FROM library_tracks track
    WHERE track.status='ready'
      AND NOT EXISTS (
        SELECT 1 FROM track_playback_assets asset
         WHERE asset.track_id=track.id
           AND asset.status='ready'
           AND asset.retired_at IS NULL
      )) AS hls_missing,
  (SELECT COUNT(*)
     FROM library_tracks track
    WHERE track.status='ready'
      AND NOT EXISTS (
        SELECT 1 FROM track_playback_assets asset
         WHERE asset.track_id=track.id
           AND asset.status='ready'
           AND asset.retired_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM media_jobs job
         WHERE job.track_id=track.id
           AND job.kind='prepare_hls'
           AND job.status='failed'
           AND job.attempts >= 6
      )
      AND NOT EXISTS (
        SELECT 1 FROM media_jobs job
         WHERE job.track_id=track.id
           AND job.kind='prepare_hls'
           AND job.status IN ('pending','running')
      )) AS hls_failed;
SQL
```

Do not enable HLS until `hls_ready = ready_tracks`, `hls_missing = 0`, and
`hls_failed = 0`. Spot-check the generated CMAF objects and a three-track HLS
session, then run the second staged deployment so Vite bakes the flag into the
web image:

```bash
gh workflow run ci-deploy.yml \
  --repo AlexeyTozik/antolex-music \
  --ref main \
  -f hls_playback_enabled=true
```

Validate iOS Safari and Android Chrome with the screen locked before treating
the rollout as complete.

The rollout does not delete progressive M4A objects. Keep them for fallback and
rollback until a separate dry-run lists exact object keys and the owner gives
explicit deletion approval. Migration rollback is not automatic; if an
application rollback is needed after `0009` has run, inspect `prepare_hls` jobs
before starting a worker release that predates that job kind.

## Rollback

The deploy workflow automatically attempts an application rollback if its health gate fails and `current` identifies an older release. For a manual rollback, choose the exact prior directory, switch the symlink atomically, and recreate the Compose services from it:

```bash
root=/home/atozik/antolex-music
previous_release="$root/releases/EXACT_RELEASE_ID"
ln -s "$previous_release" "$root/.current-rollback"
mv -Tf "$root/.current-rollback" "$root/current"
cd "$root/current"
sudo docker compose \
  --env-file "$root/shared/.env" \
  --profile production up -d --build --remove-orphans
curl --fail --silent --show-error https://music.antolex.net/api/v1/health
```

Use an exact, reviewed release path; do not delete or rewrite release directories during rollback. Database rollback is not automatic.

Keep the old bucket read-only for at least seven days after a successful cutover. Its deletion requires a separate explicit confirmation.
