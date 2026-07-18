#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS="$ROOT/k6/results"
K6_IMAGE=${K6_IMAGE:-grafana/k6:1.3.0}
BASE_URL=${BASE_URL:-https://apiv2.dashlytrack.cloud}
API_URL=${API_URL:-$BASE_URL}
DURATION=${DURATION:-5m}
SPECTATORS=${SPECTATORS:-50}
OPERATORS=${OPERATORS:-5}
SOCKET_CLIENTS=${SOCKET_CLIENTS:-2}
PARTICIPANT_LIMIT=${PARTICIPANT_LIMIT:-10}
UPDATE_INTERVAL_MS=${UPDATE_INTERVAL_MS:-1000}
DRAIN_DURATION=${DRAIN_DURATION:-30s}
MAX_E2E_P95_MS=${MAX_E2E_P95_MS:-3000}
MQTT_LOCAL_PORT=${MQTT_LOCAL_PORT:-1884}
VPS=${VPS:-root@38.103.170.148}
AUTH_EMAIL=${AUTH_EMAIL:-admin@dashly.com}

login() {
  local password=${AUTH_PASSWORD:-}
  if [[ -z "$password" ]]; then
    read -rsp "Password for ${AUTH_EMAIL}: " password
    echo
  fi

  STAFF_ACCESS_TOKEN=$(
    AUTH_EMAIL="$AUTH_EMAIL" AUTH_PASSWORD="$password" \
      node -e 'process.stdout.write(JSON.stringify({email: process.env.AUTH_EMAIL, password: process.env.AUTH_PASSWORD}))' \
      | curl -fsS "$API_URL/auth/login" -H 'content-type: application/json' --data-binary @- \
      | node -e "let body=''; process.stdin.on('data', chunk => body += chunk).on('end', () => { const token = JSON.parse(body).accessToken; if (!token) throw new Error('Login response has no accessToken'); process.stdout.write(token); })"
  )
  export STAFF_ACCESS_TOKEN
  unset AUTH_PASSWORD
  echo "Authenticated as ${AUTH_EMAIL}."
}

usage() {
  cat <<'EOF'
Usage: ./k6/run-manual.sh <http|race|all>

Required:
  CONFIRM_PRODUCTION_LOAD=YES

Authentication:
  Automatically logs in as AUTH_EMAIL (default admin@dashly.com) when STAFF_ACCESS_TOKEN is empty.
  Set AUTH_PASSWORD or enter it through the hidden prompt.

Race mode also requires:
  k6/participants.json containing [{"userId": 123}, ...]

Defaults:
  DURATION=5m PARTICIPANT_LIMIT=10 SPECTATORS=50 OPERATORS=5 SOCKET_CLIENTS=2
  UPDATE_INTERVAL_MS=1000 DRAIN_DURATION=30s MAX_E2E_P95_MS=3000

Examples:
  CONFIRM_PRODUCTION_LOAD=YES ./k6/run-manual.sh http
  CONFIRM_PRODUCTION_LOAD=YES PARTICIPANT_LIMIT=25 ./k6/run-manual.sh race
EOF
}

mode=${1:-}
if [[ ! "$mode" =~ ^(http|race|all)$ ]]; then
  usage
  exit 2
fi
if [[ ${CONFIRM_PRODUCTION_LOAD:-} != YES ]]; then
  echo 'Refusing to generate load. Set CONFIRM_PRODUCTION_LOAD=YES.' >&2
  exit 2
fi
if [[ -z ${EVENT_ID:-} && -f "$ROOT/k6/prepared.json" ]]; then
  EVENT_ID=$(node -e "process.stdout.write(String(require('$ROOT/k6/prepared.json').eventId))")
  export EVENT_ID
fi
: "${EVENT_ID:?Set EVENT_ID or run k6/prepare.cjs first}"
if [[ -z ${STAFF_ACCESS_TOKEN:-} ]]; then
  login
fi

mkdir -p "$RESULTS"
stamp=$(date -u +%Y%m%dT%H%M%SZ)

run_http() {
  docker run --rm --network host \
    -e BASE_URL -e EVENT_ID -e STAFF_ACCESS_TOKEN -e CONFIRM_PRODUCTION_LOAD \
    -e DURATION -e SPECTATORS -e OPERATORS \
    -v "$ROOT/k6:/scripts:ro" \
    "$K6_IMAGE" run /scripts/http-stress.js \
    | tee "$RESULTS/http-real-world-$stamp.log"
}

start_mqtt_tunnel() {
  if ss -ltn "sport = :${MQTT_LOCAL_PORT}" | grep -q LISTEN; then
    echo "Local port ${MQTT_LOCAL_PORT} is already in use; stop the stale tunnel first." >&2
    exit 1
  fi

  mqtt_network=$(ssh "$VPS" 'c=$(docker ps --filter name=dashly-backend-fdjkqy-mosquitto-1 -q | head -1); [[ -n "$c" ]] && docker inspect "$c" | jq -r ".[0].NetworkSettings.Networks | keys[0]"')
  if [[ -z "$mqtt_network" ]]; then
    echo 'Mosquitto container or network not found.' >&2
    exit 1
  fi

  ssh "$VPS" 'docker rm -f dashly-k6-mqtt-tunnel >/dev/null 2>&1 || true'
  ssh -o ExitOnForwardFailure=yes \
    -L "127.0.0.1:${MQTT_LOCAL_PORT}:127.0.0.1:1884" "$VPS" \
    "docker run --rm --name dashly-k6-mqtt-tunnel --network '$mqtt_network' -p 127.0.0.1:1884:1884 alpine/socat TCP-LISTEN:1884,fork,reuseaddr TCP:mosquitto:1883" &
  tunnel_pid=$!

  for _ in {1..30}; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${MQTT_LOCAL_PORT}") 2>/dev/null; then
      exec 3>&-
      return
    fi
    kill -0 "$tunnel_pid" 2>/dev/null || break
    sleep 1
  done

  echo 'MQTT tunnel did not become ready.' >&2
  exit 1
}

run_race() {
  [[ -f "$ROOT/k6/participants.json" ]] || {
    echo 'Create k6/participants.json from dedicated test participants first.' >&2
    exit 2
  }
  start_mqtt_tunnel
  MQTT_URL="mqtt://127.0.0.1:${MQTT_LOCAL_PORT}" \
  PARTICIPANTS_FILE="$ROOT/k6/participants.json" \
  API_URL="$API_URL" EVENT_ID="$EVENT_ID" STAFF_ACCESS_TOKEN="$STAFF_ACCESS_TOKEN" \
  CONFIRM_PRODUCTION_LOAD=YES DURATION="$DURATION" SOCKET_CLIENTS="$SOCKET_CLIENTS" \
  PARTICIPANT_LIMIT="$PARTICIPANT_LIMIT" UPDATE_INTERVAL_MS="$UPDATE_INTERVAL_MS" \
  DRAIN_DURATION="$DRAIN_DURATION" MAX_E2E_P95_MS="$MAX_E2E_P95_MS" \
    node "$ROOT/k6/race-simulator.cjs" | tee "$RESULTS/race-real-world-$stamp.log"
}

cleanup() {
  [[ -n ${tunnel_pid:-} ]] && kill "$tunnel_pid" 2>/dev/null || true
  [[ -n ${mqtt_network:-} ]] && ssh "$VPS" 'docker rm -f dashly-k6-mqtt-tunnel >/dev/null 2>&1 || true' || true
}
trap cleanup EXIT

case "$mode" in
  http) run_http ;;
  race) run_race ;;
  all)
    run_race &
    race_pid=$!
    sleep 5
    run_http
    wait "$race_pid"
    ;;
esac

echo "Results: $RESULTS/*-$stamp.log"
