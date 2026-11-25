# Child pipe failures

The Node child-process boundary is guarded once at desktop and headless startup. It wraps spawn, execFile and fork and updates Node ESM exports, so SDK-owned spawns use the same boundary. Each stdin/stdout/stderr/extra stdio pipe gets a lifetime error listener. Writable write calls check state, observe callback errors and catch expected synchronous stream errors. Non-pipe programming errors still throw. The first pipe failure is retained on the child, delivered to its existing error listeners, and terminates the child so existing exit/close handlers complete the owner. A periodic worker with a recorded pipe failure is failed even if its signal handler exits with code 0. No command arguments or input are logged.

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
- `main/spawn-off-thread.ts`: separate worker isolate installs the same self-contained pipe guard; errors reach the existing failed/exit bridge instead of being swallowed.

Raw socket writes use safeSocketWrite in `main/devices/ws.ts` (frames and HTTP upgrade), `main/devices/net.ts` and `main/devices/socks.ts` (SOCKS handshake), and `main/freeze-recovery.ts` (parent heartbeat). The generated watchdog bootstrap has an existing socket error/disconnect handler. Third-party WebSocket libraries own their own error/close lifecycle. Buffer, file-store and Electron clipboard writes are not pipe writes. No additional child launch or raw socket writer was found under packages/.

## Crash policy

Tagged pipe failures and low-level EOF/EPIPE/ECONNRESET/ERR_STREAM_DESTROYED/ERR_STREAM_WRITE_AFTER_END write stacks are warnings. A matching code on an ordinary application error is insufficient. Real faults retain the dialog; exceptions and rejected promises share a 30-second dialog limiter and every error is still logged.

## Proof

`apps/desktop/test/safe-pipe.test.ts` uses real Node children and the real worker Supervisor/store. It covers dead-child writes, ESM/SDK-style spawn guarding, owner failure reasons, callback/event deduplication, socket failure, strict classification and burst limiting. Red controls restore origin/devices alive.ts and remove guardPipe while retaining the test bridge: 12 regression tests fail, the programming-fault test remains green. Red report: /tmp/child-pipe-red.json on the build host. Final suite and baseline results are recorded in the draft PR.

No environment variables, migrations or release version changes. No installer, installation or node deployment is part of this change. Independent review and combined-open-PR verification are release prerequisites, not claimed here.

## Independent review repairs (25 November 2026)

Rejection responses in devices/ws.ts and devices/server.ts, local headless control replies, and freeze-supervisor stop messages use safeSocketEnd. Inventory of end(data) and destroy(error) found no other raw-socket payload writes; HTTP request/response methods retain their existing error ownership.

Pipe failures now stop children with SIGTERM, escalate after 500 ms to SIGKILL, and deliver one existing exit/close completion after a further 250 ms if OS events never arrive. Late duplicate terminal events are suppressed. Windows uses taskkill /T /F before killing the parent; this Windows-specific branch still needs native Windows proof. Off-thread hosts wait for this bounded child shutdown before asking the parent to terminate the worker isolate.

Only the five expected pipe codes are warnings. Unexpected asynchronous event and callback errors notify the owner and the registered real-fault path; desktop uses the same error logger and rate-limited dialog handler, headless logs at error severity. Without a registered fault handler unexpected failures are rethrown on a microtask.

Five additional regression cases fail on unchanged bcdea3a with only the tests copied in: rejection end payload guarding; missing OS exit completion; unexpected event fault; unexpected callback fault; real SIGTERM-resistant child. Reports /tmp/pipe-review-red-v2.json and /tmp/pipe-review-green-v2.json. Full baseline/candidate suites and combined trial merge remain deferred until after 08:00 SAST Thursday 26 November 2026.

## Second independent review repairs

Windows shutdown uses one terminal latch for exit, close and successful taskkill completion. Both escalation timers are cancelled on termination. The asynchronous child_process import checks that latch immediately before spawning taskkill; a taskkill result received after child termination is ignored. This prevents a delayed PID-based kill from being launched after the owned child ended.

Expected pipe failures alone are deduplicated. A later unexpected error still reaches both the child owner and the fault handler; the off-thread relay preserves that distinction too. Four regression cases fail at dea8d69 and pass after repair: deferred Windows launch after exit, after close, and racing escalation, plus TypeError after EOF. Windows tests intercept spawn under a synthetic win32 platform and do not execute taskkill. Native Windows proof and full suites remain pending.

## Third independent review repairs

This supersedes the Windows taskkill implementation described in earlier review history. The shared helper never launches taskkill or performs PID lookup. Windows uses one child.kill(SIGKILL) on the process handle owned by Node; POSIX retains SIGTERM then SIGKILL escalation. No direct-child kill runs after exit. This shared guard does not promise grandchild/process-tree termination; launcher-specific process-group or Job Object cleanup remains the launcher owner's responsibility.

A WeakSet deduplicates the same Error object delivered through write callback and error event; a different unexpected Error still reaches the owner and fault handler. Exit now cancels kill escalation but arms a separate 250 ms missing-close deadline preserving the actual exit code/signal; close alone cancels that deadline.

Three controls fail at 5c90944 and pass after repair: synthetic Windows spawn interception observes no taskkill and one handle kill; real Writable callback/event delivery reports a TypeError once while another survives; exit without close completes close once after the grace period. Native Windows behavior and full suites remain pending.

## Fourth independent review repairs

The direct-child fallback is used only when no launcher cleanup is registered. shell_run, run_code, version probes and real worker launchers register their existing tree cleanup with the guard. On first pipe failure the owner callback runs before the error event can settle the owner and remove timeout/abort handlers. POSIX shell/code already used detached process groups on origin/devices; version probes and workers now also own detached groups before using group cleanup. The shared guard does not itself discover or kill descendants.

Windows owner cleanup keeps origin/devices' existing taskkill /PID /T /F path, invoked before observed exit while Node still owns its child handle. This is baseline-equivalent PID risk, not a new Job Object guarantee; native Windows proof remains pending. The shared fallback still performs handle-based child.kill only and never launches taskkill.

Real shell_run fixtures spawn a persistent grandchild and exercise EOF, timeout and cancellation separately. At b9e97e6 timeout/cancel pass but EOF leaves the grandchild running. After repair all three pass. On unchanged origin/devices 5c929be, timeout and cancellation pass with native spawn and no guard bridge; EOF is intentionally unselected because baseline has no guard. Tests distinguish exited zombies from running processes and clean only fixture-owned group/PIDs.
