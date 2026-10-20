#!/usr/bin/env bash
# Parallel DAG runner for the milestones. Each milestone gets its own git worktree and branch, starts from the merge of its
# dependencies' tags, is built by DeepSeek V4.1 Flash (OpenCode), judged by scripts/gate.sh (run by us, not trusted from the agent),
# and tagged done-<id> when green. At most SLOTS agents work at once.
#
# Usage: bash scripts/orchestrate.sh            (runs everything not yet tagged)
# Env:   SLOTS=3 (local agents)  RSLOTS=3 (agents on the build server)  REMOTE_IDS="M8a M9a ..." (milestones built on the server)
#        ATTACH="M4:1234 M7a:5678" (agents already running locally: wait for the pid, then gate)
#        BUILD_HOST=impetix (ssh alias of the build server)
set -uo pipefail
REPO=/home/you/agent-desktop-app
WT=/home/you/agent-desktop-wt
MODEL="opencode-go/deepseek-v4.1-flash"
SLOTS="${SLOTS:-3}"
RSLOTS="${RSLOTS:-3}"
REMOTE_IDS=" ${REMOTE_IDS:-} "
ATTACH=" ${ATTACH:-} "
BUILD_HOST="${BUILD_HOST:-impetix}"
cd "$REPO"
mkdir -p logs "$WT"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a logs/progress.log; }
tagged() { git rev-parse -q --verify "refs/tags/done-$1" >/dev/null; }

with_slot() { # pool(local|remote) command... : holds one lock of the pool while running the command
  local pool="$1" n="$SLOTS"; shift
  [ "$pool" = remote ] && n="$RSLOTS"
  while true; do
    for i in $(seq 1 "$n"); do
      exec {fd}>"$REPO/logs/slot-$pool-$i.lock"
      if flock -n "$fd"; then
        "$@"; local rc=$?
        exec {fd}>&-
        return $rc
      fi
      exec {fd}>&-
    done
    sleep 15
  done
}

agent() { # dir, session-title, prompt  (fresh session)
  (cd "$1" && timeout 3h opencode run -m "$MODEL" --auto --dir "$1" --title "$2" "$3")
}
agent_continue() { # dir, prompt
  (cd "$1" && timeout 2h opencode run -m "$MODEL" --auto --dir "$1" -c "$2")
}

resolve_conflicts() { # dir, what
  local dir="$1"
  [ -z "$(git -C "$dir" diff --name-only --diff-filter=U)" ] && return 0
  log "merge conflicts in $dir: asking the agent to resolve"
  agent "$dir" "merge" "A git merge in this repository stopped with conflicts (run git status). Resolve every conflict by keeping BOTH sides' intent (most conflicts are two milestones each adding a line to the same registry or list: keep both lines). Then run npm run typecheck, git add -A and git commit --no-edit. Do not change anything else." >"$REPO/logs/merge-$(basename "$dir").log" 2>&1
  [ -z "$(git -C "$dir" diff --name-only --diff-filter=U)" ] && ! git -C "$dir" rev-parse -q --verify MERGE_HEAD >/dev/null
}

attach_pid() { for kv in $ATTACH; do [ "${kv%%:*}" = "$1" ] && echo "${kv#*:}"; done; }

prepare() { # id dir branch deps... : worktree + merges (no install)
  local id="$1" dir="$2" branch="$3"; shift 3
  if [ ! -d "$dir" ]; then
    git worktree add -B "$branch" "$dir" "refs/tags/base" >/dev/null 2>&1 || { log "FAILED $id: cannot create worktree"; touch "logs/FAILED-$id"; return 1; }
  fi
  local d
  for d in "$@"; do
    if ! git -C "$dir" merge-base --is-ancestor "refs/tags/done-$d" HEAD 2>/dev/null; then
      git -C "$dir" merge --no-edit "refs/tags/done-$d" >/dev/null 2>&1 || resolve_conflicts "$dir" || { log "FAILED $id: unresolved merge of $d"; touch "logs/FAILED-$id"; return 1; }
    fi
  done
}

remote_one() { # id dir branch deps... : build on the server, bring the result back, commit, tag
  local id="$1" dir="$2" branch="$3"; shift 3
  prepare "$id" "$dir" "$branch" "$@" || return 1
  log "$id: starting on $BUILD_HOST"
  # the server has no rsync: a tar stream over ssh does the same job
  local ex="--exclude=node_modules --exclude=out --exclude=.git --exclude=shots --exclude=.gate --exclude=.remote-result"
  tar -C "$dir" $ex -czf - . | ssh "$BUILD_HOST" "mkdir -p ~/aw/$id && tar -xzf - -C ~/aw/$id" || { log "FAILED $id: copy to $BUILD_HOST"; touch "logs/FAILED-$id"; return 1; }
  tar -C "$REPO" -czf - scripts | ssh "$BUILD_HOST" "tar -xzf - -C ~/aw/$id"   # always the current judge scripts
  ssh "$BUILD_HOST" "bash ~/aw/$id/scripts/remote-milestone.sh $id" >"$REPO/logs/$id.remote.log" 2>&1
  ssh "$BUILD_HOST" "cd ~/aw/$id && tar $ex --exclude=scripts --exclude='.*.log' -czf - ." | tar -xzf - -C "$dir" || { log "FAILED $id: copy back"; touch "logs/FAILED-$id"; return 1; }
  if [ "$(ssh "$BUILD_HOST" "cat ~/aw/$id/.remote-result 2>/dev/null")" != "PASSED" ]; then log "STOPPED at $id: the gate never passed on $BUILD_HOST"; touch "logs/FAILED-$id"; return 1; fi
  rm -f "$dir/.remote-result"
  git -C "$dir" add -A && git -C "$dir" commit -q -m "$id: implemented (built on the build server)"
  git tag -f "done-$id" "$(git -C "$dir" rev-parse HEAD)" >/dev/null
  log "$id PASSED"
}

