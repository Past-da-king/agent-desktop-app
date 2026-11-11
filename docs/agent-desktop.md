# The agent's own desktop for real-input apps

Stage 3 of "the agent never takes his mouse, keyboard or focus" (11 Nov 2026). Some apps accept
**only real input** and ignore the no-cursor path (UI Automation patterns, CDP, PostMessage):
games, DirectX apps, some packaged/UWP apps, and remote viewers such as AnyDesk. For those the
agent needs a surface **it owns** where real input can be delivered without touching the user's
pointer, keyboard or focus. This is the PC equivalent of the phone app's background screen (Watch,
Take over, Give back).

Researched and prototyped on the live PC: **Windows 11 Pro, build 26200 (25H2), 15 GB RAM, not
admin, single interactive console session** (`fSingleSessionPerUser=1`, `fDenyTSConnections=1`,
Windows Sandbox not installed).

## Verdict

**Pick: a separate desktop object on the current window station (`CreateDesktop` on WinSta0).**
It is the only option that needs **no admin, no reboot, no second sign-in, no feature to enable,
and shares the user's logged-in app state** (same profile, same user). Proven end to end on the PC.
It is the exact technique Microsoft is now shipping as **Agent Workspace** (a separate session per
agent), so it is a first-class, documented direction, not a hack.

**Its one real limit:** input and capture are per-window (PostMessage + PrintWindow), and
**Chromium/Electron web content and GPU/DirectX surfaces do not capture via PrintWindow** off the
input desktop (no DWM composition there). So:
- **This surface is for native Win32 and classic apps, and for real-input apps whose window is
  GDI/Direct2D** (which prints). Captured Character Map perfectly.
- **Chromium/Electron stay on CDP** (the agent-cursor helper already does this on the user's own
  desktop); their window chrome prints but the page is black.
- **Games/DirectX** need a frame grab the surface does not yet have (a mirror/IddCx display or a
  D3D shared surface); PrintWindow returns black for them too. Documented as not proven.

**Fallback: Windows Sandbox** (Pro only) for throw-away, fully isolated runs where no sign-in state
is needed. It is clean, but needs the feature enabled once (admin + reboot), starts a blank machine
each time (no user apps or logins), uses ~1 GB+ RAM and seconds to start, and cannot see the user's
accounts. Good for "run this untrusted thing", wrong for "use my signed-in app".

## The comparison (all checked against Microsoft docs; (1) and (5) also tried on the PC)

| Mechanism | Real input w/o his cursor/focus | Which apps run | Capture | Same signed-in profile | Admin | Home too | RAM / start | Risk | Effort |
|---|---|---|---|---|---|---|---|---|---|
| **1. Separate desktop (CreateDesktop/WinSta0)** — **PICK** | Yes: PostMessage/SendMessage to window handles (SendInput only reaches the one input desktop) | Native Win32 yes (proven); Chromium/Electron run but see capture; packaged/single-instance apps reuse the instance on his desktop | PrintWindow(PW_RENDERFULLCONTENT) per window: GDI/Direct2D yes, GPU web/DirectX **no (black)** | **Yes, same user** | **No** | **Yes** | tiny / instant | AV historically flags "hidden desktop" (hVNC); ours is local, user-launched, signed, documented | Low-medium |
| **2a. Child session (WTSEnableChildSessions + RDP ActiveX loopback)** | Yes, a real second input desktop in its own session | Everything, real input + GPU | Via the RDP/ActiveX client surface | Same user, **separate session** (not his signed-in apps) | **Yes, once to enable** | Client min Win8, but availability on 11 24H2/25H2 unconfirmed | a session's worth | Undocumented UX; one child session at a time | High |
| **2b. Loopback RDP to a 2nd local user (127.0.0.2)** | Yes | Everything | RDP client (FreeRDP offscreen) | **Different user** profile, separate logins | New user + enable RDP (admin); single-session disconnects him | **No (Home has no RDP host)** | a session | Disconnects his session on single-session SKUs | High |
| **3. Windows Sandbox (.wsb)** — **FALLBACK** | Yes, inside the sandbox | Most, but a blank OS | Its own window | **No** (fresh machine, no logins) | Enable feature once (admin+reboot) | **No (Pro+ only)** | ~1 GB+ / seconds | Low | Low |
| **4. Hyper-V / VM** | Yes, inside the VM | Everything | VM console | **No**, and needs its own Windows licence + sign-ins | Enable Hyper-V (admin) | **No** | GBs / slow | Licensing | High |
| **5. Virtual display driver (IddCx) + move window there** | **No** — one system cursor and one focus are shared; moving a window to a virtual monitor does not give the agent its own input | n/a | DWM capture of that display | Yes | Driver install (admin) | Yes | small | Driver signing | Doesn't solve the problem |

Notes on the rejected options:
- **Win32 App Isolation / `Windows.UI.Input.Preview.Injection`**: injection is still global (it targets the
  input desktop), so it does not isolate from his focus. App Isolation sandboxes a process's rights,
  not its input/desktop. Neither gives a separate input surface.
- **RDP Wrapper**: explicitly out of scope (unsupported, patches termsrv).

## How the pick works (exact APIs, proven)

