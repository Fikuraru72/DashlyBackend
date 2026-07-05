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

docker compose -f docker-compose.prod.yml up -d redis mosquitto

$VP install
$VP run build
$VP exec drizzle-kit migrate

sudo systemctl daemon-reload
sudo systemctl enable --now dashly-backend
sudo systemctl restart dashly-backend
sudo systemctl status dashly-backend --no-pager
