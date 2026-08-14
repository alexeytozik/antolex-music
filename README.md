# ANTOLEX Music

Mobile-first private music library for Safari on iOS 16.4+ and Chrome on Android 10+. The web client uploads audio directly to Cloudflare R2, while the Go API keeps users, metadata, likes, upload sessions, and processing jobs in PostgreSQL.

## How it works

1. The browser calculates a full-file SHA-256 in a Web Worker. The API rejects an exact duplicate before any bytes are uploaded.
2. The browser uploads up to 50 files, one at a time, directly to R2 in resumable 8 MiB multipart chunks. R2 credentials never reach the browser.
   Add shows only active or actionable work: ready/cancelled rows disappear, while errors and duplicates remain until retry or dismissal. Terminal upload metadata and successful jobs are removed after one hour.
3. A PostgreSQL-backed media job verifies the uploaded hash, reads tags and embedded artwork, and produces the single retained audio object: an M4A AAC-LC 256 kbit/s playback file with `faststart`. The temporary uploaded source is deleted after publication.
4. Only `ready` tracks appear in the newest-first catalog and search. Search ranks title, artist, and album matches.
5. Catalog and liked queues fetch 20 tracks at a time and keep extending during playback, while consumed history stays bounded for large libraries.
6. Shuffle walks the complete ready library through a signed server cursor instead of choosing only from tracks already rendered in the browser.
7. The player keeps its queue, position, current track, and shuffle state locally, integrates with Media Session, and automatically resumes the same position after transient network failures.

Exact SHA-256 equality is the only duplicate rule. Similar recordings, remasters, and differently encoded files are allowed.

Embedded cover art is shown unchanged when the audio contains it. If no image is embedded, the API renders a deterministic 512 px ANTOLEX cover from the track title, artist, and album; it does not fetch or invent an official album cover from an external service.

## Repository

```text
apps/web             React, Vite, Tailwind, Zustand
services/api         Go, Fiber, PostgreSQL, Redis, R2
services/api/db      versioned PostgreSQL migrations
scripts              deployment and read-only migration reports
ops                  production and R2 migration runbooks
Caddyfile             TLS entry point for music.antolex.net
```

## Local start

Create the local environment without putting real credentials in Git:

```bash
cp .env.example .env
chmod 600 .env
docker compose up --build
```

Open <http://localhost:5173>. The API health endpoint is <http://localhost:8080/api/v1/health>.

Without SMTP configuration, development authentication codes are written to API logs:

```bash
docker compose logs --tail=50 api
```

Without Docker, start PostgreSQL and Redis from Compose, then run the services directly:

```bash
docker compose up -d postgres redis
set -a; source .env; set +a
(cd services/api && go run ./cmd/api)
(cd apps/web && npm install && npm run dev)
```

## Configuration

The root [`.env.example`](.env.example) documents application, cookie, SMTP, R2, and Caddy values. Production must use:

- a random `JWT_SECRET` of at least 32 bytes;
- `APP_ENV=production` and `SESSION_COOKIE_SECURE=true`;
- `CORS_ORIGINS=https://music.antolex.net`;
- `R2_BUCKET_NAME=antolex-music`;
- a verified SMTP sender such as `auth@antolex.net`.

The six-digit email code expires after 10 minutes. Any valid email address can request a code; the account is created or reactivated only after successful verification. A successful sign-in creates a 30-day `HttpOnly`, `Secure`, `SameSite=Lax` cookie. The header shows direct sign-in/session controls instead of a Profile destination. Signed-in users can browse, like, play, and upload music; likes are isolated by user, while published tracks cannot be edited or deleted through the user-facing API.

## Brand assets

The geometric `A` and waveform use the dark mint palette defined in [the branding notes](ops/branding.md). SVG marks, the wordmark, fallback cover, maskable and monochrome variants, PNG icons at 192/512/1024 px, and the 180 px Apple touch icon live in `apps/web/public`.

Manrope is bundled into the production assets from the local `@fontsource-variable/manrope` package, so the interface never calls a third-party font CDN. The system font stack remains as a no-blocking fallback; see the branding notes.

## Operations

- [Single-server production runbook](ops/production-runbook.md)
- [R2 copy and verification runbook](ops/r2-migration.md)
- `scripts/duplicate-report.sh` previews duplicate groups among hashes already stored in PostgreSQL; NULL legacy rows require the manifest report below. It never updates or deletes data.
- `scripts/legacy-r2-hash-report.sh` streams legacy R2 objects through SHA-256 and writes a local canonical/duplicate report without changing PostgreSQL or R2.
- `scripts/backfill-legacy-sha256.sh` validates that manifest and, only with explicit `--apply`, stores each hash on its earliest canonical row. Legacy duplicate rows and their likes remain untouched, while future uploads of the same bytes can return `409 duplicate_track`.
- `scripts/r2-migration-dry-run.sh` reads each bucket with its own credential, compares inventories, and derives a write-free copy preview; optional full verification downloads both copies and compares SHA-256.

## Verification

```bash
(cd services/api && go test ./...)
(cd apps/web && npm run build && npm run test)
bash -n scripts/*.sh
```

Production migration is intentionally separate from local implementation. Creating or deleting buckets, copying objects, renaming the GitHub repository, changing DNS, and switching production all require an explicit maintenance decision; none of the repository scripts performs those actions automatically.
