#!/usr/bin/env bash
set -euo pipefail

OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v26.7.3-debian}"
OSRM_PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf}"
VOLUME="${OSRM_VOLUME:-dashly-osrm-bicycle}"
WORK_DIR="${OSRM_WORK_DIR:-$PWD/.osrm-work}"
PBF="$WORK_DIR/java-latest.osm.pbf"

command -v docker >/dev/null || { echo "docker is required"; exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }

mkdir -p "$WORK_DIR"
docker volume create "$VOLUME" >/dev/null

if docker run --rm -v "$VOLUME:/data" "$OSRM_IMAGE" test -f /data/java.osrm.cell_metrics; then
  echo "OSRM graph already exists in volume $VOLUME."
  echo "Set FORCE_OSRM_REBUILD=1 to rebuild it."
  [ "${FORCE_OSRM_REBUILD:-0}" = "1" ] || exit 0
fi

curl --fail --location --retry 5 --continue-at - --output "$PBF" "$OSRM_PBF_URL"

docker run --rm \
  --memory 5g --memory-swap 12g --cpus 4 \
  -v "$WORK_DIR:/input:ro" -v "$VOLUME:/data" \
  "$OSRM_IMAGE" sh -c 'rm -f /data/java.osrm* && osrm-extract -p /opt/bicycle.lua /input/java-latest.osm.pbf --output /data/java.osrm'

docker run --rm \
  --memory 5g --memory-swap 12g --cpus 4 \
  -v "$VOLUME:/data" "$OSRM_IMAGE" osrm-partition /data/java.osrm

docker run --rm \
  --memory 5g --memory-swap 12g --cpus 4 \
  -v "$VOLUME:/data" "$OSRM_IMAGE" osrm-customize /data/java.osrm

docker run --rm -v "$VOLUME:/data" "$OSRM_IMAGE" \
  sh -c 'test -f /data/java.osrm.partition && test -f /data/java.osrm.cells && test -f /data/java.osrm.cell_metrics'
rm -f "$PBF"
echo "OSRM bicycle graph ready in Docker volume: $VOLUME"
