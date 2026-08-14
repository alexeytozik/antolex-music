#!/usr/bin/env bash
set -euo pipefail

command -v aws >/dev/null || {
  printf 'AWS CLI v2 is required.\n' >&2
  exit 1
}
command -v jq >/dev/null || {
  printf 'jq is required.\n' >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
account_id="${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID}"
bucket_name="${R2_SOURCE_BUCKET_NAME:-${R2_BUCKET_NAME:?Set R2_SOURCE_BUCKET_NAME or R2_BUCKET_NAME}}"
endpoint="${R2_ENDPOINT:-https://${account_id}.r2.cloudflarestorage.com}"
report_dir="${ANTOLEX_REPORT_DIR:-${repo_root}/migration-reports}"
report_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
manifest_path="${report_dir}/legacy-r2-sha256-${report_stamp}.tsv"
duplicates_path="${report_dir}/legacy-r2-duplicates-${report_stamp}.json"

if [[ -n "${R2_SOURCE_ACCESS_KEY_ID:-}" || -n "${R2_SOURCE_SECRET_ACCESS_KEY:-}" ]]; then
  export AWS_ACCESS_KEY_ID="${R2_SOURCE_ACCESS_KEY_ID:?Set both R2_SOURCE_ACCESS_KEY_ID and R2_SOURCE_SECRET_ACCESS_KEY}"
  export AWS_SECRET_ACCESS_KEY="${R2_SOURCE_SECRET_ACCESS_KEY:?Set both R2_SOURCE_ACCESS_KEY_ID and R2_SOURCE_SECRET_ACCESS_KEY}"
else
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?Set R2_SOURCE_ACCESS_KEY_ID or fallback R2_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?Set R2_SOURCE_SECRET_ACCESS_KEY or fallback R2_SECRET_ACCESS_KEY}"
  printf 'Warning: source credentials are unset; using target credentials to hash the source bucket.\n' >&2
fi
export AWS_SESSION_TOKEN=""
export AWS_DEFAULT_REGION=auto
export AWS_REGION=auto
export AWS_PAGER=""

if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null || {
    printf 'psql is required when DATABASE_URL is set.\n' >&2
    exit 1
  }
  psql_command=(psql --dbname="${DATABASE_URL}" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=$'\t')
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
    --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator=$'\t'
  )
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/antolex-legacy-hashes.XXXXXX")"
cleanup_work_dir() {
  rm -rf -- "${work_dir}"
}
trap cleanup_work_dir EXIT

"${psql_command[@]}" --command="
  SELECT
    id::text,
    external_track_id,
    COALESCE(original_object_key, object_key),
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')
  FROM library_tracks
  WHERE COALESCE(original_object_key, object_key) IS NOT NULL
  ORDER BY created_at, id;
" >"${work_dir}/tracks.tsv"

mkdir -p "${report_dir}"
: >"${manifest_path}"
aws_r2=(aws --endpoint-url "${endpoint}")

track_count="$(wc -l <"${work_dir}/tracks.tsv" | tr -d ' ')"
track_index=0
printf 'Hashing %s R2 object(s) from %s. This is read-only but downloads every object.\n' "${track_count}" "${bucket_name}" >&2

while IFS=$'\t' read -r track_id external_track_id object_key created_at; do
  track_index=$((track_index + 1))
  printf '[%d/%d] %s\n' "${track_index}" "${track_count}" "${object_key}" >&2

  if command -v sha256sum >/dev/null; then
    content_hash="$("${aws_r2[@]}" s3 cp "s3://${bucket_name}/${object_key}" - --no-progress | sha256sum | cut -d' ' -f1)"
  else
    content_hash="$("${aws_r2[@]}" s3 cp "s3://${bucket_name}/${object_key}" - --no-progress | shasum -a 256 | cut -d' ' -f1)"
  fi

  printf '%s\t%s\t%s\t%s\t%s\n' \
    "${content_hash}" "${track_id}" "${external_track_id}" "${created_at}" "${object_key}" \
    >>"${manifest_path}"
done <"${work_dir}/tracks.tsv"

jq -Rn '
  [inputs
    | split("\t")
    | {sha256: .[0], id: .[1], external_track_id: .[2], created_at: .[3], object_key: .[4]}]
  | sort_by(.sha256, .created_at, .id)
  | group_by(.sha256)
  | map(select(length > 1) | {
      sha256: .[0].sha256,
      copies: length,
      keep: .[0],
      duplicate_rows: .[1:]
    })
' <"${manifest_path}" >"${duplicates_path}"

duplicate_rows="$(jq '[.[].duplicate_rows | length] | add // 0' "${duplicates_path}")"
canonical_rows=$((track_count - duplicate_rows))

printf 'Manifest: %s\n' "${manifest_path}"
printf 'Duplicate report: %s\n' "${duplicates_path}"
printf 'Canonical rows: %d; exact duplicate rows: %d\n' "${canonical_rows}" "${duplicate_rows}"
printf 'No database rows or R2 objects were changed.\n'
