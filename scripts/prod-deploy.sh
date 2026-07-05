#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  echo ".env not found"
  exit 1
fi

COMPOSE="docker compose -f docker-compose.prod.yml"

# Remove old host-service deployment if it exists.
sudo systemctl disable --now dashly-backend 2>/dev/null || true

# Remove old containers that may conflict with the new compose app container.
docker rm -f dashly_backend dashly_osrm_bicycle dashly_postgres 2>/dev/null || true

$COMPOSE build app
$COMPOSE up -d redis mosquitto
$COMPOSE run --rm app bunx drizzle-kit migrate
$COMPOSE up -d app
$COMPOSE ps
