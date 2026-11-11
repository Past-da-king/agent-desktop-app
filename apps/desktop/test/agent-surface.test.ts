import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAgentSurface, type SurfaceResult } from "../src/main/agent-desktop/agent-surface";

// Drives the seam against a fake sidecar (a Node script that speaks the same JSON-lines protocol),
// so the test runs on Linux/CI with no Windows. The real exe is proven by hand on Windows
// (tools/agent-desktop/proof) and recorded in docs/agent-desktop.md.
const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fixtures", "fake-agent-desktop.mjs");

function surface() {
  return createAgentSurface(process.execPath, [fake]);
}

describe("AgentSurface seam", () => {
  it("opens, launches, lists, captures, inputs and closes, carrying the input-safety guard", async () => {
    const s = surface();
    const open = await s.open();
    expect(open.ok).toBe(true);
    expect(open.cursorMoved).toBe(false);
    expect(open.foregroundChanged).toBe(false);

    const launched = await s.launch("C:/Windows/System32/charmap.exe");
    expect(launched.ok).toBe(true);
    expect(launched.pid).toBeTypeOf("number");

    const wins = await s.windows();
    expect(wins.length).toBeGreaterThan(0);
    expect(wins[0].title).toBe("Character Map");

    const cap = await s.capture(wins[0].hwnd, "C:/tmp/x.png");
    expect(cap.ok).toBe(true);

    const click = await s.click(wins[0].hwnd, 10, 10);
    expect(click.ok).toBe(true);
    expect(click.cursorMoved).toBe(false);

    const typed = await s.type(wins[0].hwnd, "hi");
    expect(typed.chars).toBe(2);

    const closed = await s.close();
    expect(closed.ok).toBe(true);
  });

  it("every reply reports the guard flags", async () => {
    const s = surface();
    const r: SurfaceResult = await s.open();
    expect(r).toHaveProperty("cursorMoved");
    expect(r).toHaveProperty("foregroundChanged");
    await s.close();
  });
});
