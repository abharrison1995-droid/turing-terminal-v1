#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cd "$ROOT"
npm run build
mkdir -p "$STAGE/app"
cp package.json package-lock.json "$STAGE/app/"
cp -R dist dist-server migrations "$STAGE/app/"
mkdir -p "$STAGE/app/packaging"
cp -R packaging/linux "$STAGE/app/packaging/linux"
npm ci --omit=dev --prefix "$STAGE/app" --no-audit --no-fund
tar -C "$STAGE/app" -czf "$ROOT/turing-terminal-linux-x64-v${VERSION}.tar.gz" .
printf 'Created %s\n' "$ROOT/turing-terminal-linux-x64-v${VERSION}.tar.gz"
