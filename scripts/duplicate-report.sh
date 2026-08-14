#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null || {
    printf 'psql is required when DATABASE_URL is set.\n' >&2
    exit 1
  }
  psql_command=(psql --dbname="${DATABASE_URL}" --no-psqlrc --set=ON_ERROR_STOP=1 --pset=pager=off)
else
  command -v docker >/dev/null || {
    printf 'Set DATABASE_URL or install Docker.\n' >&2
    exit 1
  }
  # The inner container shell, not this host shell, expands PostgreSQL env vars.
  # shellcheck disable=SC2016
  psql_command=(
    docker compose -f "${repo_root}/docker-compose.yml" exec -T postgres
    sh -c 'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "$@"' sh
    --no-psqlrc --set=ON_ERROR_STOP=1 --pset=pager=off
  )
fi

has_sha256="$("${psql_command[@]}" --tuples-only --no-align --command="
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'library_tracks'
      AND column_name = 'sha256'
  );
")"

if [[ "${has_sha256}" != "t" ]]; then
  printf 'library_tracks.sha256 does not exist yet; run migrations first. No data was changed.\n' >&2
  exit 1
fi

"${psql_command[@]}" <<'SQL'
\echo 'ANTOLEX Music duplicate migration preview (read-only)'
\echo ''
\echo 'Summary:'
WITH totals AS (
  SELECT
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (WHERE sha256 IS NOT NULL AND btrim(sha256) <> '') AS hashed_rows,
    COUNT(*) FILTER (WHERE sha256 IS NULL OR btrim(sha256) = '') AS missing_sha256,
    COUNT(DISTINCT btrim(sha256)) FILTER (WHERE sha256 IS NOT NULL AND btrim(sha256) <> '') AS distinct_hashes
  FROM library_tracks
)
SELECT
  total_rows,
  hashed_rows,
  missing_sha256 AS unresolved_rows_without_sha256,
  distinct_hashes AS distinct_enforced_hashes,
  hashed_rows - distinct_hashes AS duplicate_rows_visible_in_database
FROM totals;

\echo 'Rows with NULL SHA-256 cannot be grouped by this database-only report.'
\echo 'After canonical-only legacy backfill, retained duplicate rows stay NULL by design.'
\echo 'Use legacy-r2-duplicates-*.json and backfill-legacy-sha256.sh dry-run for authoritative legacy counts.'

\echo ''
\echo 'Duplicate groups; keep_id is the earliest row and remove_ids are preview only:'
WITH ranked AS (
  SELECT
    id,
    external_track_id,
    btrim(sha256) AS sha256,
    created_at,
    ROW_NUMBER() OVER (PARTITION BY btrim(sha256) ORDER BY created_at, id) AS duplicate_rank
  FROM library_tracks
  WHERE sha256 IS NOT NULL AND btrim(sha256) <> ''
), grouped AS (
  SELECT
    sha256,
    COUNT(*) AS copies,
    (ARRAY_AGG(id ORDER BY created_at, id))[1] AS keep_id,
    STRING_AGG(id::text, ', ' ORDER BY created_at, id)
      FILTER (WHERE duplicate_rank > 1) AS remove_ids,
    STRING_AGG(external_track_id, ', ' ORDER BY created_at, id) AS external_track_ids
  FROM ranked
  GROUP BY sha256
  HAVING COUNT(*) > 1
)
SELECT sha256, copies, keep_id, remove_ids, external_track_ids
FROM grouped
ORDER BY copies DESC, sha256;

\echo ''
\echo 'Rows without SHA-256 (unresolved or deliberately retained legacy duplicates):'
SELECT id, external_track_id, original_object_key, created_at
FROM library_tracks
WHERE sha256 IS NULL OR btrim(sha256) = ''
ORDER BY created_at, id;

\echo ''
\echo 'No UPDATE or DELETE statements were executed.'
SQL
