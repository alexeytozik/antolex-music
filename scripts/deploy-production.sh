#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if (( $# != 2 )); then
  printf 'Usage: %s <release-id> <archive-name>\n' "$0" >&2
  exit 2
fi

release_id="$1"
archive_name="$2"
root="/home/atozik/antolex-music"
incoming_dir="${root}/incoming"
releases_dir="${root}/releases"
shared_env="${root}/shared/.env"
backup_dir="${root}/shared/backups/postgres"
release_dir="${releases_dir}/${release_id}"
archive_path="${incoming_dir}/${archive_name}"
checksum_path="${archive_path}.sha256"
incoming_script="${incoming_dir}/deploy-${release_id}.sh"
current_link="${root}/current"
previous_release=""
deploy_started=0

if [[ ! "${release_id}" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]]; then
  printf 'Invalid release identifier.\n' >&2
  exit 1
fi
if [[ "${archive_name}" != "antolex-music-${release_id}.tar.gz" ]]; then
  printf 'Archive name does not match the release identifier.\n' >&2
  exit 1
fi

cleanup_and_rollback() {
  status=$?
  trap - EXIT
  rm -f -- "${archive_path}" "${checksum_path}" "${incoming_script}"
  if (( status != 0 && deploy_started == 1 )) && [[ -n "${previous_release}" ]]; then
    printf 'Deployment failed; restoring the previous Compose release.\n' >&2
    (
      cd "${previous_release}"
      sudo -n docker compose \
        --env-file "${shared_env}" \
        --project-directory "${previous_release}" \
        -f "${previous_release}/docker-compose.yml" \
        --profile production up -d --build --remove-orphans
    ) || printf 'Automatic rollback failed; manual intervention is required.\n' >&2
  fi
  exit "${status}"
}
trap cleanup_and_rollback EXIT

if [[ ! -f "${shared_env}" ]]; then
  printf 'Missing shared production environment: %s\n' "${shared_env}" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "${shared_env}")" != "600" ]]; then
  printf 'Shared production environment must have mode 600.\n' >&2
  exit 1
fi
if [[ -e "${current_link}" && ! -L "${current_link}" ]]; then
  printf 'Refusing to replace a non-symlink current path.\n' >&2
  exit 1
fi
if [[ -L "${current_link}" ]]; then
  previous_release="$(readlink -f "${current_link}")"
  if [[ ! -d "${previous_release}" ]]; then
    printf 'Current release symlink is broken.\n' >&2
    exit 1
  fi
fi

command -v curl >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null
sudo -n docker compose version >/dev/null

cd "${incoming_dir}"
sha256sum --check "$(basename "${checksum_path}")"
if [[ -e "${release_dir}" ]]; then
  printf 'Release directory already exists: %s\n' "${release_dir}" >&2
  exit 1
fi
install -d -m 755 "${release_dir}"
tar --extract --gzip --file "${archive_path}" \
  --directory "${release_dir}" --no-same-owner
ln -s "${shared_env}" "${release_dir}/.env"

compose=(
  sudo -n docker compose
  --env-file "${shared_env}"
  --project-directory "${release_dir}"
  -f "${release_dir}/docker-compose.yml"
)
"${compose[@]}" --profile production config --quiet

existing_services="$(sudo -n docker ps -a \
  --filter 'label=com.docker.compose.project=antolex-music' \
  --format '{{.Label "com.docker.compose.service"}}')"
if grep -Fxq postgres <<<"${existing_services}"; then
  running_services="$(sudo -n docker ps \
    --filter 'label=com.docker.compose.project=antolex-music' \
    --format '{{.Label "com.docker.compose.service"}}')"
  if ! grep -Fxq postgres <<<"${running_services}"; then
    printf 'Existing PostgreSQL container is not running; refusing an unbacked deployment.\n' >&2
    exit 1
  fi
  (
    cd "${release_dir}"
    sudo -n env -u DATABASE_URL \
      ANTOLEX_BACKUP_DIR="${backup_dir}" \
      ./scripts/backup-postgres.sh
  )
fi

deploy_started=1
"${compose[@]}" --profile production up -d --build \
  --remove-orphans --wait --wait-timeout 300

healthy=0
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1 \
    && curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:5173/ >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 5
done
if (( healthy != 1 )); then
  "${compose[@]}" --profile production ps >&2
  printf 'Production health check did not pass within five minutes.\n' >&2
  exit 1
fi

running_services="$("${compose[@]}" --profile production ps \
  --status running --services)"
for required_service in postgres redis api worker web caddy; do
  if ! grep -Fxq "${required_service}" <<<"${running_services}"; then
    printf 'Required service is not running: %s\n' "${required_service}" >&2
    "${compose[@]}" --profile production ps >&2
    exit 1
  fi
done

next_link="${root}/.current-${release_id}"
ln -s "${release_dir}" "${next_link}"
mv -Tf "${next_link}" "${current_link}"
deploy_started=0
printf 'Activated release %s\n' "${release_id}"
