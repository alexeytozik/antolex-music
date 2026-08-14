#!/usr/bin/env bash
set -euo pipefail

umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
backup_dir="${ANTOLEX_BACKUP_DIR:-${repo_root}/backups/postgres}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="${backup_dir}/antolex-music-${timestamp}.dump"
partial_path="${backup_path}.partial"

mkdir -p "${backup_dir}"

if [[ -e "${backup_path}" || -e "${partial_path}" ]]; then
  printf 'Refusing to overwrite an existing backup: %s\n' "${backup_path}" >&2
  exit 1
fi

cleanup_partial() {
  if [[ -f "${partial_path}" ]]; then
    rm -f -- "${partial_path}"
  fi
}
trap cleanup_partial EXIT

if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v pg_dump >/dev/null || {
    printf 'pg_dump is required when DATABASE_URL is set.\n' >&2
    exit 1
  }
  pg_dump \
    --dbname="${DATABASE_URL}" \
    --format=custom \
    --no-owner \
    --no-acl \
    --file="${partial_path}"

  command -v pg_restore >/dev/null || {
    printf 'pg_restore is required to validate the backup.\n' >&2
    exit 1
  }
  pg_restore --list "${partial_path}" >/dev/null
else
  command -v docker >/dev/null || {
    printf 'Set DATABASE_URL or install Docker.\n' >&2
    exit 1
  }
  docker compose -f "${repo_root}/docker-compose.yml" exec -T postgres \
    sh -c 'pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
    >"${partial_path}"
  docker compose -f "${repo_root}/docker-compose.yml" exec -T postgres \
    pg_restore --list <"${partial_path}" >/dev/null
fi

if [[ ! -s "${partial_path}" ]]; then
  printf 'Backup is empty; leaving the destination untouched.\n' >&2
  exit 1
fi

mv -- "${partial_path}" "${backup_path}"
trap - EXIT

if command -v sha256sum >/dev/null; then
  (
    cd "${backup_dir}"
    sha256sum "$(basename "${backup_path}")" >"$(basename "${backup_path}.sha256")"
  )
else
  (
    cd "${backup_dir}"
    shasum -a 256 "$(basename "${backup_path}")" >"$(basename "${backup_path}.sha256")"
  )
fi

printf 'Backup created and validated: %s\n' "${backup_path}"
printf 'No old backups were removed.\n'
