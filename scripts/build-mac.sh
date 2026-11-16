#!/usr/bin/env bash
# Build the macOS disk images.
#
#   bash scripts/build-mac.sh            # this Mac's CPU only
#   bash scripts/build-mac.sh arm64      # Apple silicon
#   bash scripts/build-mac.sh x64        # Intel
#   bash scripts/build-mac.sh all        # both
#
# Output: release/4RouterAi-<version>-mac-<arch>.dmg
#
# The bundled Node runtime and the Claude Code / Codex native binaries are
# CPU-specific, so each architecture gets its own bundle and its own DMG
# (no universal build). Without a Developer ID certificate the app is ad-hoc
# signed (scripts/mac-adhoc-sign.cjs); set CSC_LINK / CSC_KEY_PASSWORD (and
# APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to notarize) for a
# distributable build.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: macOS builds must run on macOS" >&2
    exit 1
fi

host_arch="$(uname -m)"
[[ "$host_arch" == "x86_64" ]] && host_arch="x64"

requested="${1:-$host_arch}"
case "$requested" in
    all)   arches=() ;;
    arm64|x64) arches=("$requested") ;;
    *) echo "usage: $0 [arm64|x64|all]" >&2; exit 2 ;;
esac
if [[ "$requested" == "all" ]]; then
    # Host arch last, so resources/bundled-tools is left runnable on this Mac
    # for `npm start` afterwards.
    for arch in arm64 x64; do
        [[ "$arch" != "$host_arch" ]] && arches+=("$arch")
    done
    arches+=("$host_arch")
fi

echo "==> Compiling (main + renderer)"
npm run build

for arch in "${arches[@]}"; do
    echo "==> Bundling Node runtime and CLI tools for darwin-$arch"
    TARGET_ARCH="$arch" node scripts/bundle-tools.mjs

    echo "==> Packaging DMG for $arch"
    npx electron-builder --mac dmg "--$arch" --publish never
done

echo
echo "Done:"
ls -lh release/*.dmg
