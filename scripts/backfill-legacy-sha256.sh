#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/backfill-legacy-sha256.sh [--manifest PATH] [--dry-run | --apply]

Stages a legacy R2 SHA-256 manifest and assigns each hash only to the earliest
library_tracks row (ordered by created_at, id). The default is a transactional
dry-run that rolls back every UPDATE.

Options:
  --manifest PATH  Use this manifest instead of the newest generated manifest.
  --dry-run        Validate and roll back (default; overrides the environment).
  --apply          Commit the canonical-only SHA-256 updates.
  -h, --help       Show this help.

Environment:
  ANTOLEX_HASH_MANIFEST=PATH          Alternative way to choose the manifest.
  ANTOLEX_REPORT_DIR=PATH             Directory searched for the newest manifest.
  ANTOLEX_APPLY_LEGACY_HASHES=yes     Alternative explicit opt-in to --apply.
  DATABASE_URL=...                    Use psql directly; otherwise Docker Compose.

This script never deletes tracks, likes, or R2 objects.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
report_dir="${ANTOLEX_REPORT_DIR:-${repo_root}/migration-reports}"
manifest_path="${ANTOLEX_HASH_MANIFEST:-}"
cli_mode=""

while (($# > 0)); do
  case "$1" in
    --manifest)
      if (($# < 2)); then
        printf '%s\n' '--manifest requires a path.' >&2
        exit 2
      fi
      if [[ -z "$2" ]]; then
        printf '%s\n' '--manifest path cannot be empty.' >&2
        exit 2
      fi
      manifest_path="$2"
      shift 2
      ;;
    --manifest=*)
      manifest_path="${1#*=}"
      if [[ -z "${manifest_path}" ]]; then
        printf '%s\n' '--manifest path cannot be empty.' >&2
        exit 2
      fi
      shift
      ;;
    --dry-run)
      if [[ -n "${cli_mode}" && "${cli_mode}" != "dry-run" ]]; then
        printf '%s\n' '--dry-run and --apply cannot be used together.' >&2
        exit 2
      fi
      cli_mode="dry-run"
      shift
      ;;
    --apply)
      if [[ -n "${cli_mode}" && "${cli_mode}" != "apply" ]]; then
        printf '%s\n' '--dry-run and --apply cannot be used together.' >&2
        exit 2
      fi
      cli_mode="apply"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "${manifest_path}" ]]; then
        printf 'Unexpected argument: %s\n' "$1" >&2
        usage >&2
        exit 2
      fi
      manifest_path="$1"
      shift
      ;;
  esac
done

apply_env="${ANTOLEX_APPLY_LEGACY_HASHES:-}"
case "${apply_env}" in
  ""|no) ;;
  yes) ;;
  *)
    printf 'ANTOLEX_APPLY_LEGACY_HASHES must be exactly "yes", "no", or unset.\n' >&2
    exit 2
    ;;
esac

if [[ "${cli_mode}" == "apply" ]] || [[ -z "${cli_mode}" && "${apply_env}" == "yes" ]]; then
  run_mode="apply"
else
  run_mode="dry-run"
fi

