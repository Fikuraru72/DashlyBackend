#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
VUS="${VUS:-5}"
DURATION="${DURATION:-30s}"
EXPECT_OSRM="${EXPECT_OSRM:-true}"

if curl -fsS "$BASE_URL" >/dev/null 2>&1; then
  echo "Refusing to test unconstrained existing app at $BASE_URL. Stop it first."
  exit 1
fi

vp run build

taskset -c 0,1 env NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}" vp run start:prod &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

ready=false
for _ in {1..40}; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "App exited before k6 started."
    exit 1
  fi
  if curl -fsS "$BASE_URL" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" != true ]; then
  echo "App did not become ready at $BASE_URL"
  exit 1
fi

# k6 runner also constrained to 2 CPU / 2GB so test pressure is reproducible.
docker run --rm \
  --network host \
  --cpus=2 \
  --memory=2g \
  -e BASE_URL="$BASE_URL" \
  -e VUS="$VUS" \
  -e DURATION="$DURATION" \
  -e EXPECT_OSRM="$EXPECT_OSRM" \
  -e ADMIN_EMAIL="${ADMIN_EMAIL:-admin@dashly.com}" \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD:-password123}" \
  -v "$PWD/test/k6:/scripts:ro" \
  grafana/k6:latest run /scripts/osrm-route-normalization.js
