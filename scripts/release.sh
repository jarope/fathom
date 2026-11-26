#!/usr/bin/env bash
# Build a Fathom release: a universal (Apple Silicon + Intel) .app and .dmg,
# the signed update bundle and latest.json for the in-app updater, all in
# dist/v<VERSION>/. With --publish it also tags the commit and creates the
# GitHub release (needs `gh` logged in).
#
# Usage:
#   ./scripts/release.sh             build into dist/
#   ./scripts/release.sh --publish   build, then tag + upload to GitHub
#   ./scripts/release.sh --native    this Mac's architecture only (faster)
#
# Update signing: the private key is ~/.tauri/fathom-updater.key (never in
# the repo) and its password is in the login Keychain as
# "fathom-updater-key". Lose the key and installed copies can't update.
#
# Apple signing: without an Apple Developer ID the app is ad-hoc signed
# (people open it once with right-click → Open, or System Settings → Privacy
# & Security → Open Anyway). Once you have one, set before running:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID  → also notarises
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
REPO="jarope/fathom"
TAP="jarope/homebrew-fathom"

PUBLISH=0; TARGET="universal-apple-darwin"
for a in "$@"; do
  case "$a" in
    --publish) PUBLISH=1 ;;
    --native) TARGET="" ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

VERSION=$(tr -d '[:space:]' < VERSION)
CARGO_V=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
CONF_V=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)
if [[ "$VERSION" != "$CARGO_V" || "$VERSION" != "$CONF_V" ]]; then
  echo "Version mismatch: VERSION=$VERSION Cargo.toml=$CARGO_V tauri.conf.json=$CONF_V" >&2; exit 1
fi
if ! grep -q "^## $VERSION " CHANGELOG.md; then
  echo "CHANGELOG.md has no '## $VERSION — date' section." >&2; exit 1
fi
if [[ $PUBLISH == 1 && -n "$(git status --porcelain)" ]]; then
  echo "Commit your changes before publishing." >&2; exit 1
fi