if [[ -z "${manifest_path}" ]]; then
  shopt -s nullglob
  manifest_candidates=("${report_dir}"/legacy-r2-sha256-*.tsv)
  shopt -u nullglob
  if ((${#manifest_candidates[@]} == 0)); then
    printf 'No legacy SHA-256 manifests found in %s.\n' "${report_dir}" >&2
    printf 'Run scripts/legacy-r2-hash-report.sh first or pass --manifest PATH.\n' >&2
    exit 1
  fi
  manifest_path="${manifest_candidates[${#manifest_candidates[@]} - 1]}"
fi

if [[ ! -f "${manifest_path}" || ! -r "${manifest_path}" ]]; then
  printf 'Manifest is not a readable file: %s\n' "${manifest_path}" >&2
  exit 1
fi

command -v awk >/dev/null || {
  printf 'awk is required.\n' >&2
  exit 1
}

# Validate the transport format before COPY. PostgreSQL repeats these checks and
# also verifies every manifest identity field against the live database row.
awk -F '\t' '
  NF != 5 {
    printf "Invalid manifest line %d: expected 5 tab-separated fields, got %d.\n", NR, NF > "/dev/stderr"
    invalid = 1
    next
  }
  length($1) != 64 || $1 !~ /^[0-9a-f]+$/ {
    printf "Invalid SHA-256 at manifest line %d.\n", NR > "/dev/stderr"
    invalid = 1
  }
  length($2) != 36 || tolower($2) !~ /^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/ ||
    substr($2, 9, 1) != "-" || substr($2, 14, 1) != "-" ||
    substr($2, 19, 1) != "-" || substr($2, 24, 1) != "-" {
    printf "Invalid UUID at manifest line %d.\n", NR > "/dev/stderr"
    invalid = 1
  }
  $3 == "" || $4 == "" || $5 == "" {
    printf "Empty identity field at manifest line %d.\n", NR > "/dev/stderr"
    invalid = 1
  }
  index($0, sprintf("%c", 1)) != 0 {
    printf "Unsupported control byte at manifest line %d.\n", NR > "/dev/stderr"
    invalid = 1
  }
  END {
    if (NR == 0) {
      print "Manifest is empty." > "/dev/stderr"
      invalid = 1
    }
    exit invalid
  }
' "${manifest_path}"

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

printf 'Manifest: %s\n' "${manifest_path}"
if [[ "${run_mode}" == "apply" ]]; then
  printf 'Mode: APPLY (canonical SHA-256 updates will be committed).\n'
else
  printf 'Mode: DRY RUN (the validation UPDATE will be rolled back).\n'
fi

emit_migration_sql() {
  cat <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('antolex-music:legacy-sha256-canonical-backfill'));
LOCK TABLE library_tracks IN SHARE ROW EXCLUSIVE MODE;

DO $validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'library_tracks'
      AND column_name = 'sha256'
  ) THEN
    RAISE EXCEPTION 'library_tracks.sha256 is missing; run migrations first';
  END IF;
END
$validation$;

CREATE TEMP TABLE legacy_hash_manifest_stage (
  sha256 TEXT NOT NULL,
  track_id UUID NOT NULL,
  external_track_id TEXT NOT NULL,
  manifest_created_at TIMESTAMPTZ NOT NULL,
  object_key TEXT NOT NULL
) ON COMMIT DROP;

\copy legacy_hash_manifest_stage (sha256, track_id, external_track_id, manifest_created_at, object_key) FROM STDIN WITH (FORMAT csv, DELIMITER E'\t', QUOTE E'\x01', ESCAPE E'\x01')
SQL
  cat -- "${manifest_path}"
  printf '\\.\n'
  cat <<'SQL'

DO $validation$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_hash_manifest_stage) THEN
    RAISE EXCEPTION 'manifest is empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_hash_manifest_stage
    WHERE sha256 !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'manifest contains an invalid SHA-256';
  END IF;

  IF EXISTS (
    SELECT track_id
    FROM legacy_hash_manifest_stage
    GROUP BY track_id
    HAVING COUNT(DISTINCT sha256) > 1
  ) THEN
    RAISE EXCEPTION 'one track ID maps to conflicting SHA-256 values';
  END IF;

  IF EXISTS (
    SELECT track_id
    FROM legacy_hash_manifest_stage
    GROUP BY track_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'manifest repeats a track ID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_hash_manifest_stage manifest
    LEFT JOIN library_tracks track ON track.id = manifest.track_id
    WHERE track.id IS NULL
  ) THEN
    RAISE EXCEPTION 'manifest references a track ID that is absent from library_tracks';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_hash_manifest_stage manifest
    JOIN library_tracks track ON track.id = manifest.track_id
    WHERE track.external_track_id IS DISTINCT FROM manifest.external_track_id
       OR COALESCE(track.original_object_key, track.object_key) IS DISTINCT FROM manifest.object_key
       OR track.created_at IS DISTINCT FROM manifest.manifest_created_at
  ) THEN
    RAISE EXCEPTION 'manifest identity conflicts with the current database (external ID, object key, or created_at)';
  END IF;
