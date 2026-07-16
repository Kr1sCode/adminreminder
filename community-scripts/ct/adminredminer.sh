#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)
# Author: Krzysztof Gawkowski (www.krzysztofgawkowski.pl)
# License: MIT (skrypt instalacyjny) | Aplikacja: proprietary — patrz LICENSE w repo
# Source: https://github.com/Kr1sCode/adminredminer

APP="Admin Redminer"
var_tags="${var_tags:-monitoring;certificates}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-8}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/adminredminer ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi
  msg_info "Updating ${APP}"
  cd /opt/adminredminer
  git pull --ff-only >/dev/null 2>&1 || true
  $STD npm ci --no-audit --no-fund
  $STD npm run build
  systemctl restart adminredminer
  msg_ok "Updated ${APP}"
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:3000${CL}"
