# What was proved, and the numbers

Windows 11 Pro 26200, one 1920x1080 screen at 125%, Node 25.9, Tue 10 Nov 2026. No Agent app involved.
Other test apps were running on the computer at the time, so the timings are on a busy machine; the
ranges are over six runs.

## proof.mjs: 39 of 39 checks

Chrome on the proof site (its own throwaway profile), Edge the same (browser part, 21 of 21), and
Character Map as the native app.

| What | Chrome | Character Map |
| --- | --- | --- |
| tree, first call (the browser fills its tree on this ask) | 285 to 613 ms, 20 elements | 131 to 295 ms, 14 elements |
| tree, warm (median of 5) | 27 to 63 ms | 69 to 106 ms |
| find by exact name, first | 42 to 109 ms | 22 to 33 ms |
| find by exact name, warm (median of 10) | 25 to 66 ms | 21 to 33 ms |
| find by part of a name (reads everything) | 79 to 174 ms | |
| window with its address, first / after | 58 to 176 ms / 2 to 9 ms | |
| activeWindow | 1.3 to 2.7 ms | |
| click or key: hook to listener | 0 to 5 ms | 0 to 1 ms |
| capture of the window (PNG) | 41 to 169 ms, 1010x893 | 60 to 100 ms, 556x713 |
| capture of the display (PNG) | 87 to 436 ms, 1920x1080 | |

A walk of eight steps on the proof site (link, button, text field, dropdown, list option, checkbox,
button, and a button the save made): after each action the next target was known in 31 to 285 ms. The
slow ones are the steps right after the page drew itself again; that wait is the browser publishing
its new tree, not the lookup.

## Rectangles against true pixels, at 125%

The probe button is one flat colour. Its pixels in a screenshot: 216x51 at 52,397. The reader said
217x52 at 53,395: within 2 px on every side, the same on every run and in Edge (1 px there). The
browser rounds its own numbers on a scaled screen; the helper passes them on unchanged. In a native
app the rectangle moved by exactly what the window moved (98,50 and 1025,50).

A real click sent to 162,421 arrived as 162,421, and the page counted it: nothing is held back.

## Following

- A redraw that made the element anew elsewhere: followed in 155 to 279 ms (null, then the new place).
- A scroll: the browser itself publishes new places about 500 ms after a scroll (441 to 613 ms over
  72 small scrolls). So while the wheel turns over a browser the rectangle goes to null within 5 to
  54 ms and comes back in its new place 651 to 697 ms after the wheel. Scrolling by keyboard or by
  dragging the scroll bar still shows the old place for that half second.
- A native window dragged: followed on the next look (30 a second).

## Privacy checks

- A password field next to an ordinary one: no value, in tree or find.
- Keys sent: Escape, A, Ctrl+V, Tab. Reported: Escape, Tab, and "paste". The letter never left the helper.
- The helper's own word on its hooks: off, on while a listener exists, off again when it leaves.

## ring-proof.ts: 9 of 9 checks

The app's own overlay (main/overlay) driven by the engine's adapter and pixel conversion, on the button
the reader found in Chrome.

- With "hide guides from capture" on (the default): the overlay says shown and protected, and a screen
  capture differs by 0 pixels from the screen with no ring, by two methods: GDI BitBlt (the helper's own
  capture, and what older recorders use) and Electron desktopCapturer (what screen sharing in Chromium
  apps uses).
- With the setting off, same window, same place: the ring and its label are in both captures (17,000 to
  20,000 pixels differ), and the ring starts 0 to 2 px from the button's true pixels on all four sides.
- Setting on again: gone from capture again, live.

A protected window cannot be photographed from the same computer, which is the point; that it is on the
screen while absent from capture rests on the overlay's own state plus the setting-off capture of the
same window in the same place.

## Not proved here

- A window running as administrator (needs a UAC yes): the code answers `elevated`; not exercised live.
- A second monitor at a negative origin and mixed scales: only the mapping is unit tested; this
  computer has one screen.
- Firefox and Brave: the address bar and tree code is by control type and name, not by browser; only
  Chrome and Edge were run.
- Windows Graphics Capture called directly. The exclusion is one Windows flag for every capture path;
  two paths were measured.
- A paste from a menu is not seen (only Ctrl+V and Shift+Insert are).