END
$validation$;

CREATE TEMP TABLE legacy_hash_ranked ON COMMIT DROP AS
SELECT
  manifest.*,
  ROW_NUMBER() OVER (
    PARTITION BY manifest.sha256
    ORDER BY manifest.manifest_created_at, manifest.track_id
  ) AS hash_rank,
  COUNT(*) OVER (PARTITION BY manifest.sha256) AS hash_copies
FROM legacy_hash_manifest_stage manifest;

CREATE TEMP TABLE legacy_hash_canonical ON COMMIT DROP AS
SELECT
  ranked.sha256,
  ranked.track_id,
  ranked.manifest_created_at,
  ranked.hash_copies,
  track.sha256 AS previous_sha256
FROM legacy_hash_ranked ranked
JOIN library_tracks track ON track.id = ranked.track_id
WHERE ranked.hash_rank = 1;

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM legacy_hash_canonical canonical
    WHERE canonical.previous_sha256 IS NOT NULL
      AND canonical.previous_sha256 <> canonical.sha256
  ) THEN
    RAISE EXCEPTION 'a canonical row already has a conflicting SHA-256';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_hash_ranked ranked
    JOIN library_tracks track ON track.id = ranked.track_id
    WHERE ranked.hash_rank > 1
      AND track.sha256 IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a non-canonical duplicate row already has SHA-256; refusing to move or clear it';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_hash_canonical canonical
    JOIN library_tracks current_owner ON current_owner.sha256 = canonical.sha256
    WHERE current_owner.id <> canonical.track_id
  ) THEN
    RAISE EXCEPTION 'a canonical SHA-256 is already owned by another database row';
  END IF;
END
$validation$;

\echo ''
\echo 'Validated legacy hash manifest:'
SELECT
  COUNT(*) AS manifest_rows,
  COUNT(DISTINCT sha256) AS canonical_rows,
  COUNT(*) - COUNT(DISTINCT sha256) AS duplicate_rows_left_unhashed
FROM legacy_hash_manifest_stage;

SELECT
  COUNT(*) FILTER (WHERE previous_sha256 IS NULL) AS canonical_rows_to_update,
  COUNT(*) FILTER (WHERE previous_sha256 = sha256) AS canonical_rows_already_backfilled
FROM legacy_hash_canonical;

\echo ''
\echo 'Canonical assignments (earliest created_at, id per SHA-256):'
SELECT sha256, track_id, manifest_created_at, hash_copies
FROM legacy_hash_canonical
ORDER BY manifest_created_at, track_id;

CREATE TEMP TABLE legacy_hash_applied ON COMMIT DROP AS
WITH changed AS (
  UPDATE library_tracks track
  SET sha256 = canonical.sha256
  FROM legacy_hash_canonical canonical
  WHERE track.id = canonical.track_id
    AND track.sha256 IS NULL
  RETURNING track.id, track.sha256
)
SELECT id, sha256 FROM changed;

DO $verification$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM legacy_hash_canonical canonical
    JOIN library_tracks track ON track.id = canonical.track_id
    WHERE track.sha256 IS DISTINCT FROM canonical.sha256
  ) THEN
    RAISE EXCEPTION 'post-update verification failed for a canonical row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_hash_ranked ranked
    JOIN library_tracks track ON track.id = ranked.track_id
    WHERE ranked.hash_rank > 1
      AND track.sha256 IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'post-update verification found SHA-256 on a non-canonical duplicate row';
  END IF;
END
$verification$;

SELECT COUNT(*) AS canonical_rows_updated_this_run
FROM legacy_hash_applied;
SQL

  if [[ "${run_mode}" == "apply" ]]; then
    printf 'COMMIT;\n'
  else
    printf 'ROLLBACK;\n'
  fi
}

emit_migration_sql | "${psql_command[@]}"

if [[ "${run_mode}" == "apply" ]]; then
  printf 'Committed canonical-only SHA-256 backfill. No tracks, likes, or R2 objects were deleted.\n'
else
  printf 'Dry-run complete. The transaction was rolled back; no database data changed.\n'
fi
