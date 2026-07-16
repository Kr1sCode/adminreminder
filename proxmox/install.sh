#!/usr/bin/env bash

# Admin Redminer — instalator LXC dla Proxmox VE (styl community-scripts)
# Uruchamiany NA HOŚCIE Proxmox. Tworzy nieuprzywilejowany kontener Debian 13,
# instaluje natywnie Node.js + aplikację, zakłada PUSTĄ bazę SQLite i usługę
# systemd. Bez Dockera, bez nestingu.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kr1sCode/adminredminer/main/proxmox/install.sh)"
#
# Copyright © 2026 Krzysztof Gawkowski — www.krzysztofgawkowski.pl
# Licencja: patrz plik LICENSE (homelab-free / commercial-paid).

set -Eeuo pipefail

# ------------------------------------------------------------------ wygląd ---
YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'; CL=$'\033[m'
BFR="\\r\\033[K"; HOLD=" "; CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"

spinner() {
  local chars="/-\|"; local i=0
  while true; do printf "\r ${YW}%s${CL}" "${chars:i++%${#chars}:1}"; sleep 0.1; done
}
msg_info() {
  echo -ne " ${HOLD}${YW}${1}..."
  SPIN_PID=""
  # Animuj tylko na terminalu — w logu (pipe) spinner zaśmieca wyjście.
  if [ -t 1 ]; then spinner & SPIN_PID=$!; disown "$SPIN_PID" 2>/dev/null || true; fi
}
msg_ok()   { [ -n "${SPIN_PID:-}" ] && kill "$SPIN_PID" >/dev/null 2>&1 || true; printf "${BFR}"; echo -e " ${CM} ${GN}${1}${CL}"; }
msg_err()  { [ -n "${SPIN_PID:-}" ] && kill "$SPIN_PID" >/dev/null 2>&1 || true; printf "${BFR}"; echo -e " ${CROSS} ${RD}${1}${CL}"; }
trap '[ -n "${SPIN_PID:-}" ] && kill "$SPIN_PID" >/dev/null 2>&1 || true' EXIT

header() {
  clear 2>/dev/null || true
  cat <<'EOF'
    _       _           _         ____           _           _
   / \   __| |_ __ ___ (_)_ __   |  _ \ ___  __| |_ __ ___ (_)_ __   ___ _ __
  / _ \ / _` | '_ ` _ \| | '_ \  | |_) / _ \/ _` | '_ ` _ \| | '_ \ / _ \ '__|
 / ___ \ (_| | | | | | | | | | | |  _ <  __/ (_| | | | | | | | | | |  __/ |
/_/   \_\__,_|_| |_| |_|_|_| |_| |_| \_\___|\__,_|_| |_| |_|_|_| |_|\___|_|

   Admin Redminer — monitor terminów ważności — self-host LXC installer
EOF
  echo
}

# --------------------------------------------------------------- ustawienia ---
APP="adminredminer"
var_os="debian"
var_version="13"
var_hostname="${AR_HOSTNAME:-adminredminer}"
var_disk="${AR_DISK:-8}"          # GB
var_cpu="${AR_CPU:-2}"
var_ram="${AR_RAM:-2048}"         # MB
var_bridge="${AR_BRIDGE:-vmbr0}"
var_unprivileged="1"
var_app_port="${AR_APP_PORT:-3000}"
var_storage="${AR_STORAGE:-}"     # wykryte automatycznie, jeśli puste

# Sieć: domyślnie DHCP. Dla hostów ze statyczną adresacją podaj:
#   AR_IP=192.168.1.50/24  AR_GW=192.168.1.1  (opcjonalnie AR_NS=1.1.1.1)
var_ip="${AR_IP:-dhcp}"
var_gw="${AR_GW:-}"
var_ns="${AR_NS:-}"

# Źródło aplikacji (nadpisywalne środowiskiem — używane przy testach):
AR_REPO_URL="${AR_REPO_URL:-https://github.com/Kr1sCode/adminredminer}"
AR_REPO_BRANCH="${AR_REPO_BRANCH:-main}"
AR_SRC_TARBALL="${AR_SRC_TARBALL:-}"   # jeśli ustawione: lokalny tar.gz zamiast git clone

# ---------------------------------------------------------------- kontrole ---
require_root_pve() {
  if [ "$(id -u)" -ne 0 ]; then msg_err "Uruchom jako root na hoście Proxmox."; exit 1; fi
  if ! command -v pveversion >/dev/null 2>&1; then
    msg_err "To nie jest host Proxmox VE (brak pveversion)."; exit 1
  fi
  if ! command -v pct >/dev/null 2>&1; then msg_err "Brak polecenia pct."; exit 1; fi
}

pick_storage() {
  # Preferuj magazyn wskazany przez użytkownika; inaczej pierwszy obsługujący rootdir.
  if [ -n "$var_storage" ]; then echo "$var_storage"; return; fi
  local s
  s=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1; exit}')
  [ -z "$s" ] && s="local-lvm"
  echo "$s"
}

# --------------------------------------------------------------- whiptail ----
choose_settings() {
  # Tryb nieinteraktywny (brak TTY lub AR_DEFAULTS=1): użyj domyślnych/env.
  if [ ! -t 0 ] || [ "${AR_DEFAULTS:-0}" = "1" ]; then
    echo -e " ${BL}Ustawienia:${CL} Debian ${var_version}, ${var_cpu} CPU, ${var_ram} MB, ${var_disk} GB, ${var_bridge}"
    return
  fi
  if ! command -v whiptail >/dev/null 2>&1; then return; fi
  if whiptail --title "Admin Redminer LXC" \
      --yesno "Użyć ustawień domyślnych?\n\n  OS: Debian ${var_version}\n  Hostname: ${var_hostname}\n  CPU: ${var_cpu}   RAM: ${var_ram} MB   Dysk: ${var_disk} GB\n  Sieć: ${var_bridge} (DHCP)\n  Nieuprzywilejowany: tak\n  Port aplikacji: ${var_app_port}" \
      18 70; then
    return
  fi
  var_hostname=$(whiptail --inputbox "Hostname kontenera" 8 60 "$var_hostname" --title "Ustawienia" 3>&1 1>&2 2>&3) || exit 1
  var_cpu=$(whiptail --inputbox "Liczba rdzeni CPU" 8 60 "$var_cpu" --title "Ustawienia" 3>&1 1>&2 2>&3) || exit 1
  var_ram=$(whiptail --inputbox "RAM (MB)" 8 60 "$var_ram" --title "Ustawienia" 3>&1 1>&2 2>&3) || exit 1
  var_disk=$(whiptail --inputbox "Dysk (GB)" 8 60 "$var_disk" --title "Ustawienia" 3>&1 1>&2 2>&3) || exit 1
  var_bridge=$(whiptail --inputbox "Mostek sieciowy" 8 60 "$var_bridge" --title "Ustawienia" 3>&1 1>&2 2>&3) || exit 1
  local st; st=$(whiptail --inputbox "Magazyn (puste = auto)" 8 60 "$var_storage" --title "Ustawienia" 3>&1 1>&2 2>&3) || exit 1
  var_storage="$st"
}

# ----------------------------------------------------------- szablon LXC ------
ensure_template() {
  local tmpl
  msg_info "Aktualizuję listę szablonów"
  pveam update >/dev/null 2>&1 || true
  msg_ok "Lista szablonów zaktualizowana"

  tmpl=$(pveam available -section system 2>/dev/null | awk '/debian-'"$var_version"'-standard/ {print $2}' | sort -V | tail -n1)
  if [ -z "$tmpl" ]; then msg_err "Nie znaleziono szablonu Debian ${var_version} w pveam."; exit 1; fi

  local tstore; tstore=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1; exit}')
  [ -z "$tstore" ] && tstore="local"

  if ! pveam list "$tstore" 2>/dev/null | grep -q "$tmpl"; then
    msg_info "Pobieram szablon ${tmpl}"
    pveam download "$tstore" "$tmpl" >/dev/null 2>&1
    msg_ok "Szablon pobrany"
  fi
  TEMPLATE_REF="${tstore}:vztmpl/${tmpl}"
}

# --------------------------------------------------------- tworzenie CT -------
create_container() {
  CTID=$(pvesh get /cluster/nextid)
  local storage; storage=$(pick_storage)

  # Zbuduj definicję sieci: DHCP lub statyczny IP (+gateway).
  local net0="name=eth0,bridge=${var_bridge}"
  if [ "$var_ip" = "dhcp" ]; then
    net0="${net0},ip=dhcp"
  else
    net0="${net0},ip=${var_ip}"
    [ -n "$var_gw" ] && net0="${net0},gw=${var_gw}"
  fi
  local ns_opt=(); [ -n "$var_ns" ] && ns_opt=(--nameserver "$var_ns")

  msg_info "Tworzę kontener LXC ${CTID} (${storage})"
  pct create "$CTID" "$TEMPLATE_REF" \
    --hostname "$var_hostname" \
    --cores "$var_cpu" \
    --memory "$var_ram" \
    --swap 512 \
    --rootfs "${storage}:${var_disk}" \
    --net0 "$net0" \
    "${ns_opt[@]}" \
    --unprivileged "$var_unprivileged" \
    --features "keyctl=1,nesting=1" \
    --onboot 1 \
    --ostype debian \
    >/dev/null
  msg_ok "Kontener ${CTID} utworzony"

  msg_info "Uruchamiam kontener ${CTID}"
  pct start "$CTID" >/dev/null
  # Poczekaj na sieć w kontenerze
  local tries=0
  until pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1'; do
    sleep 2; tries=$((tries+1))
    [ "$tries" -gt 60 ] && { msg_err "Brak sieci w kontenerze po 120 s."; exit 1; }
  done
  msg_ok "Kontener uruchomiony, sieć gotowa"
}

# ------------------------------------------------- instalacja w kontenerze ----
push_installer() {
  # Skrypt uruchamiany WEWNĄTRZ kontenera. Generuje sekrety na miejscu i stawia
  # pustą bazę + usługę systemd.
  local IN=/tmp/ar-ct-install.sh
  cat > "$IN" <<CTEOF
#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/adminredminer
APP_PORT="${var_app_port}"
REPO_URL="${AR_REPO_URL}"
REPO_BRANCH="${AR_REPO_BRANCH}"
USE_TARBALL="$( [ -n "$AR_SRC_TARBALL" ] && echo 1 || echo 0 )"

echo "[ct] apt: zależności bazowe"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git build-essential python3 jq >/dev/null

echo "[ct] Node.js 22 LTS (NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null
node -v

echo "[ct] pobieram źródła aplikacji do \$APP_DIR"
rm -rf "\$APP_DIR"; mkdir -p "\$APP_DIR"
if [ "\$USE_TARBALL" = "1" ]; then
  tar -xzf /root/ar-src.tar.gz -C "\$APP_DIR" --strip-components=0
else
  git clone --depth 1 --branch "\$REPO_BRANCH" "\$REPO_URL" "\$APP_DIR"
fi

cd "\$APP_DIR"
echo "[ct] npm ci"
npm ci --no-audit --no-fund
echo "[ct] build (Next.js)"
NEXT_TELEMETRY_DISABLED=1 npm run build

echo "[ct] konfiguracja .env (sekrety generowane lokalnie)"
mkdir -p "\$APP_DIR/data"
IP=\$(hostname -I | awk '{print \$1}')
JWT=\$(openssl rand -base64 48 | tr -d '\n')
SKEY=\$(openssl rand -base64 32 | tr -d '\n')
CRON=\$(openssl rand -base64 32 | tr -d '\n')
cat > "\$APP_DIR/.env" <<ENVEOF
DATABASE_URL=\$APP_DIR/data/ar.db
JWT_SECRET=\$JWT
SETTINGS_KEY=\$SKEY
CRON_SECRET=\$CRON
NODE_ENV=production
PORT=\$APP_PORT
HOSTNAME=0.0.0.0
APP_ORIGIN=http://\$IP:\$APP_PORT
TZ=Europe/Warsaw
NEXT_TELEMETRY_DISABLED=1
ENVEOF
chmod 600 "\$APP_DIR/.env"

echo "[ct] inicjalizacja PUSTEJ bazy SQLite"
set -a; . "\$APP_DIR/.env"; set +a
node "\$APP_DIR/scripts/init-db.js"

echo "[ct] usługa systemd"
cat > /etc/systemd/system/adminredminer.service <<SVCEOF
[Unit]
Description=Admin Redminer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=\$APP_DIR
EnvironmentFile=\$APP_DIR/.env
ExecStartPre=/usr/bin/node \$APP_DIR/scripts/init-db.js
ExecStart=/usr/bin/node \$APP_DIR/node_modules/next/dist/bin/next start -p \$APP_PORT -H 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

echo "[ct] skrypt aktualizacji /usr/bin/update"
cat > /usr/bin/update <<UPDEOF
#!/usr/bin/env bash
set -e
cd /opt/adminredminer
git pull --ff-only || echo "(instalacja z tarballa — pomijam git pull)"
npm ci --no-audit --no-fund
NEXT_TELEMETRY_DISABLED=1 npm run build
systemctl restart adminredminer
echo "Zaktualizowano Admin Redminer."
UPDEOF
chmod +x /usr/bin/update

systemctl daemon-reload
systemctl enable --now adminredminer >/dev/null 2>&1

echo "[ct] czekam na start usługi na porcie \$APP_PORT"
for i in \$(seq 1 30); do
  if curl -fsS "http://127.0.0.1:\$APP_PORT/login" >/dev/null 2>&1; then break; fi
  sleep 2
done
echo "[ct] gotowe. IP=\$IP"
CTEOF

  pct push "$CTID" "$IN" /root/ar-ct-install.sh >/dev/null
  if [ -n "$AR_SRC_TARBALL" ]; then
    msg_info "Wgrywam lokalne źródła (tryb testowy)"
    pct push "$CTID" "$AR_SRC_TARBALL" /root/ar-src.tar.gz >/dev/null
    msg_ok "Źródła wgrane"
  fi
}

run_installer() {
  echo -e " ${YW}Instaluję aplikację w kontenerze (Node, build, pusta baza) — to potrwa kilka minut...${CL}"
  if pct exec "$CTID" -- bash /root/ar-ct-install.sh; then
    msg_ok "Aplikacja zainstalowana"
  else
    msg_err "Instalacja w kontenerze nie powiodła się (zobacz logi wyżej)."
    exit 1
  fi
}

finish() {
  local ip; ip=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
  echo
  echo -e " ${CM} ${GN}Admin Redminer gotowy!${CL}"
  echo -e "    CTID:  ${BL}${CTID}${CL}"
  echo -e "    URL:   ${BL}http://${ip}:${var_app_port}${CL}"
  echo -e "    Pierwsze logowanie: otwórz URL i utwórz konto administratora."
  echo -e "    Aktualizacja: ${BL}pct exec ${CTID} -- update${CL}"
  echo
}

# ------------------------------------------------------------------- main -----
header
require_root_pve
choose_settings
ensure_template
create_container
push_installer
run_installer
finish
