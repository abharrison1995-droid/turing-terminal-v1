#!/usr/bin/env bash
set -euo pipefail

DEB="$(realpath "$1")"
APPIMAGE="$(realpath "$2")"
for port in $(seq 4317 4348); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Smoke-test port $port is already occupied; refusing to contact an existing local service." >&2
    exit 1
  fi
done
sudo apt-get install -y "$DEB"
installed=true
cleanup_package() {
  if [[ "${installed:-false}" == true ]]; then
    sudo apt-get remove -y turing-terminal >/dev/null || true
  fi
}
trap cleanup_package EXIT
test -x /usr/bin/turing-terminal
chmod +x "$APPIMAGE"

smoke_launcher() {
  local mode="$1"
  local launcher="$2"
  xvfb-run --auto-servernum bash -euo pipefail -c '
    mode="$1"
    launcher="$2"
    work="$(mktemp -d /tmp/turing-terminal-smoke.XXXXXX)"
    export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" XDG_STATE_HOME="$work/state" XDG_CACHE_HOME="$work/cache"
    descendants() {
      local child
      for child in $(pgrep -P "$1" || true); do
        printf "%s\n" "$child"
        descendants "$child"
      done
    }
    if [[ "$mode" == "appimage" ]]; then
      APPIMAGE_EXTRACT_AND_RUN=1 "$launcher" --background >"$work/app.log" 2>&1 &
    else
      "$launcher" --background >"$work/app.log" 2>&1 &
    fi
    shell_pid=$!
    cleanup() {
      descendants "$shell_pid" | tac | while read -r pid; do kill "$pid" 2>/dev/null || true; done
      kill "$shell_pid" 2>/dev/null || true
      wait "$shell_pid" 2>/dev/null || true
      rm -rf "$work"
    }
    trap cleanup EXIT
    ready=false
    for _ in $(seq 1 40); do
      if curl --fail --silent http://127.0.0.1:4317/api/health >"$work/health.json"; then
        ready=true
        break
      fi
      sleep 1
    done
    test "$ready" = true
    grep -q "turing-terminal" "$work/health.json"
    grep -q "1.0.0-rc1" "$work/health.json"
    curl --fail --silent http://127.0.0.1:4317/manifest.webmanifest | grep -q "Turing Terminal"
    curl --fail --silent http://127.0.0.1:4317/ | grep -q "/assets/index-"
  ' _ "$mode" "$launcher"
}

smoke_launcher deb /usr/bin/turing-terminal
smoke_launcher appimage "$APPIMAGE"
sudo apt-get remove -y turing-terminal
installed=false
trap - EXIT
echo 'Linux .deb and AppImage smoke checks passed (Master health and PWA manifest).'
