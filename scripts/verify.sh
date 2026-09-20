#!/usr/bin/env bash
# Full verification for the Bun taskboard fixture:
#
#   1. scripts/build.sh -> release marker (VERSION) + production bundle dist/
#   2. clean install -> rm -rf node_modules && bun install --frozen-lockfile
#   3. tsc --noEmit typecheck (strict)
#   4. bun test (unit/integration suite)
#   5. scripts/smoke.sh -> real production process: CRUD, invalid input,
#      search/filter, restart persistence, database-unavailable readiness
#
# Usage:
#   scripts/verify.sh
#
# Exit codes: 0 = all checks passed, nonzero = a check failed. The first
# failing step aborts with its own nonzero code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN:-$(command -v bun)}"
[ -x "$BUN" ] || { echo "bun executable not found" >&2; exit 1; }

step() { printf '\n=== %s ===\n' "$*"; }

step "build release marker + production bundle"
"$ROOT/scripts/build.sh"

step "clean install with frozen lockfile"
rm -rf "$ROOT/node_modules"
(cd "$ROOT" && "$BUN" install --frozen-lockfile)

step "strict typecheck (tsc --noEmit)"
(cd "$ROOT" && "$BUN" run typecheck)

step "client bundle syntax check"
(cd "$ROOT" && "$BUN" build public/app.js --target browser --outdir "$ROOT/dist/client-check" >/dev/null \
  && rm -rf "$ROOT/dist/client-check")

step "test suite (bun test)"
(cd "$ROOT" && "$BUN" test)

step "production smoke: real process + CRUD + negatives + persistence + readiness"
"$ROOT/scripts/smoke.sh"

step "verification complete (all steps passed)"
printf '%s\n' "bun: $("$BUN" --version)"
printf '%s\n' "node_modules installed: $([ -d "$ROOT/node_modules" ] && echo yes || echo no)"
printf '%s\n' "release marker: $(cat "$ROOT/VERSION")"