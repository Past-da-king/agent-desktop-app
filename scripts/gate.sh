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
  if [ -n "${GATE_SKIP_SMOKE:-}" ]; then echo "SKIPPED: electron smoke is checked later on a machine with a display"; return 0; fi
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


# A green build of an unchanged tree must not pass: each milestone has to have produced what it was asked to.
need_files() { local f ok=0; for f in "$@"; do [ -s "$f" ] || { echo "MISSING required file: $f"; ok=1; }; done; return $ok; }
need_grep() { grep -rqE "$1" "$2" 2>/dev/null || { echo "MISSING: nothing in $2 matches /$1/ ($3)"; return 1; }; }
need_report() { [ -s "tasks/reports/$1.md" ] && [ "$(wc -c < "tasks/reports/$1.md")" -ge 400 ] || { echo "MISSING: tasks/reports/$1.md (at least 400 bytes, written by the milestone)"; return 1; }; }
deliverables() {
  local R=apps/desktop/src/renderer MN=apps/desktop/src/main rc=0
  need_report "$M" || rc=1
  case "$N" in
    4) need_files $R/shell/Palette.tsx $R/shell/QuickAsk.tsx $R/shell/Rail.tsx $R/shell/Shell.tsx $R/views/Home.tsx $R/views/Chat.tsx $R/views/Tasks.tsx $R/views/Memory.tsx $R/views/Routines.tsx $R/views/Connections.tsx $R/views/Settings.tsx $R/onboarding/SignIn.tsx $R/onboarding/Sync.tsx $R/onboarding/Ai.tsx $R/onboarding/Style.tsx $R/ui/Mascot.tsx $R/bridge/seed.ts || rc=1 ;;
    5) need_grep 'firstSync' $R/onboarding "sync step must call account.firstSync" || rc=1
       need_grep 'checkKey' $R/onboarding "AI step must call settings.checkKey" || rc=1
       need_grep 'setApiKey' $R/onboarding "AI step must call settings.setApiKey" || rc=1
       need_grep 'account\.signIn|\.signIn\(' $R/onboarding "sign-in must call account.signIn" || rc=1 ;;
    6a) need_files $MN/runtime/runner.ts $MN/runtime/prompt.ts $MN/runtime/toolset.ts $MN/tools/memory.ts $MN/tools/tasks.ts $MN/tools/core.ts || rc=1 ;;
    6b) need_grep 'chat\.send' $R "Chat must send through window.agent.chat" || rc=1
        need_grep 'chat\.decide' $R "approval cards must call chat.decide" || rc=1
        need_grep 'chat\.answer' $R "question cards must call chat.answer" || rc=1
        need_grep 'chat\.stop' $R "stop button must call chat.stop" || rc=1 ;;
    7a) need_files $MN/runtime/scheduler.ts || rc=1
        need_grep 'routine_create' $MN "routine tools missing" || rc=1
        need_grep 'routines.*runNow|runNow' $MN "routines.runNow handler missing" || rc=1 ;;
    7b) need_grep 'routines\.runNow' $R "Routines view must call routines.runNow" || rc=1
        need_grep 'data\.remove|\.remove\(' $R/views "views must delete through the bridge" || rc=1
        need_grep 'data\.upsert|\.upsert\(' $R/views "views must save through the bridge" || rc=1 ;;
    8a) need_files $MN/tray.ts $MN/hotkey.ts $MN/tools/files.ts $MN/tools/shell.ts $MN/tools/code.ts || rc=1
        need_grep 'shell_run' $MN "shell tool missing" || rc=1 ;;
    8b) need_grep 'pathsFor' $R "drag-and-drop must resolve paths with files.pathsFor" || rc=1
        need_grep 'grantedFolders' $R/views "Settings must edit granted folders" || rc=1
        need_grep 'quick-window' $R "quick window route missing" || rc=1 ;;
    9a) need_files $MN/browser/browser.ts || rc=1
        need_grep 'browser_open' $MN "browser tools missing" || rc=1
        need_grep 'browser_handoff' $MN "handoff tool missing" || rc=1
        need_grep 'setBounds' $MN "browser.setBounds handler missing" || rc=1 ;;
    9b) need_grep 'setBounds' $R "panel must report its bounds" || rc=1 ;;
    10a) need_files $MN/runtime/helpers.ts || rc=1
        need_grep 'helper_steer' $MN "helper tools missing" || rc=1
        need_grep "'delegate'|\"delegate\"" $MN "delegate tool missing" || rc=1 ;;
    10b) need_grep '[Ss]top all helpers' $R "palette entry missing" || rc=1
        need_grep "kind === 'helper'|kind==='helper'|\"helper\"|'helper'" $R "helper cards missing" || rc=1 ;;
    11) need_files apps/desktop/electron-builder.yml || rc=1 ;;
    12) need_files apps/desktop/src/main/runtime/environment.ts apps/desktop/src/main/runtime/spawn.ts || rc=1
        need_grep 'PATHEXT' apps/desktop/src/main "scan must honour PATHEXT" || rc=1
        need_grep 'taskkill' apps/desktop/src/main "Windows process-tree kill missing" || rc=1
        need_grep 'environment' apps/desktop/src/renderer "UI must show the scan" || rc=1 ;;
  esac
  return $rc
}

# --- always
check "typecheck" npm run typecheck
check "build" npm run build
check "repo rules" node scripts/lint-checks.mjs
check "deliverables" deliverables

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
  12) check "tests" tests_with_min 150
      check "screenshots: screens" shoot screens ;;
  *) echo "unknown milestone $M"; exit 2 ;;
esac

echo
if [ ${#FAILED[@]} -eq 0 ]; then echo "GATE $M PASSED"; exit 0; fi
echo "GATE $M FAILED: ${FAILED[*]}"; exit 1