1. **Create the desktop** (no admin):
   `hDesk = CreateDesktop("AgentDesk_xxxx", NULL, NULL, 0, GENERIC_ALL, NULL)` on the current
   WinSta0. We never call `SwitchDesktop`, so the user's visible desktop never changes.
2. **Launch an app there**: `CreateProcess` with `STARTUPINFO.lpDesktop = "WinSta0\\AgentDesk_xxxx"`.
   The child and its windows live on the agent's desktop. Same user, same profile, same signed-in
   state. (Proven: Character Map, and Edge with a fresh `--user-data-dir`.)
3. **List windows**: `EnumDesktopWindows(hDesk, ...)` + `GetWindowText/Rect/ThreadProcessId`.
4. **Capture**: for each window, `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` into a bitmap,
   save PNG. Works off the input desktop (unlike BitBlt/DWM, which only see the input desktop).
   GDI/Direct2D windows render fully; GPU-composited web/DirectX surfaces come back black.
5. **Input** (never SendInput): `PostMessage(hwnd, WM_LBUTTONDOWN/UP, ..., MAKELPARAM(x,y))` for a
   click, `PostMessage(hwnd, WM_CHAR, ch, 0)` per character. Delivered to the target window on the
   agent desktop, so his input desktop is untouched. **Limit:** a message to a top-level frame is
   not always routed to the focused child control; production should resolve the child window
   (WindowFromPoint within the desktop, or a UI Automation pass on `hDesk` exactly like
   `tools/agent-screen`) and post to that child, and set focus with WM_SETFOCUS/`SetFocus` on a
   thread attached to the agent desktop.
6. **Guard**: every command reads `GetCursorPos` + `GetForegroundWindow` before and after; both
   stayed unchanged on every command in the proof.
7. **Tear down**: kill the launched pids, `CloseDesktop(hDesk)`.

## What is proven, on this PC, no admin, his cursor and focus never moved

- Agent desktop created; **Character Map** launched on it, listed (458x429 at 14,64), **captured to
  a real PNG** (a full render of the grid, not blank), clicked and typed, torn down. `cursorMoved`
  and `foregroundChanged` were `false` on **every** command.
- **Edge (Chromium)**, fresh `--user-data-dir`, launched and rendered on the agent desktop (two
  windows); its toolbar/tabs/address bar captured cleanly, the **page area came back black**.
- Screenshots: `charmap.png`, `edge_133382.png` (in the proof folder / Downloads copy).

## What is NOT proven / known limits

- **Packaged / single-instance apps** (new Notepad, Paint, Store apps) on 25H2: `mspaint.exe` and
  the modern Notepad are packaged; a plain `CreateProcess` of `notepad.exe` returned a pid but no
  window appeared on the agent desktop (the packaged host put it elsewhere / reused an instance).
  Launching packaged apps on a specific desktop needs the activation-manager path, not proven here.
- **Games / DirectX / exclusive-fullscreen**: not tested; PrintWindow will not capture GPU frames.
  Needs a mirror display (IddCx) bound to the agent desktop or a D3D-shared-surface grabber.
- **Child input routing** into child controls (see step 5): the prototype posts to the top-level
  window; typing did not reach Character Map's search box. Production needs child resolution + focus.
- Second monitor / DPI scaling on the agent desktop: single screen here.

## What needs Ayanda's yes (do not run without it)

- Enabling **child sessions** (`WTSEnableChildSessions`) — a one-time machine change, admin.
- Any **loopback RDP** / creating a **second local user** / enabling the RDP host — admin, and on a
  single-session SKU it can disconnect his session.
- Enabling the **Windows Sandbox** or **Hyper-V** feature — admin + reboot (Pro only).
- A **virtual display driver** or any driver install — admin, driver signing.
- None of these are needed for the picked mechanism, which runs as him, no admin.

## The Watch / Take over / Give back UI (spec, not built)

Mirror the phone's background screen:
- **Watch**: a viewer window in the app streams `capture()` frames of the agent desktop (poll at a
  few fps, or on change). Read-only; the agent keeps driving via `click`/`type`.
- **Take over**: the viewer forwards **his** input to the surface — his clicks/keys in the viewer
  are translated to client coords and posted to the target window (or, for real-input-only apps,
  the agent desktop is made the input desktop only while he drives, then released). The agent pauses.
- **Give back**: stop forwarding; the agent resumes. Exactly the phone's Take over / Give back.
- Build it in `apps/desktop/src/main` over the `AgentSurface` seam; the viewer is a normal app
  window, capture-protected if it should not appear in his screen shares.

## Files in this change (additive)

- `tools/agent-desktop/` — the C# sidecar (`src/Program.cs`), `build.cmd`, committed
  `bin/win-x64/agent-desktop.exe`, `README.md`.
- `apps/desktop/src/main/agent-desktop/agent-surface.ts` — the `AgentSurface` seam.
- `apps/desktop/test/agent-surface.test.ts` + `fixtures/fake-agent-desktop.mjs` — seam tests (CI, no Windows).
- `docs/agent-desktop.md` — this file.

electron-builder `extraResources` should pack `tools/agent-desktop/bin/${os}-${arch}` to
`<resources>/agent-desktop/` (same pattern as `agent-screen`); the lead helper wires that when the
UI lands, to keep this branch additive.
