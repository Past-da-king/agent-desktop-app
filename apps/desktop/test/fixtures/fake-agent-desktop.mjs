#!/usr/bin/env node
// Fake agent-desktop sidecar for tests: speaks the same JSON-lines protocol as tools/agent-desktop,
// on any OS, so the AgentSurface seam can be exercised on CI. Mirrors the real guard fields.
import readline from "node:readline";

let desk = null;
let pid = 1000;
const rl = readline.createInterface({ input: process.stdin });
const guard = { cursorMoved: false, foregroundChanged: false };

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let r;
  try { r = JSON.parse(line); } catch { out({ ok: false, error: "bad json" }); return; }
  switch (r.cmd) {
    case "open":
      desk = r.name || "AgentDesk_fake";
      out({ ok: true, desk });
      break;
    case "launch":
      if (!desk) { out({ ok: false, error: "no desktop open" }); break; }
      out({ ok: true, pid: ++pid });
      break;
    case "windows":
      out({ ok: true, windows: [{ hwnd: 591332, title: "Character Map", pid, x: 14, y: 64, w: 458, h: 429 }] });
      break;
    case "capture":
      out({ ok: true, path: r.path, w: 458, h: 429, centrePixel: "255,255,255", cornerPixel: "243,243,243" });
      break;
    case "click":
      out({ ok: true, x: r.x, y: r.y });
      break;
    case "type":
      out({ ok: true, chars: (r.text || "").length });
      break;
    case "close":
      desk = null;
      out({ ok: true, killed: 1 });
      break;
    default:
      out({ ok: false, error: "unknown cmd " + r.cmd });
  }
});

function out(obj) {
  process.stdout.write(JSON.stringify({ ...obj, ...guard }) + "\n");
}
