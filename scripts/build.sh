#!/usr/bin/env bash
# Build a release .app + .dmg into src-tauri/target/release/bundle/.
# Usage: ./scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Building Fathom v$(cat VERSION)…"
cd src-tauri
exec cargo tauri build "$@"
