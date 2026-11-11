#!/bin/bash
# SPDX-FileCopyrightText: 2026 Mohamad Munir Adas <munir.adas@fau.de>
# SPDX-License-Identifier: MIT
#
# Sets up the Patient Journey Matcher on a fresh Debian 13 VM. Paste it as the customization
# script when you launch the VM, or run it there with sudo. It is safe to run again.
# See Documentation/deployment.md.
set -euo pipefail

APP_USER=debian
APP_DIR=/opt/patient-journey-matcher
REPO_URL=https://github.com/amosproj/amos2026ws03-patient-journey-matcher.git
LOG=/var/log/matcher-setup.log

# As a customization script, cloud-init also copies the output to the instance log of the dashboard.
exec > >(tee -a "$LOG") 2>&1
step() { echo "=== matcher-setup: $* ==="; }

step "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git make openssl

step "docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
usermod -aG docker "$APP_USER"

step "node 24 and pnpm 12"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
command -v pnpm >/dev/null || npm install -g pnpm@12

step "uv"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

step "repository"
mkdir -p "$APP_DIR"
chown "$APP_USER": "$APP_DIR"
as_app() { sudo -u "$APP_USER" -H "$@"; }
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" pull --ff-only
else
  as_app git clone "$REPO_URL" "$APP_DIR"
fi
if [ ! -f "$APP_DIR/.env" ]; then
  as_app sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" "$APP_DIR/.env.example" \
    | as_app tee "$APP_DIR/.env" >/dev/null
  chmod 600 "$APP_DIR/.env"
fi

step "database, build and tests"
# sg: the docker group of this user is not active in this shell yet.
as_app sg docker -c "make -C $APP_DIR db"
as_app make -C "$APP_DIR" build
as_app make -C "$APP_DIR" test || echo "=== matcher-setup: TESTS FAILED, see above ==="

step "mcp server as a service"
cat > /etc/systemd/system/matcher-mcp.service <<UNIT
[Unit]
Description=Patient Journey Matcher MCP server
After=docker.service
Wants=docker.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/make start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable matcher-mcp.service
systemctl restart matcher-mcp.service

step "check"
for _ in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:3000/mcp && break
  sleep 2
done
systemctl is-active matcher-mcp.service || true
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 600 || true
echo
step "done, the server runs. Fill it with: make seed && make index (see Documentation/build.md)"
