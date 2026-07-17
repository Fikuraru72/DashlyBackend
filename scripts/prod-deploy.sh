#!/usr/bin/env bash
set -euo pipefail

: "${BACKEND_IMAGE:?Set BACKEND_IMAGE, e.g. ghcr.io/owner/dashly-backend:latest}"

if [ ! -f .env ]; then
  echo ".env not found"
  exit 1
fi

export BACKEND_IMAGE
COMPOSE="docker compose -f docker-compose.prod.yml"

if ! docker volume inspect dashly-osrm-bicycle >/dev/null 2>&1; then
  scripts/osrm-prepare.sh
fi

$COMPOSE pull
$COMPOSE up -d --remove-orphans
$COMPOSE ps
