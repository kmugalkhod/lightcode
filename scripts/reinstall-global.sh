#!/usr/bin/env bash
#
# Reinstall the global `lightcode` CLI from the locally built tarball.
#
#   bash scripts/reinstall-global.sh          # reinstall the newest existing tarball
#   bash scripts/reinstall-global.sh --build  # rebuild dist + pack a fresh tarball first
#
# `sudo` is used because the npm global prefix (/usr/local) needs root — it will
# prompt for your password once.
set -euo pipefail

PKG="@kmugalkhod/lightcode"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ "${1:-}" = "--build" ]; then
  echo "==> Building fresh tarball"
  bun scripts/build-dist.ts
  npm pack ./dist --pack-destination dist >/dev/null
fi

TARBALL="$(ls -t "$REPO_DIR"/dist/kmugalkhod-lightcode-*.tgz 2>/dev/null | head -1 || true)"
if [ -z "$TARBALL" ]; then
  echo "No tarball found. Build one first:"
  echo "  bash scripts/reinstall-global.sh --build"
  exit 1
fi

echo "==> Reinstalling $PKG"
echo "    tarball: $TARBALL"

# Uninstall the previous global (ignore if it isn't installed yet).
sudo npm uninstall -g "$PKG" >/dev/null 2>&1 || true

# Install the freshly built tarball.
sudo npm install -g "$TARBALL"

echo "==> Done. Installed: $(lightcode --version 2>/dev/null || echo 'unknown')"
echo "    Run: lightcode"
