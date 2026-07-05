#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: scripts/install-caddy.sh api.example.com"
  exit 1
fi

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:3000
}
EOF

sudo systemctl reload caddy
echo "Caddy configured for https://$DOMAIN"
