# M6b: Chat UI

The main-process runtime (M6a) and the screens (M4) are already merged in this branch. Do ONLY the renderer part of `tasks/M6.md` (read M6.md, PLAN.md section 6 and `tasks/reports/M4.md`, `tasks/reports/M6a.md` first):
the Chat view on the real bridge (thread from `data.list('chat_item')`, live thinking indicator, tool chips, question cards, approval cards, report cards with a reader dialog, stop button, attachments chips, scroll behaviour, "New chat" divider),
and Home's "needs you" strip reading real waiting cards. Keep the mock bridge able to demonstrate every card kind (`?demo=1`).
Gate: `bash scripts/gate.sh M6b`. Report: `tasks/reports/M6b.md`.
