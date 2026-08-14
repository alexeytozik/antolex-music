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

account_id="${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID}"
source_bucket="${R2_SOURCE_BUCKET_NAME:?Set R2_SOURCE_BUCKET_NAME}"
target_bucket="${R2_BUCKET_NAME:?Set R2_BUCKET_NAME}"
endpoint="${R2_ENDPOINT:-https://${account_id}.r2.cloudflarestorage.com}"
target_access_key="${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID for the target bucket}"
target_secret_key="${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY for the target bucket}"

if [[ "${source_bucket}" == "${target_bucket}" ]]; then
  printf 'Source and target buckets must be different.\n' >&2
  exit 1
fi

if [[ -n "${R2_SOURCE_ACCESS_KEY_ID:-}" || -n "${R2_SOURCE_SECRET_ACCESS_KEY:-}" ]]; then
  source_access_key="${R2_SOURCE_ACCESS_KEY_ID:?Set both R2_SOURCE_ACCESS_KEY_ID and R2_SOURCE_SECRET_ACCESS_KEY}"
  source_secret_key="${R2_SOURCE_SECRET_ACCESS_KEY:?Set both R2_SOURCE_ACCESS_KEY_ID and R2_SOURCE_SECRET_ACCESS_KEY}"
else
  # Backwards compatibility for installations whose target token can read both
  # buckets. New migrations should use a separate read-only source credential.
  source_access_key="${target_access_key}"
  source_secret_key="${target_secret_key}"
  printf 'Warning: source credentials are unset; using target credentials for the source inventory.\n' >&2
fi

aws_with_credentials() {
  local access_key="$1"
  local secret_key="$2"
  shift 2
  AWS_ACCESS_KEY_ID="${access_key}" \
    AWS_SECRET_ACCESS_KEY="${secret_key}" \
    AWS_SESSION_TOKEN="" \
    AWS_DEFAULT_REGION=auto \
    AWS_REGION=auto \
    AWS_PAGER="" \
    aws --endpoint-url "${endpoint}" "$@"
}

aws_source() {
  aws_with_credentials "${source_access_key}" "${source_secret_key}" "$@"
}

aws_target() {
  aws_with_credentials "${target_access_key}" "${target_secret_key}" "$@"
}

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/antolex-r2-dry-run.XXXXXX")"
cleanup_work_dir() {
  rm -rf -- "${work_dir}"
}
trap cleanup_work_dir EXIT

printf 'Reading R2 inventories (no writes)...\n'
aws_source s3api list-objects-v2 --bucket "${source_bucket}" --output json >"${work_dir}/source.json"
aws_target s3api list-objects-v2 --bucket "${target_bucket}" --output json >"${work_dir}/target.json"

jq -r '.Contents[]? | [.Key, (.Size | tostring), (.ETag // "" | gsub("\\\""; ""))] | @tsv' \
  "${work_dir}/source.json" | LC_ALL=C sort >"${work_dir}/source.tsv"
jq -r '.Contents[]? | [.Key, (.Size | tostring), (.ETag // "" | gsub("\\\""; ""))] | @tsv' \
  "${work_dir}/target.json" | LC_ALL=C sort >"${work_dir}/target.tsv"

printf '\nSource %s: ' "${source_bucket}"
jq -r '[.Contents[]?.Size] | "objects=\(length), bytes=\(add // 0)"' "${work_dir}/source.json"
printf 'Target %s: ' "${target_bucket}"
jq -r '[.Contents[]?.Size] | "objects=\(length), bytes=\(add // 0)"' "${work_dir}/target.json"

cut -f1,2 "${work_dir}/source.tsv" >"${work_dir}/source-key-size.tsv"
cut -f1,2 "${work_dir}/target.tsv" >"${work_dir}/target-key-size.tsv"

printf '\nKey/size inventory difference (empty means equal):\n'
diff -u "${work_dir}/target-key-size.tsv" "${work_dir}/source-key-size.tsv" || true

printf '\nR2 copy preview derived from source and target inventories (no writes):\n'
jq -nr \
  --arg source_bucket "${source_bucket}" \
  --arg target_bucket "${target_bucket}" \
  --slurpfile source "${work_dir}/source.json" \
  --slurpfile target "${work_dir}/target.json" '
    ($target[0].Contents // [] | map({key: .Key, value: .Size}) | from_entries) as $target_sizes
    | [($source[0].Contents // [])[]
        | select(($target_sizes[.Key] // null) != .Size)
        | "COPY s3://\($source_bucket)/\(.Key) -> s3://\($target_bucket)/\(.Key) (\(.Size) bytes)"]
    | if length == 0 then "No copy operations required." else .[] end
  '

if [[ -n "${ANTOLEX_REPORT_DIR:-}" ]]; then
  mkdir -p "${ANTOLEX_REPORT_DIR}"
  report_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  cp "${work_dir}/source.tsv" "${ANTOLEX_REPORT_DIR}/${source_bucket}-${report_stamp}.tsv"
  cp "${work_dir}/target.tsv" "${ANTOLEX_REPORT_DIR}/${target_bucket}-${report_stamp}.tsv"
  printf '\nInventories saved in %s\n' "${ANTOLEX_REPORT_DIR}"
fi

if [[ "${ANTOLEX_R2_VERIFY_CONTENT:-no}" == "yes" ]]; then
  printf '\nFull read-only SHA-256 verification requested. This downloads every matching object twice.\n'
  verify_failures=0
  while IFS=$'\t' read -r object_key object_size; do
    if ! grep -Fqx "${object_key}"$'\t'"${object_size}" "${work_dir}/target-key-size.tsv"; then
      printf 'SKIP missing or size mismatch: %s\n' "${object_key}"
      verify_failures=$((verify_failures + 1))
      continue
    fi

    if command -v sha256sum >/dev/null; then
      source_hash="$(aws_source s3 cp "s3://${source_bucket}/${object_key}" - --no-progress | sha256sum | cut -d' ' -f1)"
      target_hash="$(aws_target s3 cp "s3://${target_bucket}/${object_key}" - --no-progress | sha256sum | cut -d' ' -f1)"
    else
      source_hash="$(aws_source s3 cp "s3://${source_bucket}/${object_key}" - --no-progress | shasum -a 256 | cut -d' ' -f1)"
      target_hash="$(aws_target s3 cp "s3://${target_bucket}/${object_key}" - --no-progress | shasum -a 256 | cut -d' ' -f1)"
    fi

    if [[ "${source_hash}" != "${target_hash}" ]]; then
      printf 'FAIL SHA-256 mismatch: %s\n' "${object_key}"
      verify_failures=$((verify_failures + 1))
    else
      printf 'OK %s\n' "${object_key}"
    fi
  done <"${work_dir}/source-key-size.tsv"

  if (( verify_failures > 0 )); then
    printf 'Verification found %d problem(s). No remote data was changed.\n' "${verify_failures}" >&2
    exit 1
  fi
fi

printf '\nDry-run complete. No objects were copied, overwritten, or deleted.\n'
