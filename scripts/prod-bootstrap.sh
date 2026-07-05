#!/usr/bin/env bash
set -euo pipefail

if [ ! -f /etc/rocky-release ]; then
  echo "Rocky Linux required"
  exit 1
fi

sudo dnf install -y dnf-plugins-core ca-certificates curl git policycoreutils-python-utils
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
sudo systemctl enable --now docker caddy firewalld

if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo setsebool -P httpd_can_network_connect 1

echo "OK. Next: clone repo, upload osrm-data/bicycle, create .env, run scripts/prod-deploy.sh"
