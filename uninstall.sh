#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  TCloud uninstaller
#
#  Removes TCloud itself: the boot service and the installed app folder
#  (with its local database under data/). It does NOT touch Telegram — your
#  files stay safe in your storage channel.
#
#  Usage (from the installed folder, e.g. /opt/tcloud):
#     sudo bash /opt/tcloud/uninstall.sh
#  Non-interactive:
#     sudo bash /opt/tcloud/uninstall.sh --yes
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE="tcloud"
ASSUME_YES=0
KEEP_DATA=0
for a in "$@"; do
  case "$a" in
    -y|--yes) ASSUME_YES=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    -h|--help) echo "Usage: uninstall.sh [--yes] [--keep-data]"; exit 0 ;;
  esac
done

# The directory this script lives in = the install dir (fallback to /opt/tcloud).
SELF="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
APP_DIR="$SELF"
[ -f "$APP_DIR/package.json" ] || APP_DIR="/opt/tcloud"

c_dim=$'\033[2m'; c_b=$'\033[1m'; c_red=$'\033[1;31m'; c_grn=$'\033[1;32m'; c_x=$'\033[0m'
say()  { printf "  %s\n" "$*"; }
ok()   { printf "  ${c_grn}✓${c_x} %s\n" "$*"; }
warn() { printf "  ${c_red}!${c_x} %s\n" "$*"; }

printf "\n  ${c_b}☁  TCloud — uninstall${c_x}\n\n"
say "${c_dim}App folder:${c_x} $APP_DIR"
echo

# Re-exec with sudo if we need privileges (systemd / removing a root-owned folder).
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}.service" || [ ! -w "$APP_DIR" ]; then
    say "Some steps need root — re-running with sudo…"
    exec sudo bash "$0" "$@"
  fi
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  warn "This removes the TCloud service and the folder ${c_b}$APP_DIR${c_x}"
  warn "(including its local ${c_b}data/${c_x} index). Your files on Telegram are NOT deleted."
  printf "\n  Type ${c_b}yes${c_x} to continue: "
  read -r reply
  [ "$reply" = "yes" ] || { echo; say "Aborted. Nothing was removed."; exit 0; }
  echo
fi

# ── 1. systemd service ────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}.service"; then
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE}.service"
  systemctl daemon-reload 2>/dev/null || true
  ok "Removed systemd service '${SERVICE}'."
fi

# ── 2. pm2 ────────────────────────────────────────────────────────────────────
if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "$SERVICE"; then
  pm2 delete "$SERVICE" >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  ok "Removed pm2 process '${SERVICE}'."
fi

# ── 3. start.sh restart loop (non-root installs) ──────────────────────────────
# Best-effort: kill any node process started from this app folder.
if command -v pkill >/dev/null 2>&1; then
  pkill -f "$APP_DIR/src/index.js" 2>/dev/null || true
fi

# ── 4. remove the app folder ──────────────────────────────────────────────────
if [ "$KEEP_DATA" -eq 1 ]; then
  say "Keeping your data: only the app code is removed."
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'data' ! -name '.env' -exec rm -rf {} + 2>/dev/null || true
  ok "App code removed; kept $APP_DIR/data and $APP_DIR/.env"
elif [ -d "$APP_DIR" ] && [ "$APP_DIR" != "/" ]; then
  rm -rf "$APP_DIR"
  ok "Removed $APP_DIR"
fi

cat <<EOF

  ${c_grn}TCloud has been uninstalled.${c_x}

  Your files were never deleted — they are still in your Telegram channel.
  To remove them too, delete that channel. To retire the bot, message
  @BotFather and send /deletebot.

EOF
