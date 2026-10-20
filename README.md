# Agent Desktop

A desktop home for the Agent: local memory, tasks, routines and tools, with the same design language as the phone app.

## Run it

- `npm install` once (Node 22.13 or newer).
- `npm run dev` starts the Electron app with hot reload.
- `npm run dev:web` serves the renderer alone at http://localhost:5173 on the in-memory mock bridge.
- `npm test` runs the unit tests with vitest.
- `npm run typecheck` checks every workspace.
- `npm run build` builds the core package and the desktop app.
- `npm run shoot` renders the built UI in headless Chromium and writes screenshots.
- `bash scripts/gate.sh M0` runs the milestone gate.

The app starts empty. The mock bridge only exists for the browser preview and screenshots.

## Package it

The build output lives in `apps/desktop/release/`. Every command below runs the build first.

| Command | What it makes | Run it on |
|---|---|---|
| `npm run pack` | An unpacked app for a quick smoke test (no installer) | Any platform |
| `npm run dist:win` | NSIS installer (per user, no admin) and a portable exe | Windows |
| `npm run dist:mac` | dmg and zip (hardened runtime; signing optional) | macOS |
| `npm run dist:linux` | AppImage and deb | Linux |

The app id (`app.agent.desktop`) and product name (`Agent`) are placeholders in
`apps/desktop/electron-builder.yml`. Change both together before a public release.

### Windows, built on the Windows machine

Cross-building the Windows installer from WSL is not supported by this project. Build it on the
Windows machine over SSH. From the repository root on this computer:

```bash
ssh pc2 "powershell -NoProfile -Command \"cd C:\\agent-desktop-app; git pull; npm ci; npm run dist:win\""
```

Or sign in first and run the same commands in PowerShell:

```powershell
ssh pc2
cd C:\agent-desktop-app
git pull
npm ci
npm run dist:win
```

The installer is `apps\desktop\release\Agent-0.1.0-setup.exe` and the portable build is
`apps\desktop\release\Agent-0.1.0-portable.exe`. To smoke test the unpacked build first, run
`npm run pack` and then `apps\desktop\release\win-unpacked\Agent.exe`.

Code signing is read from the environment and is not required for a local build:

- Windows: `CSC_LINK` (path or base64 of a .pfx) and `CSC_KEY_PASSWORD`.
- macOS: `CSC_LINK` and `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID` for notarisation.

With no credentials set, electron-builder skips signing and still produces a testable package.

### macOS and Linux

```bash
npm run dist:mac      # on a Mac
npm run dist:linux    # on Linux
```

The dmg and zip are built for x64 and arm64. The AppImage and deb are built for x64. Nothing is
published automatically: `publish` is off, and there is no update server in the source.

### Icons

Icons are generated from the mascot SVG inside `scripts/make-icons.mjs`:

```bash
npm run make:icons
```

The script uses the Chromium already installed for Playwright (or `CHROME_PATH` if set) and writes
`apps/desktop/build/icon.png` (1024 px), `icon.ico`, `icon.icns` and a PNG set under
`apps/desktop/build/icons/`. No image package is needed: the ICO and ICNS containers are built in
the script.

### Updates

Auto update is a stub in v1. A build may set `AGENT_UPDATE_URL` at runtime; when it is empty the app
does nothing. There is no default server in the source.

### Logs

The main process writes `main.log` to the app's user-data folder under `logs/`, rotating one previous
file at 1 MB. Settings > About has an "Open logs folder" button. Keys, tokens, prompts and file
contents are never logged.

## Release checklist

1. Bump `version` in `apps/desktop/package.json` (and the root `package.json` if it should match).
2. `npm ci && npm run typecheck && npm test && npm run build`.
3. `npm run make:icons` if the mascot changed.
4. Build each platform on its own machine: `dist:win` on Windows, `dist:mac` on macOS,
   `dist:linux` on Linux.
5. Smoke test the unpacked build with `npm run pack`.
6. Sign with the environment variables above when certificates are available.
