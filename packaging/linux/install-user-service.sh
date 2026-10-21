#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/turing-terminal-linux-x64-v1.0.0.tar.gz" >&2
  exit 2
fi

ARCHIVE="$(realpath "$1")"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required. Install Node.js 22 LTS, then rerun this installer." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22 or newer is required; found $("$NODE_BIN" --version)." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "A running per-user systemd session is required for unattended startup." >&2
  exit 1
fi

APP_DIR="$HOME/.local/share/turing-terminal"
DATA_DIR="$HOME/.local/share/turing-terminal-data"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$APP_DIR" "$DATA_DIR" "$UNIT_DIR"
chmod 700 "$DATA_DIR"
tar -xzf "$ARCHIVE" -C "$APP_DIR"
chmod 700 "$APP_DIR/packaging/linux/install-user-service.sh"
sed \
  -e "s|@APP_DIR@|$APP_DIR|g" \
  -e "s|@DATA_DIR@|$DATA_DIR|g" \
  -e "s|@NODE_BIN@|$NODE_BIN|g" \
  "$APP_DIR/packaging/linux/turing-terminal.service.in" > "$UNIT_DIR/turing-terminal.service"
chmod 600 "$UNIT_DIR/turing-terminal.service"
systemctl --user daemon-reload
systemctl --user enable turing-terminal.service
systemctl --user restart turing-terminal.service
printf 'Installed and started the Turing Terminal user service. Local UI/API: http://127.0.0.1:4317\n'
printf 'Service status: systemctl --user status turing-terminal.service\n'
