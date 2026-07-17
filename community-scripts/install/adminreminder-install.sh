#!/usr/bin/env bash
# Author: Krzysztof Gawkowski (www.krzysztofgawkowski.pl)
# License: MIT (skrypt instalacyjny) | Aplikacja: proprietary — patrz LICENSE w repo
# Source: https://github.com/Kr1sCode/adminreminder

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt-get install -y git build-essential python3 ca-certificates gnupg
msg_ok "Installed Dependencies"

msg_info "Installing Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
$STD apt-get install -y nodejs
msg_ok "Installed Node.js $(node -v)"

msg_info "Installing ${APPLICATION:-AdminReminder}"
cd /opt
$STD git clone --depth 1 https://github.com/Kr1sCode/adminreminder
cd /opt/adminreminder
$STD npm ci --no-audit --no-fund
export NEXT_TELEMETRY_DISABLED=1
$STD npm run build
mkdir -p /opt/adminreminder/data
JWT=$(openssl rand -base64 48 | tr -d '\n')
SKEY=$(openssl rand -base64 32 | tr -d '\n')
CRON=$(openssl rand -base64 32 | tr -d '\n')
IP=$(hostname -I | awk '{print $1}')
cat >/opt/adminreminder/.env <<EOF
DATABASE_URL=/opt/adminreminder/data/ar.db
JWT_SECRET=${JWT}
SETTINGS_KEY=${SKEY}
CRON_SECRET=${CRON}
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
APP_ORIGIN=http://${IP}:3000
TZ=Europe/Warsaw
NEXT_TELEMETRY_DISABLED=1
EOF
chmod 600 /opt/adminreminder/.env
set -a; . /opt/adminreminder/.env; set +a
$STD node /opt/adminreminder/scripts/init-db.js
msg_ok "Installed ${APPLICATION:-AdminReminder}"

msg_info "Creating Service"
cat >/etc/systemd/system/adminreminder.service <<EOF
[Unit]
Description=AdminReminder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/adminreminder
EnvironmentFile=/opt/adminreminder/.env
ExecStartPre=/usr/bin/node /opt/adminreminder/scripts/init-db.js
ExecStart=/usr/bin/node /opt/adminreminder/node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now adminreminder
msg_ok "Created Service"

motd_ssh
customize

msg_info "Cleaning up"
$STD apt-get -y autoremove
$STD apt-get -y autoclean
msg_ok "Cleaned"
