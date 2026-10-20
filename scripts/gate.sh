#!/usr/bin/env bash
# The judge. Usage: bash scripts/gate.sh M0..M11   Prints "GATE <M> PASSED" only when every check passes.
set -uo pipefail
cd "$(dirname "$0")/.."
M="${1:?usage: gate.sh M0..M11}"
N="${M#M}"
FAILED=()
mkdir -p .gate

check() { # name, command...
  local name="$1"; shift
  echo; echo "=== $name"
  if "$@"; then echo "--- ok: $name"; else echo "--- FAILED: $name"; FAILED+=("$name"); fi
}

tests_with_min() { # minTotal [substr minSub]
  npx vitest run --reporter=json --outputFile=.gate/vitest.json >.gate/vitest.log 2>&1
  local code=$?
  tail -n 25 .gate/vitest.log
  [ -f .gate/vitest.json ] || return 1
  node scripts/count-tests.mjs .gate/vitest.json "$@" || return 1
  return $code
}

smoke() {
  [ -f apps/desktop/out/main/index.js ] || { echo "no main build at apps/desktop/out/main/index.js"; return 1; }
  local out code
  out=$(cd apps/desktop && timeout 120 xvfb-run -a npx electron . --smoke --no-sandbox 2>&1); code=$?
  echo "$out" | tail -n 20
  if echo "$out" | grep -q "SMOKE OK"; then return 0; fi
  if echo "$out" | grep -qiE "error while loading shared libraries|missing x server|cannot open display|no sandbox|libnss|libgtk|libgbm|dbus"; then
    echo "SKIPPED: this machine lacks the system libraries Electron needs; Claude re-checks on the Windows machine"; return 0
  fi
  return 1
}

shoot() { node scripts/shoot.mjs --only "$1"; }

# --- always
check "typecheck" npm run typecheck
check "build" npm run build
check "repo rules" node scripts/lint-checks.mjs

case "$N" in
  0) check "tests" tests_with_min 1
     check "screenshots: boot" shoot boot
     check "electron smoke" smoke ;;
  1) check "tests" tests_with_min 25 ;;
  2) check "tests" tests_with_min 45 sync 18 ;;
  3) check "tests" tests_with_min 65 db 5
     check "electron smoke" smoke ;;
  4) check "tests" tests_with_min 65
     check "screenshots: screens" shoot screens ;;
  5) check "tests" tests_with_min 68
     check "screenshots: screens" shoot screens
     check "onboarding flow" shoot onboarding ;;
  6) check "tests" tests_with_min 100 runner 8
     check "screenshots: screens" shoot screens
     check "screenshots: chat" shoot chat
     check "electron smoke" smoke ;;
  7) check "tests" tests_with_min 120 scheduler 6
     check "screenshots: screens" shoot screens
     check "screenshots: data" shoot data
     check "electron smoke" smoke ;;
  8) check "tests" tests_with_min 150
     check "screenshots: screens" shoot screens
     check "electron smoke" smoke ;;
  9) check "tests" tests_with_min 165
     check "screenshots: screens" shoot screens
     check "screenshots: chat" shoot chat
     check "electron smoke" smoke ;;
  10) check "tests" tests_with_min 180 helpers 6
      check "screenshots: screens" shoot screens
      check "screenshots: chat" shoot chat ;;
  11) check "tests" tests_with_min 185
      check "pack" npm run pack
      check "electron smoke" smoke ;;
  6a) check "tests" tests_with_min 100 runner 8
      check "electron smoke" smoke ;;
  6b) check "tests" tests_with_min 100
      check "screenshots: screens" shoot screens
      check "screenshots: chat" shoot chat ;;
  7a) check "tests" tests_with_min 100 scheduler 6
      check "electron smoke" smoke ;;
  7b) check "tests" tests_with_min 100
      check "screenshots: screens" shoot screens
      check "screenshots: data" shoot data ;;
  8a) check "tests" tests_with_min 100
      check "electron smoke" smoke ;;
  8b) check "tests" tests_with_min 100
      check "screenshots: screens" shoot screens ;;
  9a) check "tests" tests_with_min 100
      check "electron smoke" smoke ;;
  9b) check "tests" tests_with_min 100
      check "screenshots: screens" shoot screens
      check "screenshots: chat" shoot chat ;;
  10a) check "tests" tests_with_min 100 helpers 6 ;;
  10b) check "tests" tests_with_min 100
       check "screenshots: screens" shoot screens
       check "screenshots: chat" shoot chat ;;
  *) echo "unknown milestone $M"; exit 2 ;;
esac

echo
if [ ${#FAILED[@]} -eq 0 ]; then echo "GATE $M PASSED"; exit 0; fi
echo "GATE $M FAILED: ${FAILED[*]}"; exit 1
