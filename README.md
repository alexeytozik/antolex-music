# Tozikron Music

Minimal monorepo for a web-based music library that stores audio in Cloudflare R2, keeps track metadata in PostgreSQL, caches paged library search in Redis, and authenticates users by email confirmation code.

## Structure

```text
apps/web         React + Vite + Tailwind + Zustand
services/api     Go + Fiber + PostgreSQL + Redis
```

## Architecture

1. The web client sends profile auth, paged library search, liked-song, and upload requests to the Go API.
2. The Go API stores users, library metadata, and liked tracks in PostgreSQL and caches paged search responses in Redis.
3. Audio files are uploaded to Cloudflare R2, and the API signs direct playback URLs from R2.
4. While the catalog is being read, the API quietly reconciles local metadata with R2 so direct bucket changes show up without rebuilds or a manual sync button.
5. The frontend plays the returned `stream_url` directly in an `<audio>` element, keeping streaming off the application servers.

## Authentication

- Users sign in with email only. The Go API sends a 6-digit confirmation code and exchanges it for a JWT session valid for 30 days.
- In local development, if SMTP is not configured, the API logs the code to stdout so the flow can still be tested.
- Docker Compose reads SMTP settings from the repository-root `.env` file and passes them into the `api` container.

## Error Contract

The Go API returns structured JSON errors:

```json
{
  "error": {
    "code": "stream_url_missing",
    "message": "Resolved track is missing a playable stream URL",
    "details": {
      "external_id": "track-123"
    }
  }
}
```

The frontend API client parses this envelope and throws a typed `APIError`, so playback and search UIs can surface clean messages without guessing from plain-text responses.

## Quick Start

1. Start the full stack with Docker Compose:

```bash
docker compose up --build
```

## Mailjet SMTP

1. In Mailjet, verify a sender on your own domain such as `auth@tozikron.com` and complete the DNS records they provide for domain authentication.
2. Create a repository-root `.env` file from `.env.example`.
3. Fill in the Mailjet SMTP values:

```text
SMTP_HOST=in-v3.mailjet.com
SMTP_PORT=587
SMTP_USERNAME=<your Mailjet API key>
SMTP_PASSWORD=<your Mailjet secret key>
SMTP_FROM=auth@tozikron.com
```

4. Rebuild the stack:

```bash
docker compose up -d --build
```

5. Request a sign-in code and check the recipient inbox. If Mailjet domain verification is incomplete, delivery will fail or land in spam.

## Notes

- `Search` and `Liked Songs` are paged at 10 tracks per request and sorted alphabetically on the server.
- Direct uploads from the UI appear immediately because the API writes metadata as soon as the R2 upload succeeds.
- Manual object changes inside the `library/` prefix in R2 are reconciled automatically while the catalog is being read.
- PostgreSQL schema is applied automatically by the `postgres` container on first startup via `docker-entrypoint-initdb.d`.

## Local Development Without Docker

1. Start infrastructure only:

```bash
docker compose up -d postgres redis
```

2. Start the Go API:

```bash
cd services/api
go run ./cmd/api
```

3. Start the web app:

```bash
cd apps/web
npm install
npm run dev
```

4. Request a sign-in code:

```bash
curl -X POST http://localhost:8080/api/v1/auth/request-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
```

If SMTP is not configured in development, read the API logs to get the code:

```bash
docker compose logs api
```

## Verification

```bash
cd services/api && go test ./...
cd apps/web && npm run build && npm run test
```
