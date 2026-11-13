# Windows input without his cursor: builder notes (11 Nov 2026)

Part of docs/agent-cursor.md. What was built for tools `screen_windows`, `screen_read`, `screen_act` and the input lock, and what was seen on real apps.

## Files
- `tools/agent-screen/src/Act.cs` (native): ops act, probe, place, presence, inject. New: a focus guard around every action, an `avoid` list, text goes by window message before the value pattern when the program is not in front, the raw-input list comes from the caller.
- `apps/desktop/src/main/agent-cursor/control.ts`: windows, read, act. The ladder and the verified answer. Hooks `cdp` and `desktop` (ExtraRung) are where the lead's rungs plug in.
- `agent-cursor/raw-input-apps.ts`: the ONE list of programs and classes that need the agent desktop. The helper is sent it on every action.
- `agent-cursor/input-lock.ts`, `lock-host.ts`: the only path to real input. `real-input-guard.ts`: refuses real-input names in shell_run, run_code and the plan-engine Bash/PowerShell hook.
- `agent-cursor/wire.ts`: puts it together for index.ts (takers memory on disk in userData/screen-takers.json, pictures in userData/screen).
- `tools/screen-control.ts`, registered in runtime/toolset.ts (`screenControl` dep), `screen_windows` and `screen_read` in read-only.ts, `screen_act` in the vault guard.
- Settings `agentRealInput` (default off, listed in app-control as only-he-changes) and `inputLockIdleSeconds` (default 10).
- Test `no-other-real-input.test.ts` greps the repo: a new file naming a real-input API fails unless it is on its allow list with a reason.

## Seen on my own windows (this PC, Windows 11, his cursor and foreground recorded before and after every call)
| App | What | Rung | His pointer / focus |
|---|---|---|---|
| Notepad (WinUI) | type, replace and append | msg:settext, msg:replacesel | unchanged, focus not taken |
| Notepad | click Bold, File | uia:toggle, uia:invoke | the app takes the front; the guard gives it back in 10 to 13 ms |
| Notepad | key Escape | post:key | unchanged |
| Notepad | ctrl+a | post:key+state | ignored (nothing changed), said so |
| winver (Win32 dialog) | click OK | uia:invoke | back in 17 ms |
| File Explorer | click Sort | uia:invoke | back at once |
| Explorer | key Escape, wheel | post:key, post:wheel | ignored, said so |
| Calculator (UWP) | click digits and operators, key | uia:invoke, post:key | works. The FIRST invoke on a never-activated Calculator takes the front and sticks; see below |

## The known weak spot
A UWP app that has never been in front (Calculator) takes the keyboard on its first UIA invoke and a plain SetForegroundWindow back fails for 200 ms or more. The guard tries both thread joins with a back-off, then minimises the program for a moment (Windows activates the window behind it, his) and puts it back without activating. The answer says whether his window came back and how long he lost it; the rung is remembered per (process, class) and skipped next time. NOT solved: in my runs the first Calculator invoke left his window behind in about 3 of 5 tries even with the minimise step (lost 200 to 300 ms, answer says givenBack false). Notepad, winver and Explorer came back in 10 to 17 ms. For a UWP target that is not in front, expect to lose focus; the result says so. A better answer may be to read the UWP window and use the agent desktop for it.

## Not tested here, on purpose
- `inject` (real input) was never run on his desktop. The lock is tested with a stubbed injector and a fake presence source.
- Chromium and Electron windows go through the CDP hook, which the lead wires.
