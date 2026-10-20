# M6a: Chat runtime (main process only)

Do ONLY the main-process part of `tasks/M6.md` (read all of M6.md and PLAN.md section 5 first). No renderer work in this brief.

Build: `runtime/prompt.ts`, `runtime/recall.ts`, `tools/memory.ts`, `tools/tasks.ts`, `tools/core.ts` (now, ask_user, request_approval, notify_user, web_fetch, report),
`runtime/runner.ts`, a single tool registry `runtime/toolset.ts` exporting `buildToolset(deps): Tool[]` (a plain array; later milestones add their tools by appending ONE line each),
the `chat.*` IPC handlers, ChatEvents, notifications on needs-you, restart safety. Update the PRELOAD and the MOCK bridge only if needed so the build still passes.
All the tests listed in M6.md. Gate: `bash scripts/gate.sh M6a`. Report: `tasks/reports/M6a.md`.
Keep the registry and IPC registration code very tidy and one-line-per-item: other agents will append to them in parallel and their merges must be easy.
