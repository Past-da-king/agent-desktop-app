/**
 * Typing the words where the cursor is, in whatever app is in front.
 *
 * The clipboard is saved, the words are put on it, the paste keys go to the foreground window, and the old
 * clipboard comes back a moment later. On Windows the keys come from one long-lived PowerShell process that
 * compiled a few user32 calls once (keybd_event, GetAsyncKeyState) and then reads one command per line from
 * stdin, so a paste costs a line of text rather than a new process. No native module is needed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The slice of Electron's clipboard this needs. */
export interface ClipboardLike {
  readText(): string
  readHTML(): string
  readRTF(): string
  readImage(): { isEmpty(): boolean }
  write(data: { text?: string; html?: string; rtf?: string; image?: unknown }): void
  writeText(text: string): void
  clear(): void
}

export interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  image: { isEmpty(): boolean } | null
}

/** Sends the paste keys to the foreground window. False when it could not. */
export interface KeySender {
  paste(): Promise<boolean>
  /** Hides a held Alt from the app in front (see `mask` in the helper). Fire and forget. */
  mask(): void
  warm(): void
  dispose(): void
}

export function snapshot(clipboard: ClipboardLike): ClipboardSnapshot {
  const image = clipboard.readImage()
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? null : image,
  }
}

export function restore(clipboard: ClipboardLike, saved: ClipboardSnapshot): void {
  if (saved.text === '' && saved.html === '' && saved.rtf === '' && saved.image === null) {
    clipboard.clear()
    return
  }
  const data: { text?: string; html?: string; rtf?: string; image?: unknown } = {}
  if (saved.text !== '') data.text = saved.text
  if (saved.html !== '') data.html = saved.html
  if (saved.rtf !== '') data.rtf = saved.rtf
  if (saved.image !== null) data.image = saved.image
  clipboard.write(data)
}

export type TypeOutcome = 'pasted' | 'copied'

export interface TypeDeps {
  clipboard: ClipboardLike
  keys: KeySender | null
  wait?: (ms: number) => Promise<void>
  /** How long the app in front gets to read the clipboard before the old one comes back. */
  restoreAfterMs?: number
}

/** Pastes `text` at the cursor and puts the old clipboard back. Without a way to send keys the text stays copied. */
export async function typeText(text: string, deps: TypeDeps): Promise<TypeOutcome> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const saved = snapshot(deps.clipboard)
  deps.clipboard.writeText(text)
  let pasted = false
  if (deps.keys !== null) {
    try {
      pasted = await deps.keys.paste()
    } catch {
      pasted = false
    }
  }
  if (!pasted) return 'copied'
  await wait(deps.restoreAfterMs ?? 450)
  // Only put the old clipboard back if nothing else has been copied meanwhile.
  if (deps.clipboard.readText() === text) restore(deps.clipboard, saved)
  return 'pasted'
}

// ---- Windows: one PowerShell process, fed over stdin -------------------------------------------------------

/**
 * The helper. Commands, one per line: `ping <id>`, `mask <id>`, `paste <id>`. Each answers `ok <id> <detail>` or
 * `err <id> <message>` on stdout.
 *
 * `mask` taps VK 0xE8 (unassigned): a global Alt shortcut leaves the app in front seeing Alt go down and up with
 * nothing between, which opens its menu bar; the tap makes it an Alt combination instead (AutoHotkey's MenuMaskKey).
 * `paste` waits up to 1.5 s for the person to let go of Ctrl, Alt, Shift and Windows (Ctrl+Alt+V is a different
 * command in many apps), lets go of any still held, then sends Ctrl+V.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class AgentKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  const uint KEYUP = 2;
  static readonly byte[] Mods = new byte[] { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };
  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  public static bool ModsDown() { foreach (byte vk in Mods) { if (Down(vk)) return true; } return false; }
  public static int WaitForRelease(int ms) {
    int start = Environment.TickCount;
    while (ModsDown() && Environment.TickCount - start < ms) Thread.Sleep(8);
    return Environment.TickCount - start;
  }
  public static void Mask() { keybd_event(0xE8, 0, 0, UIntPtr.Zero); keybd_event(0xE8, 0, KEYUP, UIntPtr.Zero); }
  public static void ReleaseMods() { foreach (byte vk in Mods) { if (Down(vk)) keybd_event(vk, 0, KEYUP, UIntPtr.Zero); } }
  public static void Paste() {
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, KEYUP, UIntPtr.Zero);
    keybd_event(0x11, 0, KEYUP, UIntPtr.Zero);
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -lt 2) { continue }
  $id = $parts[1]
  try {
    switch ($parts[0]) {
      'ping' { $result = 'pong' }
      'mask' { [AgentKeys]::Mask(); $result = 'masked' }
      'paste' {
        $waited = [AgentKeys]::WaitForRelease(1500)
        if ([AgentKeys]::ModsDown()) { [AgentKeys]::Mask(); [AgentKeys]::ReleaseMods() }
        [AgentKeys]::Paste()
        $result = "pasted $waited"
      }
      default { $result = 'unknown' }
    }
    [Console]::Out.WriteLine("ok $id $result")
  } catch {
    [Console]::Out.WriteLine("err $id " + ($_.Exception.Message -replace '\s+', ' '))
  }
}
`

/** PowerShell's -EncodedCommand: the script as UTF-16LE, base64. No quoting can go wrong. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Where Windows PowerShell lives, and how the helper is started. */
export function helperCommand(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const root = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
  return {
    file: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').replace(/\//g, '\\'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(HELPER_SCRIPT)],
  }
}

