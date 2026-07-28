#!/usr/bin/env bash
# Launch Fathom in a native dev window with live reload.
# Usage: ./scripts/dev.sh
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
exec cargo tauri dev "$@"
