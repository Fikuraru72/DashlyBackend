#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo scripts/dokploy-lockdown.sh"
  exit 1
fi

read -r -p "Confirm the Dokploy HTTPS domain works (type YES): " answer
[ "$answer" = "YES" ] || exit 1

docker service update --publish-rm 'published=3000,target=3000,mode=host' dokploy
firewall-cmd --permanent --remove-port=3000/tcp || true
firewall-cmd --reload

echo "Direct Dokploy access on port 3000 disabled."
