#!/usr/bin/env bash
# Runs DeepSeek V4.1 Flash (OpenCode) over the milestones in order. Usage: bash scripts/run-milestones.sh [FROM] [TO]   e.g. M0 M11
# For each milestone: one fresh agent session, then the gate is run independently (the agent's own claim is not trusted);
# on failure the SAME session is continued with the gate output, up to 3 times. Stops at the first milestone it cannot get green.
set -uo pipefail
cd "$(dirname "$0")/.."
FROM="${1:-M0}"; TO="${2:-M11}"
MODEL="opencode-go/deepseek-v4.1-flash"
mkdir -p logs tasks/reports
first="${FROM#M}"; last="${TO#M}"

for n in $(seq "$first" "$last"); do
  M="M$n"
  if git rev-parse -q --verify "refs/tags/done-$M" >/dev/null; then echo "$M already done, skipping"; continue; fi
  echo "[$(date +%H:%M:%S)] starting $M"
  prompt="You are implementing milestone $M of the Agent desktop app in this repository. Read AGENTS.md, PLAN.md and tasks/$M.md completely first, then implement the milestone exactly as written. Work step by step and run npm run typecheck as you go. When done, run: bash scripts/gate.sh $M  and keep fixing until it prints GATE $M PASSED. Then commit as AGENTS.md says and write tasks/reports/$M.md. Do not touch scripts/ or tasks/ (except your report)."
  timeout 3h opencode run -m "$MODEL" --auto --dir "$PWD" --title "$M" "$prompt" >"logs/$M.run1.log" 2>&1
  ok=0
  for attempt in 1 2 3; do
    bash scripts/gate.sh "$M" >"logs/$M.gate$attempt.log" 2>&1
    if tail -n 3 "logs/$M.gate$attempt.log" | grep -q "GATE $M PASSED"; then ok=1; break; fi
    echo "[$(date +%H:%M:%S)] $M gate failed (attempt $attempt)"
    [ "$attempt" -eq 3 ] && break
    fix="The gate for $M failed when I ran it. Here is the end of its output:

$(tail -n 60 "logs/$M.gate$attempt.log")

Fix the causes (not the gate), rerun bash scripts/gate.sh $M until it prints GATE $M PASSED, then commit and update tasks/reports/$M.md."
    timeout 2h opencode run -m "$MODEL" --auto --dir "$PWD" -c "$fix" >"logs/$M.fix$attempt.log" 2>&1
  done
  if [ "$ok" -ne 1 ]; then echo "[$(date +%H:%M:%S)] STOPPED at $M: gate never passed" | tee logs/STOPPED; exit 1; fi
  # make sure the work is committed even if the agent forgot; plain message, no attribution
  if [ -n "$(git status --porcelain)" ]; then git add -A && git commit -q -m "$M: finish (committed by runner)"; fi
  git tag -f "done-$M" >/dev/null
  echo "[$(date +%H:%M:%S)] $M PASSED" | tee -a logs/progress.log
done
echo "[$(date +%H:%M:%S)] all milestones from $FROM to $TO passed" | tee -a logs/progress.log
