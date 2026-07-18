#!/usr/bin/env bash
set -euo pipefail

OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v26.7.3-debian}"
OSRM_PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf}"
OSRM_MD5_URL="${OSRM_MD5_URL:-${OSRM_PBF_URL}.md5}"
VOLUME="${OSRM_VOLUME:-dashly-osrm-bicycle}"
WORK_DIR="${OSRM_WORK_DIR:-$PWD/.osrm-work}"
PBF="$WORK_DIR/java-latest.osm.pbf"
THREADS="${OSRM_THREADS:-4}"
CONTAINER="dashly-osrm-prepare"

command -v curl >/dev/null || { echo "curl is required"; exit 1; }
command -v docker >/dev/null || { echo "docker is required"; exit 1; }
command -v flock >/dev/null || { echo "flock is required"; exit 1; }
command -v md5sum >/dev/null || { echo "md5sum is required"; exit 1; }

mkdir -p "$WORK_DIR"
exec 9>"$WORK_DIR/prepare.lock"
flock -n 9 || { echo "Another OSRM preparation is already running"; exit 1; }
docker volume create "$VOLUME" >/dev/null

graph_ready() {
  docker run --rm -v "$VOLUME:/data" "$OSRM_IMAGE" sh -c \
    'test -f /data/java.osrm.partition && test -f /data/java.osrm.cells && test -f /data/java.osrm.cell_metrics'
}

if graph_ready && [ "${FORCE_OSRM_REBUILD:-0}" != "1" ]; then
  echo "OSRM graph already exists in volume $VOLUME."
  echo "Set FORCE_OSRM_REBUILD=1 to rebuild it."
  exit 0
fi

expected_md5="$(curl --fail --location --retry 10 --retry-all-errors "$OSRM_MD5_URL" | awk '{print $1}')"
verify_pbf() {
  [ -f "$PBF" ] && printf '%s  %s\n' "$expected_md5" "$PBF" | md5sum --check --status
}

download_pbf() {
  curl --fail --location --continue-at - --retry 20 --retry-all-errors --retry-delay 5 \
    --connect-timeout 30 --output "$PBF" "$OSRM_PBF_URL"
}

if ! verify_pbf; then
  download_pbf
  if ! verify_pbf; then
    echo "Resumed PBF failed checksum; downloading a clean copy"
    rm -f "$PBF"
    download_pbf
    verify_pbf || { echo "PBF checksum verification failed"; exit 1; }
  fi
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run --name "$CONTAINER" --rm \
  --memory 5g --memory-swap 12g --cpus "$THREADS" \
  -v "$WORK_DIR:/input:ro" -v "$VOLUME:/data" \
  "$OSRM_IMAGE" sh -c "rm -f /data/java.osrm* && osrm-extract --threads $THREADS -p /opt/bicycle.lua /input/java-latest.osm.pbf --output /data/java.osrm"

docker run --name "$CONTAINER" --rm \
  --memory 5g --memory-swap 12g --cpus "$THREADS" \
  -v "$VOLUME:/data" "$OSRM_IMAGE" osrm-partition --threads "$THREADS" /data/java.osrm

docker run --name "$CONTAINER" --rm \
  --memory 5g --memory-swap 12g --cpus "$THREADS" \
  -v "$VOLUME:/data" "$OSRM_IMAGE" osrm-customize --threads "$THREADS" /data/java.osrm

graph_ready
trap - EXIT INT TERM
echo "OSRM bicycle graph ready in Docker volume: $VOLUME"
