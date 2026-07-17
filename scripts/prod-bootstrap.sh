#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo scripts/prod-bootstrap.sh"
  exit 1
fi

if [ ! -f /etc/rocky-release ]; then
  echo "Rocky Linux required"
  exit 1
fi

dnf update -y
dnf install -y ca-certificates curl git firewalld policycoreutils-python-utils tar
systemctl enable --now firewalld

# Dokploy owns ports 80/443 through Traefik. Port 3000 is temporary for panel setup.
firewall-cmd --permanent --add-service=ssh
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --reload

if ! swapon --show --noheadings | grep -q .; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

cat >/etc/sysctl.d/99-dashly.conf <<'EOF'
vm.swappiness=10
fs.inotify.max_user_watches=524288
net.core.somaxconn=4096
EOF
sysctl --system >/dev/null

echo "Rocky Linux prepared. Install Dokploy next:"
echo "curl -sSL https://dokploy.com/install.sh | DOKPLOY_VERSION=latest sh"
