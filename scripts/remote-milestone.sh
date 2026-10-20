#!/usr/bin/env bash
# Runs on the build server inside ~/aw/<id> (a plain copy of the worktree, no git). Does what do_one does locally:
# install, one agent session, then the gate (up to 3 fix rounds). Writes .remote-result = PASSED or FAILED.
set -uo pipefail
ID="${1:?milestone id}"
export PATH="$HOME/node24/bin:$HOME/.opencode/bin:$PATH"
export GATE_SKIP_SMOKE=1
cd "$HOME/aw/$ID"
rm -f .remote-result
MODEL="${REMOTE_MODEL:-opencode/deepseek-v4.1-flash-free}"   # the server's paid key expired; the free tier serves the same model
echo "[remote] node $(node -v), opencode $(opencode --version)"
npm install --no-audit --no-fund >.install.log 2>&1 || { echo "[remote] npm install failed"; tail -20 .install.log; echo FAILED >.remote-result; exit 1; }
prompt="You are implementing milestone $ID of the Agent desktop app in this folder (a copy of a git worktree; other milestones are being built elsewhere in parallel, so stay inside this folder). There is NO git here: do not run any git command and skip the commit step in AGENTS.md; the runner commits afterwards. Read AGENTS.md, PLAN.md and tasks/$ID.md completely first, then implement it exactly as written. Work step by step and run npm run typecheck as you go. When done, run: bash scripts/gate.sh $ID  and keep fixing until it prints GATE $ID PASSED. Then write tasks/reports/$ID.md. Do not touch scripts/ or any tasks/*.md file (except your own report)."
timeout 3h opencode run -m "$MODEL" --auto --dir "$PWD" --title "$ID" "$prompt"
for attempt in 1 2 3; do
  bash scripts/gate.sh "$ID" >".gate$attempt.log" 2>&1
  if tail -n 3 ".gate$attempt.log" | grep -q "GATE $ID PASSED"; then echo PASSED >.remote-result; echo "[remote] $ID gate passed"; exit 0; fi
  echo "[remote] $ID gate failed (attempt $attempt)"
  [ "$attempt" -eq 3 ] && break
  timeout 2h opencode run -m "$MODEL" --auto --dir "$PWD" -c "The gate for $ID failed when I ran it. End of its output:

$(tail -n 60 ".gate$attempt.log")

Fix the causes (not the gate), rerun bash scripts/gate.sh $ID until it prints GATE $ID PASSED, update tasks/reports/$ID.md. There is no git here; do not commit."
done
tail -n 40 ".gate3.log"
echo FAILED >.remote-result
exit 1