/** One request line for the helper. */
export function helperLine(command: 'ping' | 'mask' | 'paste', id: number): string {
  return `${command} ${id}\n`
}

type Spawner = (file: string, args: string[]) => ChildProcessWithoutNullStreams

export class WindowsKeys implements KeySender {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private sequence = 0
  private readonly waiting = new Map<number, { resolve: (line: string) => void; timer: ReturnType<typeof setTimeout> }>()
  private readyWaiters: Array<() => void> = []
  private ready = false

  constructor(
    private readonly command: { file: string; args: string[] } = helperCommand(),
    private readonly spawner: Spawner = (file, args) => spawn(file, args, { windowsHide: true, stdio: 'pipe' }),
  ) {}

  warm(): void {
    this.ensure()
  }

  /** Round trip of one command. Resolves with the helper's answer line, or '' on a timeout. */
  async send(command: 'ping' | 'mask' | 'paste', timeoutMs = 4000): Promise<string> {
    const child = this.ensure()
    if (child === null) return ''
    this.sequence += 1
    const id = this.sequence
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve('')
      }, timeoutMs)
      this.waiting.set(id, { resolve, timer })
      try {
        child.stdin.write(helperLine(command, id))
      } catch {
        clearTimeout(timer)
        this.waiting.delete(id)
        resolve('')
      }
    })
  }

  async paste(): Promise<boolean> {
    return (await this.send('paste')).startsWith('ok ')
  }

  mask(): void {
    void this.send('mask', 1000)
  }

  /** Resolves once PowerShell has compiled the helper (the first start takes a second or two). */
  whenReady(timeoutMs = 8000): Promise<boolean> {
    if (this.ensure() === null) return Promise.resolve(false)
    if (this.ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  dispose(): void {
    const child = this.child
    this.child = null
    this.ready = false
    for (const [, waiter] of this.waiting) {
      clearTimeout(waiter.timer)
      waiter.resolve('')
    }
    this.waiting.clear()
    if (child !== null) {
      try {
        child.stdin.end()
        child.kill()
      } catch {
        // Already gone.
      }
    }
  }

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.child !== null) return this.child
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawner(this.command.file, this.command.args)
    } catch {
      return null
    }
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.on('data', () => undefined)
    child.on('error', () => this.onExit(child))
    child.on('exit', () => this.onExit(child))
    child.stdin.on('error', () => undefined)
    return child
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    // The next command starts a fresh helper.
    this.child = null
    this.ready = false
    for (const [, waiter] of this.waiting) {
      clearTimeout(waiter.timer)
      waiter.resolve('')
    }
    this.waiting.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    if (line === 'ready') {
      this.ready = true
      const waiters = this.readyWaiters
      this.readyWaiters = []
      for (const waiter of waiters) waiter()
      return
    }
    const match = /^(ok|err) (\d+)/.exec(line)
    if (match === null) return
    const id = Number(match[2])
    const waiter = this.waiting.get(id)
    if (waiter === undefined) return
    this.waiting.delete(id)
    clearTimeout(waiter.timer)
    waiter.resolve(line)
  }
}

// ---- macOS and Linux: degrade gracefully -------------------------------------------------------------------

/** A one-off command per paste. Fine for the platforms that only need to work, not to be fast. */
export class CommandKeys implements KeySender {
  constructor(
    private readonly file: string,
    private readonly args: string[],
  ) {}

  paste(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = spawn(this.file, this.args, { stdio: 'ignore' })
        child.on('error', () => resolve(false))
        child.on('exit', (code) => resolve(code === 0))
      } catch {
        resolve(false)
      }
    })
  }

  mask(): void {
    // Only Windows opens a menu on a lone Alt.
  }

  warm(): void {
    // Nothing to start.
  }

  dispose(): void {
    // Nothing running.
  }
}

/**
 * The key sender for this computer: the PowerShell helper on Windows, System Events on a Mac (it needs the
 * Accessibility permission), xdotool on Linux when it is installed. Null means the words are only copied.
 */
export function keySenderFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): KeySender | null {
  if (platform === 'win32') return new WindowsKeys(helperCommand(env))
  if (platform === 'darwin') {
    return new CommandKeys('/usr/bin/osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'])
  }
  const xdotool = findOnPath('xdotool', env)
  return xdotool === null ? null : new CommandKeys(xdotool, ['key', '--clearmodifiers', 'ctrl+v'])
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}