# ---- update signing key ----
KEY="$HOME/.tauri/fathom-updater.key"
[[ -f "$KEY" ]] || { echo "Missing $KEY (the update signing key)." >&2; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY="$KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s fathom-updater-key -a fathom -w)

# ---- Apple signing: Developer ID if set up, otherwise ad-hoc ----
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
[[ "$APPLE_SIGNING_IDENTITY" == "-" ]] && echo "No Developer ID set: ad-hoc signing (Gatekeeper will ask people to confirm the first open)."

# ---- keep this machine's paths out of the binary ----
# Rust embeds source paths for panic messages; rewrite the local prefixes so
# the release doesn't carry your home folder (username) to everyone.
SYSROOT=$(rustc --print sysroot)
REMAPS=(
  "--remap-path-prefix=$HOME/.cargo/registry/src=/cargo/registry/src"
  "--remap-path-prefix=$HOME/.cargo/git/checkouts=/cargo/git/checkouts"
  "--remap-path-prefix=$SYSROOT/lib/rustlib/src/rust=/rustc/src"
  "--remap-path-prefix=$ROOT=/fathom"
)
export CARGO_ENCODED_RUSTFLAGS
CARGO_ENCODED_RUSTFLAGS=$(IFS=$'\x1f'; echo "${REMAPS[*]}")

echo "Building Fathom v$VERSION (${TARGET:-native})…"
cd src-tauri
ARGS=(build --config '{"bundle":{"createUpdaterArtifacts":true}}')
[[ -n "$TARGET" ]] && ARGS+=(--target "$TARGET")
cargo tauri "${ARGS[@]}"
cd "$ROOT"

BUNDLE="src-tauri/target/${TARGET:+$TARGET/}release/bundle"
DMG=$(ls "$BUNDLE"/dmg/*.dmg | head -1)
TGZ="$BUNDLE/macos/Fathom.app.tar.gz"
[[ -f "$DMG" && -f "$TGZ" && -f "$TGZ.sig" ]] || { echo "Build output missing in $BUNDLE" >&2; exit 1; }

ARCH=${TARGET:+universal}; ARCH=${ARCH:-$(uname -m | sed 's/arm64/aarch64/')}
OUT="dist/v$VERSION"; rm -rf "$OUT"; mkdir -p "$OUT"
cp "$DMG" "$OUT/Fathom_${VERSION}_${ARCH}.dmg"
cp "$TGZ" "$OUT/Fathom_${VERSION}_${ARCH}.app.tar.gz"
cp "$TGZ.sig" "$OUT/Fathom_${VERSION}_${ARCH}.app.tar.gz.sig"

# Release notes = this version's CHANGELOG section.
awk -v v="$VERSION" '$0 ~ "^## "v" " {on=1; next} /^## / && on {exit} on' CHANGELOG.md | sed '/./,$!d' > "$OUT/notes.md"

# latest.json for the updater (both Mac architectures point at the same build
# when it's universal).
SIG=$(cat "$OUT/Fathom_${VERSION}_${ARCH}.app.tar.gz.sig")
URL="https://github.com/$REPO/releases/download/v$VERSION/Fathom_${VERSION}_${ARCH}.app.tar.gz"
python3 - "$OUT" "$VERSION" "$SIG" "$URL" "$ARCH" <<'PY'
import json, sys, datetime, pathlib
out, version, sig, url, arch = sys.argv[1:]
notes = pathlib.Path(out, "notes.md").read_text().strip()
plat = {"signature": sig, "url": url}
platforms = {"darwin-aarch64": plat, "darwin-x86_64": plat} if arch == "universal" else {f"darwin-{arch}": plat}
data = {"version": version, "notes": notes, "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "platforms": platforms}
pathlib.Path(out, "latest.json").write_text(json.dumps(data, indent=2) + "\n")
PY

SHA=$(shasum -a 256 "$OUT/Fathom_${VERSION}_${ARCH}.dmg" | cut -d' ' -f1)
echo "$SHA" > "$OUT/Fathom_${VERSION}_${ARCH}.dmg.sha256"
echo
echo "Built into $OUT:"; ls -1 "$OUT"
echo "DMG sha256: $SHA   (for the Homebrew cask)"

if [[ $PUBLISH == 1 ]]; then
  echo "Publishing v${VERSION} to github.com/${REPO}…"
  git tag -a "v$VERSION" -m "Fathom $VERSION" 2>/dev/null || echo "(tag v$VERSION already exists)"
  git push origin "v$VERSION"
  ASSETS=("$OUT/Fathom_${VERSION}_${ARCH}.dmg" "$OUT/Fathom_${VERSION}_${ARCH}.app.tar.gz"
          "$OUT/Fathom_${VERSION}_${ARCH}.app.tar.gz.sig" "$OUT/latest.json")
  if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    # Already released (e.g. re-run after fixing the notes): refresh it in place.
    echo "(release v$VERSION exists: updating its notes and files)"
    gh release edit "v$VERSION" --repo "$REPO" --notes-file "$OUT/notes.md"
    gh release upload "v$VERSION" --repo "$REPO" --clobber "${ASSETS[@]}"
  else
    gh release create "v$VERSION" --repo "$REPO" --title "Fathom $VERSION" --notes-file "$OUT/notes.md" "${ASSETS[@]}"
  fi
  echo "Done: https://github.com/$REPO/releases/tag/v$VERSION"

  # Homebrew: packaging/homebrew/fathom.rb with this version + checksum, written
  # straight to the tap repo (no clone needed).
  echo "Updating Homebrew tap ${TAP}…"
  CASK=$(sed -e "s/^  version \".*\"/  version \"$VERSION\"/" -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" packaging/homebrew/fathom.rb)
  FILE_SHA=$(gh api "repos/$TAP/contents/Casks/fathom.rb" --jq .sha 2>/dev/null || true)
  if gh api -X PUT "repos/$TAP/contents/Casks/fathom.rb" -f message="Fathom $VERSION" \
       -f content="$(printf '%s\n' "$CASK" | base64)" ${FILE_SHA:+-f sha="$FILE_SHA"} >/dev/null; then
    echo "Homebrew: brew upgrade --cask fathom now gets $VERSION."
  else
    echo "Couldn't update the tap; set version \"$VERSION\", sha256 \"$SHA\" in $TAP by hand." >&2
  fi
fi
