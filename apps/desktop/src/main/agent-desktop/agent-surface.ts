// AgentSurface: a desktop/session the agent owns, where real input can be sent to an app without
// ever touching the user's pointer, keyboard or focus. The PC equivalent of the phone's background
// screen. Stage 3 of [[Decision: the agent never takes his mouse, keyboard or focus (11 Nov 2026)]].
//
// This is the TypeScript seam over the native tools/agent-desktop sidecar (C#, JSON lines over stdio,
// like tools/agent-screen). The Watch / Take over / Give back UI is described in docs/agent-desktop.md
// and is NOT built here.
//
// The chosen mechanism is a separate DESKTOP object on WinSta0 (CreateDesktop), proven on
// Windows 11 Pro 26200 without admin: classic Win32 apps render there and capture with PrintWindow;
// Chromium/Electron render but their web content does not print (use CDP for those, not this surface).

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

export interface AgentWindow {
  hwnd: number;
  title: string;
  pid: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SurfaceResult {
  ok: boolean;
  error?: string;
  /** every reply carries the input-safety guard: true means the sidecar moved the real cursor */
  cursorMoved: boolean;
  /** true means the real foreground window changed while the command ran */
  foregroundChanged: boolean;
  [k: string]: unknown;
}

export interface AgentSurface {
  /** Create the agent's own desktop on WinSta0. No admin, no effect on the user's desktop. */
  open(name?: string): Promise<SurfaceResult>;
  /** Start an app on the agent's desktop (STARTUPINFO.lpDesktop). Returns its pid. */
  launch(app: string, args?: string): Promise<SurfaceResult>;
  /** Top-level windows on the agent's desktop (EnumDesktopWindows). */
  windows(): Promise<AgentWindow[]>;
  /** Capture one window to a PNG via PrintWindow(PW_RENDERFULLCONTENT). */
  capture(hwnd: number, pngPath: string): Promise<SurfaceResult>;
  /** Deliver a left click to a window with PostMessage (client coords). Never SendInput. */
  click(hwnd: number, x: number, y: number): Promise<SurfaceResult>;
  /** Type text into a window with WM_CHAR. Target a resolved child control for reliable routing. */
  type(hwnd: number, text: string): Promise<SurfaceResult>;
  /** Tear down: kill the apps we launched and close the desktop. */
  close(): Promise<SurfaceResult>;
}

/** Spec for the viewer UI only, not implemented here (see docs/agent-desktop.md):
 *  watch() -> a stream of capture() frames into a viewer window in the app.
 *  takeOver() -> forward the user's input to the surface (the user, not the agent, drives it).
 *  giveBack() -> stop forwarding; the agent drives again. Like the phone's Take over / Give back. */

type Pending = { resolve: (v: SurfaceResult) => void; reject: (e: Error) => void };

export function createAgentSurface(exePath: string, args: string[] = []): AgentSurface {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let buf = "";
  const queue: Pending[] = [];

  function ensure(): ChildProcessWithoutNullStreams {
    if (proc) return proc;
    proc = spawn(exePath, args, { windowsHide: true });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const p = queue.shift();
        if (!p) continue;
        try {
          p.resolve(JSON.parse(line) as SurfaceResult);
        } catch (e) {
          p.reject(e as Error);
        }
      }
    });
    proc.on("exit", () => {
      proc = null;
      while (queue.length) queue.shift()!.reject(new Error("agent-desktop sidecar exited"));
    });
    return proc;
  }

  function send(obj: Record<string, unknown>): Promise<SurfaceResult> {
    const p = ensure();
    return new Promise<SurfaceResult>((resolve, reject) => {
      queue.push({ resolve, reject });
      p.stdin.write(JSON.stringify(obj) + "\n");
    });
  }

  return {
    open: (name) => send(name ? { cmd: "open", name } : { cmd: "open" }),
    launch: (app, args) => send({ cmd: "launch", app, args: args ?? "" }),
    async windows() {
      const r = await send({ cmd: "windows" });
      return (r.windows as AgentWindow[]) ?? [];
    },
    capture: (hwnd, pngPath) => send({ cmd: "capture", hwnd, path: pngPath }),
    click: (hwnd, x, y) => send({ cmd: "click", hwnd, x, y }),
    type: (hwnd, text) => send({ cmd: "type", hwnd, text }),
    async close() {
      const r = await send({ cmd: "close" });
      if (proc) proc.stdin.end();
      return r;
    },
  };
}
