#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
VP_BIN="${VP_BIN:-$HOME/.vite-plus/bin/vp}"
USER_NAME="${USER_NAME:-$(whoami)}"

sudo tee /etc/systemd/system/dashly-backend.service >/dev/null <<EOF
[Unit]
Description=Dashly Backend
After=docker.service network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=1024
ExecStart=$VP_BIN run start:prod
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
echo "Installed /etc/systemd/system/dashly-backend.service"
