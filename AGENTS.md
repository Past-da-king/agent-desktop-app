# Rules for the implementing agent

You are building the Agent desktop app. Read `PLAN.md` first, then the one `tasks/Mx.md` file you were pointed at.
Do only that milestone. Do not start the next one.

## How to work
1. Read `PLAN.md` (whole) and your milestone file (whole) before writing code.
2. Open the reference material the milestone names. `reference/` holds the Kotlin the TypeScript mirrors, and
   `design/mockup.html` is the UI, to be ported not reinvented.
3. Work in small steps. After each step run `npm run typecheck` (from the repo root). Fix errors before moving on.
4. When the milestone's work is done, run the gate: `bash scripts/gate.sh Mx`. It must print `GATE Mx PASSED`.
   If it fails, read the output, fix the cause, run it again. Do not edit anything under `scripts/` or `tasks/`
   to make a gate pass. The gate is not yours to change.
5. When the gate passes, commit: `git add -A && git commit -m "Mx: <short summary>"`.
   The commit message has NO attribution lines (no "Co-Authored-By", no "Generated with"). Plain message only.
6. Finish with a short report: what you built, what you could not finish (be honest), anything the next milestone
   must know. Write it to `tasks/reports/Mx.md`.

## Hard rules
- TypeScript strict. No `any` unless a comment says why. No `// @ts-ignore`.
- Nothing is hardcoded to anyone's infrastructure: no personal URLs, emails, IPs, keys, hostnames. The sync server URL is
  a user setting (default empty). Example values in tests use `http://127.0.0.1:<port>` of a local fake server.
- Never log, print or persist an API key or token anywhere except the secrets module. Never put them in the renderer.
- No emoji anywhere (UI, copy, code comments, commits). No em dashes in UI copy. Plain, warm words.
- No text under 12px in the UI, except the 11px uppercase eyebrow. Text must have 4.5:1 contrast in light and dark.
  Use the CSS tokens from the mockup; never invent colours.
- Do not use `alert`, `confirm` or `prompt` in the UI. Build real dialogs.
- Every button must do something real or be visibly disabled with a "Coming soon" tooltip. No dead buttons.
- The renderer talks to the main process ONLY through `window.agent` (see `packages/core/src/ipc.ts`). No `require`,
  no Node APIs, no direct network calls to AI providers from the renderer. `nodeIntegration` is false, `contextIsolation` is true.
- All network calls to AI providers and the sync server happen in the main process (or in `@agent/core` called from it).
- Port behaviour from the Kotlin references faithfully. If you must deviate, say why in a code comment and in your report.
- Prefer boring, small, readable code. Match the style of files already in the repo.
- Do not add dependencies that are not listed in `PLAN.md` without a one-line justification in your report.
- Tests: vitest. Core logic gets unit tests. Do not mock what you can run for real (a local fake HTTP server beats a mocked fetch).
- If something in the plan is impossible or wrong, do the closest sensible thing, and record it in your report. Never silently skip.
