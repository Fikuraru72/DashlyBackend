#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  echo ".env not found"
  exit 1
fi

if command -v vp >/dev/null 2>&1; then
  VP=vp
elif [ -x "$HOME/.vite-plus/bin/vp" ]; then
  VP="$HOME/.vite-plus/bin/vp"
else
  echo "vp not found. Install/copy vp first."
  exit 1
fi

# Use --profile local-db if DATABASE_URL points to local docker postgres.
if grep -q 'DATABASE_URL=.*localhost:5432\|DATABASE_URL=.*127.0.0.1:5432' .env; then
  docker compose -f docker-compose.prod.yml --profile local-db up -d
else
  docker compose -f docker-compose.prod.yml stop postgres 2>/dev/null || true
  docker compose -f docker-compose.prod.yml rm -f postgres 2>/dev/null || true
  docker compose -f docker-compose.prod.yml up -d redis mosquitto
fi

$VP install
$VP run build
$VP exec drizzle-kit migrate

sudo systemctl daemon-reload
sudo systemctl enable --now dashly-backend
sudo systemctl restart dashly-backend
sudo systemctl status dashly-backend --no-pager
