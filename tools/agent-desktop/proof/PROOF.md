# agent-desktop proof (Windows 11 Pro 26200 / 25H2, not admin, 11 Nov 2026)
- charmap.png: Character Map launched on the agent's own desktop (CreateDesktop on WinSta0),
  listed and captured with PrintWindow(PW_RENDERFULLCONTENT). Full render, not blank.
- edge-chromium.png: Edge (Chromium) with a fresh --user-data-dir on the agent desktop. Browser
  chrome captures; the web content area is black (GPU compositor not printable off the input desktop).
- On every command the sidecar reported cursorMoved=false and foregroundChanged=false
  (GetCursorPos + GetForegroundWindow before/after). His pointer and focus were never touched.
- Rebuild: tools/agent-desktop/build.cmd on Windows. Re-run by hand with the drive*.ps1 scripts
  the helper used (not committed); the exe speaks JSON lines over stdio (see README.md).
