#!/usr/bin/env bash
# Generate the non-sensitive release marker (VERSION) and build the
# production Bun bundle into dist/.
#
# Resolution order for the marker:
#   1. $BUILD_MARKER (explicit), e.g. BUILD_MARKER=v1.2.3
#   2. latest git short SHA at the checkout
#   3. current UTC date as a fallback
#
# The marker is intentionally not secret; database paths and environment
# values stay out of the bundle and out of the repository.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/VERSION"

if [ -n "${BUILD_MARKER:-}" ]; then
  MARKER="$BUILD_MARKER"
elif sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"; then
  MARKER="$sha"
else
  MARKER="build-$(date -u +%Y%m%d-%H%M%S)"
fi

printf '%s\n' "$MARKER" > "$OUT"
printf 'VERSION = %s\n' "$MARKER"

printf 'bundling production server -> dist/server.js\n'
bun build "$ROOT/src/index.ts" --target bun --outfile "$ROOT/dist/server.js"


printf 'bundle complete\n'