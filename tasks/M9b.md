# M9b: Agent browser panel (renderer only)

Chat (M6b) and the main-process browser (M9a) are merged here. Do ONLY the renderer part of `tasks/M9.md`: the live Panel (URL text, back, reload, tabs, "Nova is here" pill using the agent's name, empty state, collapse, draggable splitter 320-560px remembered),
reporting its bounds with `browser.setBounds` (debounced, hidden when not on Chat), "Open in my browser", handoff card with "Done, carry on". Keep the SkyHop demo in the mock bridge.
Gate: `bash scripts/gate.sh M9b`. Report: `tasks/reports/M9b.md`.
