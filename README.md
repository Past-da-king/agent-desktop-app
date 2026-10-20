# Agent Desktop

A desktop home for the Agent: local memory, tasks, routines and tools, with the same design language as the phone app.

## Run it

- `npm install` once.
- `npm run dev` starts the Electron app with hot reload.
- `npm run dev:web` serves the renderer alone at http://localhost:5173 on the in-memory mock bridge.
- `npm test` runs the unit tests with vitest.
- `npm run typecheck` checks every workspace.
- `npm run build` builds the core package and the desktop app.
- `npm run shoot` renders the built UI in headless Chromium and writes screenshots.
- `bash scripts/gate.sh M0` runs the milestone gate.

The app starts empty. The mock bridge only exists for the browser preview and screenshots.
