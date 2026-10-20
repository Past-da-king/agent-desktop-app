# M8b: Desktop-native, renderer

## What was built

- **Chat attachments and drop target.** Dropping files anywhere on the Chat view shows a full-sheet
  "Drop to attach" target. Paths come from `agent.files.pathsFor` (the preload resolves dropped
  `File` objects with `webUtils.getPathForFile`). Every file goes through the shared 20 MB rule in
  `@agent/core` (`attachmentProblem`); a rejected file shows a plain warning above the composer and
  nothing is attached. The attach button uses the real OS picker now (no "Coming soon"), and picked
  files carry their size so the same limit applies there too.
- **Image thumbnails.** Attachments are chips with a 24 px preview when the file is an image, and a
  sent user message shows its images at 72 px with the file name. Non-images keep the clip icon.
  Previews are data URLs, so the renderer never reads the file itself.
- **Settings > This computer.** The section now shows the computer (OS, arch, hostname), start at
  login, notifications, keep running in the tray, a real hotkey recorder (press the keys; Esc
  cancels; the accelerator is saved and re-registered by the main process), the granted folders
  list (add through the folder picker, remove with the bin button), and the shell mode
  (Ask first / Never). The hotkey registration status from `window.onHotkeyStatus` is shown under
  the recorder in plain words.
- **Connections.** A real "This computer" card at the top (machine, granted folder count, shell
  mode, Manage jumps to Settings), the built-in list made real (files, drop zone, quick ask keys),
  and the Machines entry now reads OS/arch/hostname plus the granted folder count. Other machines,
  profiles and web accounts stay visibly "Coming soon".
- **Quick Ask window.** `#/quick-window` is a small dedicated view with no title bar or shell. It
  focuses the input, sends through `chat.send`, shows "working", then the reply inline. It listens
  for `window.onQuickAsk` so reopening the window clears the last answer. Approvals and questions
  say "This needs you in the main window"; the small window cannot answer them.
- **Contract additions (additive only).** `SystemInfo`, `AgentApi.system.info()`,
  `AgentApi.files.thumbnail(path)`, and an optional `Attachment.size`. Preload, main IPC and the
  mock bridge all implement them. Thumbnails are only served for paths the person picked or dropped
  in this session, only image file types, and only files up to 8 MB.
- **Mock bridge.** The browser demo can show all of it: the picker returns one image and one PDF,
  `pathsFor` returns demo paths for dropped files, `thumbnail` draws a small SVG data URL, the
  system card reports the browser preview, and settings still save to localStorage.
- **Tests.** New `renderer-desktop.test.ts` (route, hotkey recorder, folder/file helpers, machine
  line) and an IPC contract test for `system.info` plus thumbnail path gating. Full suite: 230 tests
  passing. `bash scripts/gate.sh M8b` prints `GATE M8b PASSED`.

## Deviations and notes for the next milestone

- The thumbnail and system endpoints are new contract members. M8b is a renderer milestone, but a
  renderer cannot read an absolute file path or the hostname by itself, so the main process had to
  grow two small, read-only methods. Agent tools are unchanged.
- `Attachment` gained optional `size?: number`. The runner ignores it; the renderer uses it for the
  20 MB rule on picked files. Older rows without it still parse.
- The hotkey recorder refuses a bare key or Shift alone, requires Ctrl, Cmd or Alt, and maps Ctrl on
  Windows/Linux to `CommandOrControl` so the default keeps working across platforms. A label with
  Alt on macOS reads "Option".
- `folderName` treats `/` as its own name; empty paths and bad attachment entries are ignored.
- The quick window does not create a separate conversation: it writes into the same `chat_item`
  stream as the main window, which is what makes the reply visible in both places.
- No new dependencies.
