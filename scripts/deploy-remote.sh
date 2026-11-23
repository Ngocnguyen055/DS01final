set -euo pipefail
prefix=${1:?image prefix required}
revision=${2:?revision required}
[[ "$prefix" =~ ^ghcr.io/[a-z0-9_./-]+$ && "$revision" =~ ^[a-f0-9]{40}$ ]]
test -f .env
test -f compose.images.yml
release_file=current-release.env
previous_file=previous-release.env
next_file=next-release.env
printf 'DS01_IMAGE_PREFIX=%s\nDS01_IMAGE_TAG=sha-%s\n' "$prefix" "$revision" > "$next_file"
docker compose --env-file .env --env-file "$next_file" -f compose.images.yml config --quiet
docker compose --env-file .env --env-file "$next_file" -f compose.images.yml pull
if docker compose --env-file .env --env-file "$next_file" -f compose.images.yml up -d --wait --wait-timeout 120; then
  if test -f "$release_file"; then cp "$release_file" "$previous_file"; fi
  mv "$next_file" "$release_file"
  printf 'Deployed %s\n' "$revision"
else
  docker compose --env-file .env --env-file "$next_file" -f compose.images.yml logs --tail 80
  if test -f "$release_file"; then
    docker compose --env-file .env --env-file "$release_file" -f compose.images.yml up -d --wait --wait-timeout 120
    printf 'Restored previous release\n'
  fi
  exit 1
fi
