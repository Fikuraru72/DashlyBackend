#!/usr/bin/env bash
set -euo pipefail

OSRM_IMAGE="${OSRM_IMAGE:-osrm/osrm-backend:latest}"
OSRM_PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/osrm-data"
PBF_PATH="$DATA_DIR/map.osm.pbf"

# MVP map: Java extract, small enough for local dev/East Java-ish demo.
# Later when app is ready for wider deployment, switch to full Indonesia:
# OSRM_PBF_URL=https://download.geofabrik.de/asia/indonesia-latest.osm.pbf

mkdir -p "$DATA_DIR/bicycle" "$DATA_DIR/foot"

if [ ! -f "$PBF_PATH" ]; then
  echo "Downloading OSM extract: $OSRM_PBF_URL"
  curl -L "$OSRM_PBF_URL" -o "$PBF_PATH"
fi

prepare_profile() {
  local name="$1"
  local profile="$2"
  local target="$DATA_DIR/$name"

  echo "Preparing OSRM $name graph..."
  rm -f "$target"/*
  cp "$PBF_PATH" "$target/map.osm.pbf"

  docker run --rm -t \
    -v "$target:/data" \
    -v "$ROOT_DIR/osrm-profiles:/profiles:ro" \
    "$OSRM_IMAGE" osrm-extract -p "/profiles/$profile.lua" /data/map.osm.pbf
  docker run --rm -t -v "$target:/data" "$OSRM_IMAGE" \
    osrm-partition /data/map.osrm
  docker run --rm -t -v "$target:/data" "$OSRM_IMAGE" \
    osrm-customize /data/map.osrm

  rm -f "$target/map.osm.pbf"
}

prepare_profile bicycle bicycle
prepare_profile foot foot

echo "OSRM data ready. Run: docker compose up -d osrm-bicycle osrm-foot"
