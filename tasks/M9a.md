# M9a: Agent browser (main process only)

Do ONLY the main-process part of `tasks/M9.md`: `browser/browser.ts` (WebContentsView, partition, tabs, downloads), the page-access helpers, URL policy, the `browser_*` tools (register by appending one line to `runtime/toolset.ts`), the handoff card flow,
`browser.setBounds` and the other `browser` IPC (add the `browser` group to `packages/core/src/ipc.ts`, the preload and the mock bridge, additively), and the tests in M9.md.
Gate: `bash scripts/gate.sh M9a`. Report: `tasks/reports/M9a.md`.
