# Child pipe failures

The Node child-process boundary is guarded once at desktop and headless startup. It wraps spawn, execFile and fork and updates Node ESM exports, so SDK-owned spawns use the same boundary. Each stdin/stdout/stderr/extra stdio pipe gets a lifetime error listener. Writable write calls check state, observe callback errors and catch expected synchronous stream errors. Non-pipe programming errors still throw. The first pipe failure is retained on the child, delivered to its existing error listeners, and terminates the child so existing exit/close handlers complete the owner. No command arguments or input are logged.

## Inventory, devices 5c929be

Direct child launchers covered by the installed boundary:

- `main/runtime/spawn.ts`, `main/runtime/environment-host.ts`: resolved commands and environment probes.
- `main/runtime/cli-host.ts`: engine status probes and interactive sign-in stdin.
- Claude Agent SDK and Codex SDK: SDK-private subprocesses and stdin, including Codex's direct input write/end.
- `main/git/git-exec.ts`: native git and wsl.exe git stdin write/end.
- `main/workers/spawn.ts`, `main/workers/supervisor.ts`: Node/Python/PowerShell/command workers and stop writes.
- `main/agent-desktop/agent-surface.ts`: agent-desktop JSON request pipe and shutdown.
- `main/showme/native/sidecar.ts`: agent-screen requests and shutdown.
- `main/devices/net.ts`, `main/devices/firewall.ts`: agent-net control input, network and firewall helpers.
- `main/dictation/paste.ts`: clipboard/paste helper request and shutdown pipes, direct fallback spawn.
- `main/tools/shell.ts`, `main/tools/code.ts`: shell and code tool execution through the runtime command host.
- `main/clipboard-files.ts`, `main/hotkey-holders.ts`, `main/self-update.ts`: finite platform helpers.
- `main/index.ts`, `main/freeze-recovery.ts`: app children and freeze supervisor. IPC send already supplies callbacks.
- `headless/browser.ts`, `headless/main.ts`: browser and node children.
- `main/spawn-off-thread.ts`: separate worker isolate, all three child streams observed there; errors now reach the existing failed/exit bridge instead of being swallowed.

Raw socket writes use safeSocketWrite in `main/devices/ws.ts` (frames and HTTP upgrade), `main/devices/net.ts` and `main/devices/socks.ts` (SOCKS handshake), and `main/freeze-recovery.ts` (parent heartbeat). The generated watchdog bootstrap has an existing socket error/disconnect handler. Third-party WebSocket libraries own their own error/close lifecycle. Buffer, file-store and Electron clipboard writes are not pipe writes. No additional child launch or raw socket writer was found under packages/.

## Crash policy

Tagged pipe failures and low-level EOF/EPIPE/ECONNRESET/ERR_STREAM_DESTROYED/ERR_STREAM_WRITE_AFTER_END write stacks are warnings. A matching code on an ordinary application error is insufficient. Real faults retain the dialog; exceptions and rejected promises share a 30-second dialog limiter and every error is still logged.

## Proof

`apps/desktop/test/safe-pipe.test.ts` uses real Node children and the real worker Supervisor/store. It covers dead-child writes, ESM/SDK-style spawn guarding, owner failure reasons, callback/event deduplication, socket failure, strict classification and burst limiting. Red controls restore origin/devices alive.ts and remove guardPipe while retaining the test bridge: 10 regression tests fail, the programming-fault test remains green. Red report: /tmp/child-pipe-red.json on the build host. Final suite and baseline results are recorded in the draft PR.

No environment variables, migrations or release version changes. No installer, installation or node deployment is part of this change. Independent review and combined-open-PR verification are release prerequisites, not claimed here.
