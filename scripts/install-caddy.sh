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

sudo setsebool -P httpd_can_network_connect 1
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo systemctl reload caddy
echo "Caddy configured for https://$DOMAIN"