do_one() { # id, dir, branch, deps...
  local id="$1" dir="$2" branch="$3"; shift 3
  local deps=("$@")
  if [ "$id" != "M4" ]; then
    prepare "$id" "$dir" "$branch" "${deps[@]}" || return 1
    (cd "$dir" && npm install --no-audit --no-fund >"$REPO/logs/$id.install.log" 2>&1) || { log "FAILED $id: npm install"; touch "logs/FAILED-$id"; return 1; }
  fi
  local brief="tasks/$id.md"
  local prompt="You are implementing milestone $id of the Agent desktop app in this repository (a git worktree; other milestones are being built in parallel in other worktrees, so stay inside this folder). Read AGENTS.md, PLAN.md and $brief completely first, then implement it exactly as written. Work step by step and run npm run typecheck as you go. When done, run: bash scripts/gate.sh $id  and keep fixing until it prints GATE $id PASSED. Then commit as AGENTS.md says and write tasks/reports/$id.md. Do not touch scripts/ or any tasks/*.md file (except your own report)."
  local apid; apid="$(attach_pid "$id")"
  if [ -n "$apid" ]; then
    log "$id: waiting for the running agent (pid $apid)"
    while kill -0 "$apid" 2>/dev/null; do sleep 20; done
  else
    log "$id: starting"
    agent "$dir" "$id" "$prompt" >"$REPO/logs/$id.run1.log" 2>&1
  fi
  local ok=0 attempt
  for attempt in 1 2 3; do
    (cd "$dir" && bash scripts/gate.sh "$id") >"$REPO/logs/$id.gate$attempt.log" 2>&1
    if tail -n 3 "$REPO/logs/$id.gate$attempt.log" | grep -q "GATE $id PASSED"; then ok=1; break; fi
    log "$id: gate failed (attempt $attempt)"
    [ "$attempt" -eq 3 ] && break
    agent_continue "$dir" "The gate for $id failed when I ran it. End of its output:

$(tail -n 60 "$REPO/logs/$id.gate$attempt.log")

Fix the causes (not the gate), rerun bash scripts/gate.sh $id until it prints GATE $id PASSED, then commit and update tasks/reports/$id.md." >"$REPO/logs/$id.fix$attempt.log" 2>&1
  done
  if [ "$ok" -ne 1 ]; then log "STOPPED at $id: the gate never passed"; touch "logs/FAILED-$id"; return 1; fi
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then git -C "$dir" add -A && git -C "$dir" commit -q -m "$id: finish (committed by runner)"; fi
  git tag -f "done-$id" "$(git -C "$dir" rev-parse HEAD)" >/dev/null
  log "$id PASSED"
}

run_node() { # id deps...   (runs in the background as one DAG node)
  local id="$1"; shift
  local deps=("$@")
  tagged "$id" && return 0
  local d
  for d in "${deps[@]}"; do
    until tagged "$d"; do
      if [ -e "logs/FAILED-$d" ]; then log "$id: skipped, dependency $d failed"; touch "logs/FAILED-$id"; return 1; fi
      sleep 20
    done
  done
  local dir="$WT/$id" branch="t-$id"
  [ "$id" = "M4" ] && dir="$REPO" && branch="main"
  if [[ "$REMOTE_IDS" == *" $id "* ]]; then with_slot remote remote_one "$id" "$dir" "$branch" "${deps[@]}"
  else with_slot local do_one "$id" "$dir" "$branch" "${deps[@]}"; fi
}

# base: the commit every worktree starts from (has the briefs and scripts, plus M3)
git tag -f base HEAD >/dev/null

# attached (already running) agents claim their slots first
run_node M4 M3 &
run_node M6a M3 &
run_node M11 M3 &
run_node M7a M6a &
run_node M10a M6a &
sleep 8
run_node M5 M4 &
run_node M6b M4 M6a &
run_node M7b M4 M6a &
run_node M8a M6a &
run_node M8b M4 M8a &
run_node M9a M6a &
run_node M9b M6b M9a &
run_node M10b M6b M10a &
wait

# integration: merge every finished tip into main, one after another, agent resolves conflicts
for id in M5 M6b M7a M7b M8b M9b M10b M11; do
  tagged "$id" || { log "integration: $id not finished, skipping"; continue; }
  if ! git merge-base --is-ancestor "refs/tags/done-$id" HEAD; then
    git merge --no-edit "refs/tags/done-$id" >/dev/null 2>&1 || resolve_conflicts "$REPO" || { log "STOPPED: integration of $id has unresolved conflicts"; exit 1; }
  fi
done
log "orchestration finished"
