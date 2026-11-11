# Focus proof (Windows test copy)

Proves that the agent's own browser does not take the keyboard from the chat box. Written 11 Nov 2026 for 0.2.129.

1. Build `win-unpacked` (or take its `resources/app.asar`) and copy an Electron shell of the same version to `C:\temp\focus-proof\shell`.
2. `powershell -File run.ps1 -Asar <app.asar> -Tag <name> -Seconds 60 -Port 9340 -Focused -Os`
   - starts a node page with a form on 127.0.0.1:8765 (the agent browser refuses 127.0.0.1, so the app maps `probe.example.com` to it),
   - starts the app with its own user data, off screen and without taking his focus (`AGENT_FOCUS_PROBE`),
   - types `source.txt` into the chat box at 6 characters a second while the agent runs open, snapshot, look, read, eval, scroll, click, type,
     select, tick, press and hover in a loop,
   - writes `result-<name>.json`: composer text vs source, focus samples every 10 ms, who held the keyboard, the guard's counters.
   - `-Os`: the typist sends each key to whoever holds the keyboard (the page during a click), as the operating system does. Without it
     every key goes to the app page, which cannot receive while the page holds the keyboard.
   - `-Focused`: tells the app it is the window he is in (the test copy is off screen), so the guard acts.
   - `-Blame`: finds the call that moves the keyboard; `-Exp`: raw one-call experiments.
3. `cdp.mjs <port> <js>` evaluates in the app page of a running test copy.
Never run it on his live app. Stop only the PIDs the script prints.
