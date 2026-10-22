/**
 * The app installs a newer version of itself from an installer file the agent was given (tools/app-control.ts
 * app_update), with no clicks:
 *
 *  1. The installer is checked: a file named like this app's own installers (`<productName>-<version>-setup.exe`),
 *     a version that is not older than this one, and an app that was installed (a development run cannot).
 *  2. A note is written to `<userData>/update-pending.json` (versions, the chat that asked, when).
 *  3. When the turn that asked has ended (so its reply is in the chat and nothing is cut off), a small detached
 *     launcher waits for this process to exit and runs the installer silently into the folder the app runs from
 *     (electron-builder NSIS: `/S` silent, `--force-run` opens the app when it is done, `/D=<dir>` last and
 *     unquoted). Then the app quits.
 *  4. On the next start `resume()` reads the note and the agent gets "[App update finished: 0.2.52 -> 0.2.53 ...]"
 *     in the same chat, so it carries on.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface PendingUpdate {
  from: string
  to: string
  chat: string
  installer: string
  at: number
}

export interface SelfUpdateDeps {
  userData: string
  currentVersion: string
  /** electron-builder productName: installers are `<productName>-<version>-setup.exe`. */
  productName: string
  /** process.execPath: the app's own exe; its folder is where the update goes. */
  execPath: string
  platform: string
  /** app.isPackaged: a development run has nothing to update. */
  packaged: boolean
  /** Is the turn in this chat still running? The restart waits for it to end. */
  busy: (chat: string) => boolean
  /** Starts the launcher detached from this process. */
  launch?: (command: string, args: string[]) => void
  /** Ends the app (app.quit). */
  quit: () => void
  log?: (message: string, detail?: Record<string, unknown>) => void
  now?: () => number
  /** How often to look whether the turn has ended, and the most to wait for it. */
  pollMs?: number
  maxWaitMs?: number
}

const NOTE_FILE = 'update-pending.json'

/** "0.2.53" from "Agent-0.2.53-setup.exe" (and pre-release tags like 0.3.0-beta.1), or null. */
export function versionOfInstaller(file: string, productName: string): string | null {
  const name = basename(file)
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)-setup\\.exe$`, 'i').exec(name)
  return match?.[1] ?? null
}

/** -1, 0 or 1, comparing the numeric parts (a pre-release tag counts as older than the plain version). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core = '', pre = ''] = v.split('-', 2)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

/** Single quotes for a PowerShell literal. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * The launcher: waits for this app's process to exit, then runs the installer silently into `dir` and lets it open
 * the app again. NSIS wants `/D=` last and unquoted, so the arguments go as one string.
 */
export function launcherScript(pid: number, installer: string, dir: string): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${pid} -Timeout 120`,
    'Start-Sleep -Milliseconds 800',
    `Start-Process -FilePath ${psQuote(installer)} -ArgumentList ${psQuote(`/S --updated --force-run /D=${dir}`)} -Wait`,
  ].join('; ')
}

function defaultLaunch(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

export class SelfUpdater {
  private scheduled = false
  private readonly now: () => number

  constructor(private readonly deps: SelfUpdateDeps) {
    this.now = deps.now ?? Date.now
  }

  currentVersion(): string {
    return this.deps.currentVersion
  }

  private get noteFile(): string {
    return join(this.deps.userData, NOTE_FILE)
  }

  /** Checks the installer and, when it is fine, schedules the install and restart for when the turn has ended. */
  async install(path: string, chat: string): Promise<{ ok: boolean; text: string; from?: string; to?: string }> {
    const from = this.deps.currentVersion
    if (this.deps.platform !== 'win32') return { ok: false, text: 'Updating itself from an installer works on Windows only.' }
    if (!this.deps.packaged) return { ok: false, text: 'This is a development run of the app, not an installed one: there is nothing to update.' }
    if (this.scheduled) return { ok: false, text: 'An update is already waiting for this turn to end.' }
    if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, text: `There is no file at ${path}.` }
    const to = versionOfInstaller(path, this.deps.productName)
    if (to === null) return { ok: false, text: `${basename(path)} is not an installer of this app: they are named ${this.deps.productName}-<version>-setup.exe.` }
    if (compareVersions(to, from) < 0) return { ok: false, text: `That installer is ${to}, older than this app (${from}). Nothing was done.` }
    const note: PendingUpdate = { from, to, chat, installer: path, at: this.now() }
    writeFileSync(this.noteFile, JSON.stringify(note, null, 2), 'utf8')
    this.scheduled = true
    this.deps.log?.('Update scheduled', { from, to })
    void this.whenIdle(chat).then(() => this.go(path))
    const same = compareVersions(to, from) === 0
    return {
      ok: true,
      from,
      to,
      text:
        `${same ? `Reinstalling ${to}` : `Updating ${from} -> ${to}`}: when this reply is done the app closes, installs silently and opens again (about a minute). ` +
        'You will get a note in this chat when it is back. Tell the person the app is restarting for the update; do not start other work in this turn.',
    }
  }

  private async whenIdle(chat: string): Promise<void> {
    const poll = this.deps.pollMs ?? 500
    const max = this.deps.maxWaitMs ?? 10 * 60_000
    const start = this.now()
    // The tool call itself is part of the turn: wait for the turn to end, then a moment for the reply to be saved.
    let idleSince: number | null = null
    while (this.now() - start < max) {
      await new Promise((resolve) => setTimeout(resolve, poll))
      if (this.deps.busy(chat)) idleSince = null
      else if (idleSince === null) idleSince = this.now()
      else if (this.now() - idleSince >= poll * 2) return
    }
  }

  private go(installer: string): void {
    const dir = dirname(this.deps.execPath)
    const launch = this.deps.launch ?? defaultLaunch
    try {
      launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', launcherScript(process.pid, installer, dir)])
    } catch (error) {
      this.scheduled = false
      rmSync(this.noteFile, { force: true })
      this.deps.log?.('Update could not start', { message: error instanceof Error ? error.message : String(error) })
      return
    }
    this.deps.log?.('Update starting: quitting for the installer', { dir })
    this.deps.quit()
  }

  /** On start: the update that was waiting, read once (the note is removed), or null. */
  resume(): (PendingUpdate & { now: string; ok: boolean }) | null {
    let note: PendingUpdate
    try {
      note = JSON.parse(readFileSync(this.noteFile, 'utf8')) as PendingUpdate
    } catch {
      return null
    }
    rmSync(this.noteFile, { force: true })
    if (typeof note.from !== 'string' || typeof note.to !== 'string') return null
    const now = this.deps.currentVersion
    return { ...note, chat: typeof note.chat === 'string' && note.chat !== '' ? note.chat : 'main', now, ok: compareVersions(now, note.to) >= 0 }
  }
}

/** The line the agent gets in the chat after the restart. */
export function resumeNote(done: PendingUpdate & { now: string; ok: boolean }): string {
  return done.ok
    ? `[App update finished: ${done.from} -> ${done.now}. The app restarted on the new version. Carry on with what you were doing before the update, and tell the person it is done.]`
    : `[App update did not take: the app is still on ${done.now} (wanted ${done.to}, from ${basename(done.installer)}). Tell the person, and carry on with what you were doing.]`
}
