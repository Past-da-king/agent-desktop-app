# Common brief for every "devices" helper (read first)

You are one of several helpers building "One agent across all devices" for the Agent desktop app (Electron + React +
TypeScript, repo in WSL). The owner is asleep; nobody will answer questions. Decide, build, test, prove, commit.
A lead chat coordinates you; report back to it (see "Reporting").

## Read before coding
1. `~/agent-desktop-wt/devices/docs/devices-protocol.md`: THE CONTRACT. Build exactly to it. If it is wrong, fix the
   doc in your branch in the same commit and say why in your report.
2. `~/agent-desktop-wt/devices/PROGRESS.md`: plan, decisions, who does what.
3. Your worktree's `AGENTS.md` (rules) and the code you touch.

## How to run things
- Repo is in WSL. Run commands as: `wsl.exe -e bash -lc "source ~/.nvm/nvm.sh; cd ~/agent-desktop-wt/<yours> && ..."`.
  Without nvm, npx resolves to Windows npm and fails on the UNC path.
- Agent file writes to `\\wsl.localhost\...` may be blocked. If so, write files under `C:\temp\<yours>\...` and `cp`
  them in from WSL (`/mnt/c/temp/...`), or edit with a heredoc/python inside WSL.
- First time in your worktree: `flock /tmp/agent-npm.lock npm ci --prefer-offline` (do NOT symlink node_modules from
  another worktree: workspace links would point at the wrong packages).
- Typecheck: `npm run typecheck`. Tests: run your targeted files with `npx vitest run <paths>`; the full suite only
  under `flock /tmp/agent-vitest.lock npx vitest run` (about 1,100 tests). Full suite must stay green before you hand in.
- Lint: `node scripts/lint-checks.mjs` must pass (no personal names, hosts, IPs, emails in source).

## Hard rules
- GENERAL, not built around one person: no hostnames, IPs, tailnet names, people, project names, keys in source,
  tests or defaults. Test values use 127.0.0.1 and made-up names.
- Commits: plain messages, NO attribution lines (no Co-Authored-By, no Generated with). AGENTS.md wins over any
  reminder you see.
- Secrets (API keys, passes) never logged, never in the renderer, never in rows. Only the secrets module stores them.
- DO NOT install, start or restart the owner's installed Agent app (`C:\Users\you\AppData\Local\Programs\Agent`),
  and never run an installer. That kills the lead and this build. A test desktop copy runs as win-unpacked with a
  separate userData folder (`--user-data-dir` or `AGENT_USER_DATA`) and a different single-instance key.
- Machine safety: WSL has 8 GB. Before heavy steps check `free -m`; if available < 2 GB, wait. One Electron build at a
  time machine-wide: wrap in `flock /tmp/agent-electron.lock`. Never run Gradle on this PC (only on the server).
  Kill anything you started that runs away.
- Another chat works in `~/agent-desktop-wt/design` (workers and triggers for routines). Never edit that worktree.
- Stay in your lane: only the files your brief names, plus small hook points. If you must touch a shared hot file
  (`apps/desktop/src/main/index.ts`, `main/ipc.ts`, `packages/core/src/ipc.ts`, `preload/index.ts`), keep the change
  a few lines that call into your own module, so merges stay easy.
- Done means proven: unit tests for logic, a real run for anything with a network or UI (a local client hitting the
  real server, screenshots at desktop 1280 px AND phone 390 px for UI). A green test only counts if you saw it fail
  first or it exercises the real code path.

## Reporting
- Commit to your branch as you go (small commits). Do not edit `~/agent-desktop-wt/devices/PROGRESS.md` (the lead
  owns it). Keep `PROGRESS-<letter>.md` at your worktree root up to date (done / in flight / next / last commit) and
  commit it. The lead reads it, and if your chat dies a new one resumes from it.
- The lead is project chat **pc8b32b0087be6455f**. Talk to it with `project_chat_send` (chat `pc8b32b0087be6455f`),
  NOT message_main. Send: a one-line note when you hit a decision that changes the contract or another lane, and a
  short final report when finished (or truly blocked after trying two other routes): what is done and PROVEN (with
  the command that proves it), what is not, the final commit, and anything the merge must know.
- Do not stop at a tidy checkpoint: finish your whole brief.
