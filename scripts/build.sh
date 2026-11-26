#!/usr/bin/env bash
# Build a release .app + .dmg into src-tauri/target/release/bundle/.
# Usage: ./scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
# Keep this machine's paths (home folder / username) out of the binary's
# panic messages — same remaps as release.sh.
SYSROOT=$(rustc --print sysroot)
REMAPS=(
  "--remap-path-prefix=$HOME/.cargo/registry/src=/cargo/registry/src"
  "--remap-path-prefix=$HOME/.cargo/git/checkouts=/cargo/git/checkouts"
  "--remap-path-prefix=$SYSROOT/lib/rustlib/src/rust=/rustc/src"
  "--remap-path-prefix=$ROOT=/fathom"
)
export CARGO_ENCODED_RUSTFLAGS
CARGO_ENCODED_RUSTFLAGS=$(IFS=$'\x1f'; echo "${REMAPS[*]}")
echo "Building Fathom v$(cat VERSION)…"
cd src-tauri
exec cargo tauri build "$@"
