#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo scripts/dokploy-install.sh"
  exit 1
fi

for port in 80 443 3000; do
  if ss -lnt "sport = :$port" | tail -n +2 | grep -q .; then
    echo "Port $port is already in use; Dokploy requires ports 80, 443, and 3000."
    exit 1
  fi
done

curl --fail --silent --show-error --location https://dokploy.com/install.sh -o /tmp/dokploy-install.sh
DOKPLOY_VERSION="${DOKPLOY_VERSION:-latest}" sh /tmp/dokploy-install.sh
rm -f /tmp/dokploy-install.sh

echo "Dokploy installed. Open http://SERVER_IP:3000 and create the admin account."
