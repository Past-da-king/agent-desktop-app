/**
 * The app installs an update of itself (main/self-update.ts): checks the installer, waits for the turn that asked to
 * end, starts the launcher through WMI outside the app's process tree, quits only once the launcher runs; the
 * launcher waits for the app, frees the folder, runs the installer, checks the version, puts the old one back on a
 * failure and reopens the app; on the next start the agent hears the real outcome in the same chat.
 *
 * The Windows-only part runs the real launcher script against a fake install folder (real WMI start, a real file
 * held open, real installer exit codes, a real rollback).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  INSTALL_CMD,
  LAUNCHER_PS1,
  SelfUpdater,
  compareVersions,
  failureReason,
  launcherCommandLine,
  resumeNote,
  startViaWmi,
  versionOfInstaller,
  type LauncherResult,
  type SelfUpdateDeps,
} from '../src/main/self-update'

const dirs: string[] = []
const children: ChildProcess[] = []
/** Stops what a Windows test started from inside its own temp folder (an app the launcher reopened); only that folder, never by name. */
function stopUnder(dir: string): void {
  if (process.platform !== 'win32') return
  try {
    execFileSync(
      join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:UNDER, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { env: { ...process.env, UNDER: dir + '\\' }, windowsHide: true, timeout: 20_000 },
    )
  } catch {
    // Nothing to stop.
  }
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of dirs) stopUnder(dir)
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch {
      // A process the test started may still be closing; the temp folder is cleaned up later.
    }
  }
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-upd-'))
  dirs.push(dir)
  return dir
}

interface Rig {
  updater: SelfUpdater
  dir: string
  started: string[]
  quits: number[]
  told: Array<{ chat: string; text: string }>
  busy: { on: boolean }
}

/** A launcher that "runs" by writing the ready line to the log named in its parameters file. */
type Behave = 'ready' | 'silent' | 'throw' | 'no-watchdog' | 'watchdog-throws'

function fakeStart(started: string[], behave: Behave = 'ready'): (commandLine: string) => Promise<number> {
  return async (commandLine) => {
    started.push(commandLine)
    const watchdog = / -Role watchdog$/.test(commandLine)
    if (behave === 'throw' || (behave === 'watchdog-throws' && watchdog)) throw new Error(watchdog ? 'Win32_Process.Create returned 8' : 'Windows could not start the update launcher through WMI: Win32_Process.Create returned 9')
    const params = /"([^"]+params\.json)"/.exec(commandLine)?.[1]
    const says = behave === 'ready' || behave === 'watchdog-throws' || (behave === 'no-watchdog' && !watchdog)
    if (says && params !== undefined) {
      const values = JSON.parse(readFileSync(params, 'utf8')) as { log: string }
      appendFileSync(values.log, watchdog ? '2026-10-28T00:00:00Z [watchdog] watchdog running pid 4322\n' : '2026-10-28T00:00:00Z [launcher] launcher running pid 4321\n')
    }
    return watchdog ? 4322 : 4321
  }
}

function setup(patch: Partial<SelfUpdateDeps> = {}, behave: Behave = 'ready'): Rig {
  const dir = temp()
  const started: string[] = []
  const quits: number[] = []
  const told: Array<{ chat: string; text: string }> = []
  const busy = { on: true }
  const updater = new SelfUpdater({
    userData: dir,
    currentVersion: '0.2.52',
    productName: 'Agent',
    execPath: join(dir, 'app', 'Agent.exe'),
    platform: 'win32',
    packaged: true,
    busy: () => busy.on,
    startLauncher: fakeStart(started, behave),
    quit: () => void quits.push(Date.now()),
    tell: (chat, text) => void told.push({ chat, text }),
    pid: 999_999,
    relaunchEnv: { AGENT_USER_DATA: 'C:\\data' },
    pollMs: 5,
    launcherReadyMs: 300,
    ...patch,
  })
  return { updater, dir, started, quits, told, busy }
}

function installer(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, 'MZ')
  return path
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
}

function result(patch: Partial<LauncherResult>): LauncherResult {
  return {
    version: 2, wanted: '0.2.53', stage: 'done', ok: false, appExited: true, forced: false, killed: [], locked: null, installerExit: null,
    installedVersion: null, rolledBack: false, relaunched: true, error: null, startedAt: '', finishedAt: '', ...patch,
  }
}

describe('self update', () => {
  it('reads the version from the installer name and compares versions', () => {
    expect(versionOfInstaller('C:\\x\\Agent-0.2.53-setup.exe', 'Agent')).toBe('0.2.53')
    expect(versionOfInstaller('/x/Agent-1.0.0-beta.2-setup.exe', 'Agent')).toBe('1.0.0-beta.2')
    expect(versionOfInstaller('/x/Other-0.2.53-setup.exe', 'Agent')).toBeNull()
    expect(compareVersions('0.2.53', '0.2.52')).toBe(1)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('0.2.52', '0.2.52')).toBe(0)
  })

  it('refuses what it cannot install, without touching anything', async () => {
    const { updater, dir, started } = setup()
    expect((await updater.install(join(dir, 'missing.exe'), 'main')).text).toMatch(/no file/)
    expect((await updater.install(installer(dir, 'Thing-1.0.0-setup.exe'), 'main')).text).toMatch(/not an installer of this app/)
    expect((await updater.install(installer(dir, 'Agent-0.2.40-setup.exe'), 'main')).text).toMatch(/older/)
    expect((await setup({ packaged: false }).updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'main')).text).toMatch(/development run/)
    expect((await setup({ platform: 'linux' }).updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'main')).text).toMatch(/Windows only/)
    expect(started).toEqual([])
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false)
  })

  it('the launcher is started outside the app (not as a detached child) with a script and parameters for this exact install', async () => {
    const { updater, dir, started, quits, busy } = setup()
    const path = installer(dir, 'Agent-0.2.53-setup.exe')
    expect((await updater.install(path, 'chat_42')).ok).toBe(true)
    busy.on = false
    await until(() => quits.length > 0)
    // Two separate processes: the launcher, and the watchdog that finishes the update if the launcher is killed.
    expect(started).toHaveLength(2)
    expect(started[1]).toMatch(/ -File "[^"]+launcher\.ps1" "[^"]+params\.json" -Role watchdog$/)
    const line = started[0]!
    expect(line).toMatch(/powershell\.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "[^"]+launcher\.ps1" "[^"]+params\.json"$/)
    const params = JSON.parse(readFileSync(/"([^"]+params\.json)"/.exec(line)![1]!, 'utf8')) as Record<string, unknown>
    expect(params).toMatchObject({
      appPid: 999_999,
      installDir: join(dir, 'app'),
      exe: join(dir, 'app', 'Agent.exe'),
      installer: path,
      wanted: '0.2.53',
      env: { AGENT_USER_DATA: 'C:\\data' },
    })
    const script = readFileSync(/"([^"]+launcher\.ps1)"/.exec(line)![1]!, 'utf8')
    // The installer goes into the folder the app runs from, /D= last; the launcher (not the installer) reopens the app.
    expect(INSTALL_CMD).toContain('/S --updated /D=%~2')
    expect(INSTALL_CMD).not.toContain('--force-run')
    // Never the shell's Start-Process on the installer (its Open File - Security Warning hung the launcher, invisibly).
    expect(script).not.toMatch(/Start-Process\s+-FilePath\s+$p\.installer/)
    expect(script).toContain('Unblock-File')
    expect(script).toContain('UseShellExecute = $false')
    expect(script).toContain('$proc.ExitCode')
    expect(script).toContain('VersionInfo.ProductVersion')
    expect(script).toContain('AgentRmHolders')
    // The note now points at this attempt's folder and launcher.
    expect(JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'))).toMatchObject({ to: '0.2.53', chat: 'chat_42', launcher: 4321, watchdog: 4322 })
  })

  it('waits for the turn to end before anything starts', async () => {
    const { updater, dir, started, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    expect((await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')).text).toMatch(/already waiting/)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(started).toEqual([])
    expect(quits).toEqual([])
    busy.on = false
    await until(() => quits.length > 0)
    expect(quits).toHaveLength(1)
  })

  it('never quits into nothing: a launcher or watchdog that cannot start, or never runs, leaves the app up and tells the chat why', async () => {
    for (const behave of ['throw', 'silent', 'no-watchdog', 'watchdog-throws'] as const) {
      const { updater, dir, quits, told, busy } = setup({}, behave)
      await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_7')
      busy.on = false
      await until(() => told.length > 0)
      expect(quits).toEqual([])
      expect(told[0]?.chat).toBe('chat_7')
      expect(told[0]?.text).toMatch(
        behave === 'throw' ? /Win32_Process\.Create returned 9/ : behave === 'watchdog-throws' ? /watchdog could not start: .*returned 8/ : behave === 'no-watchdog' ? /update watchdog \(process 4322\) started but never ran its script/ : /started but never ran its script/,
      )
      expect(told[0]?.text).toContain('still on 0.2.52')
      expect(existsSync(join(dir, 'update-pending.json'))).toBe(false)
      // It can be tried again.
      expect((await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_7')).ok).toBe(true)
    }
  })

  it('after the restart: success names the installed and the running version', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(join(note.work, 'result.json'), '\uFEFF' + JSON.stringify(result({ ok: true, installerExit: 0, installedVersion: '0.2.53.0' })))
    const after = setup({ userData: dir, currentVersion: '0.2.53' }).updater.resume()
    expect(after).toMatchObject({ from: '0.2.52', to: '0.2.53', now: '0.2.53', chat: 'chat_42', ok: true })
    expect(resumeNote(after!)).toContain('App update finished: 0.2.52 -> 0.2.53')
    expect(resumeNote(after!)).toContain('installed exe reports 0.2.53.0, running 0.2.53')
    expect(setup({ userData: dir }).updater.resume()).toBeNull()
  })

  it('after the restart: a failure says the real reason, never just "did not take"', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(
      join(note.work, 'result.json'),
      JSON.stringify(
        result({
          stage: 'checking that no file is in use',
          error: 'a file of the app is still in use after 20 s: C:\\Apps\\Agent\\resources\\app.asar, held by node.exe (pid 77, C:\\node\\node.exe)',
          locked: { file: 'C:\\Apps\\Agent\\resources\\app.asar', holders: [{ pid: 77, name: 'node.exe', path: 'C:\\node\\node.exe' }] },
          killed: [{ pid: 55, name: 'claude.exe', path: 'C:\\Apps\\Agent\\resources\\app.asar.unpacked\\claude.exe' }],
          installedVersion: '0.2.52.0',
        }),
      ),
    )
    const after = setup({ userData: dir, currentVersion: '0.2.52' }).updater.resume()!
    expect(after.ok).toBe(false)
    const text = resumeNote(after)
    expect(text).not.toMatch(/did not take/)
    expect(text).toContain('App update FAILED: wanted 0.2.53')
    expect(text).toContain('app.asar, held by node.exe (pid 77')
    expect(text).toContain('had to stop claude.exe (pid 55)')
    expect(text).toContain(join(note.work, 'launcher.log'))

    expect(failureReason({ from: '0.2.52', to: '0.2.53', chat: 'main', installer: 'x', at: 1, work: 'W' }, '0.2.52', result({ stage: 'running the installer', error: 'the installer failed with exit code 2', installerExit: 2, rolledBack: true }), 'W')).toMatch(
      /exit code 2 = aborted by the installer .*previous version was put back/,
    )
    const silent = failureReason({ from: '0.2.52', to: '0.2.53', chat: 'main', installer: 'x', at: 1, work: join(dir, 'nowhere') }, '0.2.52', null, join(dir, 'nowhere'))
    expect(silent).toMatch(/left no result at .*result\.json and no log at .*launcher\.log/)
  })

  it('a reinstall of the same version that failed is a failure, though the running version matches', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.52-setup.exe'), 'chat_9')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(
      join(note.work, 'result.json'),
      JSON.stringify(result({ wanted: '0.2.52', stage: 'checking that no file is in use', error: 'a file of the app is still in use after 20 s: C:\\A\\resources\\app.asar, held by node.exe (pid 18560, C:\\node.exe)' })),
    )
    const after = setup({ userData: dir, currentVersion: '0.2.52' }).updater.resume()!
    expect(after.ok).toBe(false)
    expect(resumeNote(after)).toMatch(/FAILED: wanted 0\.2\.52 .* Reason: while checking that no file is in use: .*app\.asar, held by node\.exe \(pid 18560/)
  })

  it('after the restart: a launcher that was killed and finished by the watchdog says so', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(join(note.work, 'result.json'), JSON.stringify(result({ ok: true, installerExit: 0, installedVersion: '0.2.53.0', launcherDied: 'running the installer', recoveredBy: 'watchdog', finalized: true, appUp: true })))
    const after = setup({ userData: dir, currentVersion: '0.2.53' }).updater.resume()!
    expect(after.ok).toBe(true)
    expect(resumeNote(after)).toContain('The launcher was killed while running the installer; the watchdog recovered and finished the update.')
  })

  it('after the restart: when the new version would not start and the old one was put back, the reason says so', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(join(note.work, 'result.json'), JSON.stringify(result({ ok: false, installerExit: 0, installedVersion: '0.2.52.0', rolledBack: true, error: 'the new version 0.2.53 would not start', launcherDied: 'opening the app', recoveredBy: 'watchdog', finalized: true, appUp: true })))
    const after = setup({ userData: dir, currentVersion: '0.2.52' }).updater.resume()!
    expect(after.ok).toBe(false)
    const text = resumeNote(after)
    expect(text).toContain('the launcher was killed or stuck while opening the app and the watchdog finished the update')
    expect(text).toContain('would not start')
    expect(text).toContain('previous version was put back')
  })

  it('after the restart: a launcher that left no word and no watchdog finished is reported as exactly that', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(join(note.work, 'result.json'), JSON.stringify(result({ ok: false, stage: 'running the installer', relaunched: false })))
    const text = resumeNote(setup({ userData: dir, currentVersion: '0.2.52' }).updater.resume()!)
    expect(text).toContain('the launcher stopped while running the installer and nothing finished the update')
  })

  it('after the restart: waits for the launcher to write its last word before reading the outcome', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    const file = join(note.work, 'result.json')
    // The new app is already running, the launcher is still checking that it is up.
    writeFileSync(file, JSON.stringify(result({ ok: false, stage: 'opening the app', finalized: false })))
    setTimeout(() => writeFileSync(file, JSON.stringify(result({ ok: true, installedVersion: '0.2.53.0', stage: 'done', finalized: true }))), 300)
    const next = setup({ userData: dir, currentVersion: '0.2.53' }).updater
    const began = Date.now()
    await next.settle(5000, 60_000, 20)
    expect(Date.now() - began).toBeGreaterThanOrEqual(250)
    expect(next.resume()).toMatchObject({ ok: true })
  })

  it('after the restart: does not wait for a launcher that went quiet', async () => {
    const { updater, dir, quits, busy } = setup()
    await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_42')
    busy.on = false
    await until(() => quits.length > 0)
    const note = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8')) as { work: string }
    writeFileSync(join(note.work, 'result.json'), JSON.stringify(result({ ok: false, stage: 'opening the app', finalized: false })))
    const began = Date.now()
    await setup({ userData: dir, currentVersion: '0.2.52' }).updater.settle(5000, 0, 20)
    expect(Date.now() - began).toBeLessThan(1000)
  })
  it('an old-style note (from a version before this launcher) still reports', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ from: '0.2.52', to: '0.2.53', chat: '', installer: 'Agent-0.2.53-setup.exe', at: 1 }))
    const after = setup({ userData: dir, currentVersion: '0.2.52' }).updater.resume()
    expect(after).toMatchObject({ ok: false, chat: 'main' })
    expect(resumeNote(after!)).toMatch(/FAILED: wanted 0\.2\.53 .* running 0\.2\.52\. Reason: the app was started again on 0\.2\.52 without the update having run/)
  })
})

// ---- the real launcher, on Windows --------------------------------------------------------------------------------

const onWindows = process.platform === 'win32'
const PS = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** A tiny windowless exe with a product version; when run it appends "<version> <AGENT_USER_DATA>" to `marker`. */
function makeApp(path: string, version: string, marker: string, behaviour: 'stays' | 'dies' = 'stays'): void {
  const cs = `using System; using System.IO; using System.Reflection; using System.Threading;
[assembly: AssemblyInformationalVersion("${version}")]
class P { static void Main() { File.AppendAllText(@"${marker}", "${version} " + Environment.GetEnvironmentVariable("AGENT_USER_DATA") + Environment.NewLine); ${behaviour === 'stays' ? 'Thread.Sleep(120000);' : ''} } }`
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition $env:CS -OutputAssembly $env:OUT -OutputType WindowsApplication`], {
    env: { ...process.env, CS: cs, OUT: path },
    windowsHide: true,
  })
}

/** A windowless fake installer: logs its arguments, optionally deletes then copies files, exits with `code`. */
function makeInstaller(path: string, opts: { from?: string; to: string; deleteFirst?: string[]; code: number; argsLog: string; sleepMs?: number }): void {
  const del = (opts.deleteFirst ?? []).map((f) => `try { File.Delete(@"${f}"); } catch {}`).join(' ')
  const copy = opts.from !== undefined ? `File.Copy(@"${opts.from}", @"${opts.to}", true);` : ''
  const cs = `using System; using System.IO;
class P { static int Main(string[] a) { File.AppendAllText(@"${opts.argsLog}", string.Join(" ", a) + Environment.NewLine); System.Threading.Thread.Sleep(${opts.sleepMs ?? 0}); ${del} ${copy} return ${opts.code}; } }`
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition $env:CS -OutputAssembly $env:OUT -OutputType WindowsApplication`], {
    env: { ...process.env, CS: cs, OUT: path },
    windowsHide: true,
  })
}

interface Bed {
  root: string
  appDir: string
  exe: string
  marker: string
  argsLog: string
  appPid: number
}

/** A fake installed app at 0.2.52 with a stand-in "app process" (a sleeping node) that exits after `exitAfterMs`. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function bed(exitAfterMs = 1500, oldApp: 'stays' | 'dies' = 'stays'): Bed {
  const root = temp()
  const appDir = join(root, 'Programs', 'Agent Test')
  mkdirSync(join(appDir, 'resources'), { recursive: true })
  const marker = join(root, 'started.txt')
  const exe = join(appDir, 'AgentTest.exe')
  makeApp(exe, '0.2.52', marker, oldApp)
  writeFileSync(join(appDir, 'resources', 'app.asar'), 'old app')
  // The stand-in for the running app is a tiny exe INSIDE the install folder: the launcher only ever stops processes of its own update.
  const standIn = join(appDir, 'standin.exe')
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition $env:CS -OutputAssembly $env:OUT -OutputType WindowsApplication`], {
    env: { ...process.env, CS: `class P { static void Main() { System.Threading.Thread.Sleep(${exitAfterMs}); } }`, OUT: standIn },
    windowsHide: true,
  })
  const app = spawn(standIn, [], { stdio: 'ignore', windowsHide: true })
  children.push(app)
  return { root, appDir, exe, marker, argsLog: join(root, 'installer-args.txt'), appPid: app.pid! }
}

interface Run {
  work: string
  launcher: number
  watchdog: number
}

/** Starts the launcher and the watchdog the way the app does: both through WMI, outside this process. */
async function startBoth(b: Bed, installerPath: string, wanted: string, extra: Record<string, unknown> = {}): Promise<Run> {
  const work = join(b.root, 'work')
  mkdirSync(work, { recursive: true })
  const script = join(work, 'launcher.ps1')
  writeFileSync(script, '\uFEFF' + LAUNCHER_PS1.replace(/\r?\n/g, '\r\n'), 'utf8')
  const params = join(work, 'params.json')
  writeFileSync(join(work, 'install.cmd'), INSTALL_CMD, 'utf8')
  writeFileSync(
    params,
    JSON.stringify({
      appPid: b.appPid, installDir: b.appDir, exe: b.exe, installer: installerPath, wanted,
      result: join(work, 'result.json'), log: join(work, 'launcher.log'), backup: join(b.root, 'backup'),
      env: { AGENT_USER_DATA: 'C:\\test-data' }, exitTimeoutSec: 20, settleTimeoutSec: 5, lockTimeoutSec: 3, installerTimeoutSec: 60,
      appName: 'AgentTest', installCmd: join(work, 'install.cmd'), installerExitFile: join(work, 'installer.exit'),
      appUpSec: 6, stageLimitSec: 60, watchdogMaxSec: 240, noteDir: b.root, noToast: true, ...extra,
    }),
  )
  const launcher = await startViaWmi(launcherCommandLine(script, params))
  const watchdog = await startViaWmi(launcherCommandLine(script, params, undefined, 'watchdog'))
  expect(launcher).toBeGreaterThan(0)
  expect(watchdog).toBeGreaterThan(0)
  return { work, launcher, watchdog }
}

function readResult(run: Run): LauncherResult | null {
  try {
    return JSON.parse(readFileSync(join(run.work, 'result.json'), 'utf8').replace(/^\uFEFF/, '')) as LauncherResult
  } catch {
    return null
  }
}

/** Waits until whoever finishes the update has said so. */
async function finished(run: Run, ms = 90_000): Promise<LauncherResult> {
  await until(() => readResult(run)?.finalized === true, ms)
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (process.env['UPD_DEBUG'] !== undefined) console.log(readFileSync(join(run.work, 'launcher.log'), 'utf8'))
  return readResult(run)!
}

async function runLauncher(b: Bed, installerPath: string, wanted: string, extra: Record<string, unknown> = {}): Promise<LauncherResult> {
  return finished(await startBoth(b, installerPath, wanted, extra))
}
describe.runIf(onWindows)('the update launcher on Windows (real WMI start, real files)', () => {
  it('waits for the app, installs into its folder, checks the version, reopens it with its environment', async () => {
    const b = bed()
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53')
    expect(r).toMatchObject({ ok: true, stage: 'done', appExited: true, forced: false, installerExit: 0, installedVersion: '0.2.53', rolledBack: false, relaunched: true, appUp: true, finalized: true, launcherDied: null, recoveredBy: null, error: null })
    expect(readFileSync(b.argsLog, 'utf8').trim()).toBe(`/S --updated /D=${b.appDir}`)
    await until(() => existsSync(b.marker))
    expect(readFileSync(b.marker, 'utf8')).toContain('0.2.53 C:\\test-data')
    expect(existsSync(join(b.root, 'backup'))).toBe(false)
  }, 90_000)

  it('a file held open: does not run the installer, names the file and the process holding it, reopens the old app', async () => {
    const b = bed(500)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { to: b.exe, code: 0, argsLog: b.argsLog })
    const held = openSync(join(b.appDir, 'resources', 'app.asar'), 'r')
    try {
      const r = await runLauncher(b, setup, '0.2.53')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('still in use')
      expect(r.locked?.file).toBe(join(b.appDir, 'resources', 'app.asar'))
      expect(r.locked?.holders.map((h) => h.pid)).toContain(process.pid)
      expect(r.error).toContain(`app.asar, held by node.exe (pid ${process.pid}`)
      expect(r.installerExit).toBeNull()
      expect(existsSync(b.argsLog)).toBe(false)
      expect(r.relaunched).toBe(true)
      await until(() => existsSync(b.marker))
      expect(readFileSync(b.marker, 'utf8')).toContain('0.2.52')
    } finally {
      closeSync(held)
    }
  }, 90_000)

  it('an installer that fails half way (exit 2 after deleting files) is rolled back and the old app reopens', async () => {
    const b = bed(500)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { to: b.exe, deleteFirst: [b.exe, join(b.appDir, 'resources', 'app.asar')], code: 2, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53')
    expect(r).toMatchObject({ ok: false, installerExit: 2, rolledBack: true, installedVersion: '0.2.52', relaunched: true })
    expect(r.error).toContain('exit code 2')
    expect(readFileSync(join(b.appDir, 'resources', 'app.asar'), 'utf8')).toBe('old app')
    await until(() => existsSync(b.marker))
    expect(readFileSync(b.marker, 'utf8')).toContain('0.2.52')
  }, 90_000)

  it('an app that will not exit is stopped after the timeout, and leftovers from its folder are stopped too', async () => {
    const b = bed(600_000)
    const leftover = join(b.appDir, 'helper.exe')
    writeFileSync(leftover, readFileSync(process.execPath))
    const child = spawn(leftover, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
    children.push(child)
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53', { exitTimeoutSec: 2, settleTimeoutSec: 1 })
    expect(r).toMatchObject({ ok: true, forced: true, installedVersion: '0.2.53' })
    expect(r.killed.map((k) => k.pid)).toContain(child.pid)
  }, 90_000)

  it('an installer file that came off the internet (Mark of the Web) does not hang the launcher on an invisible Security Warning', async () => {
    const b = bed()
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    writeFileSync(`${setup}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=http://example.invalid/Agent-0.2.53-setup.exe\r\n')
    const r = await runLauncher(b, setup, '0.2.53')
    expect(r).toMatchObject({ ok: true, installedVersion: '0.2.53', appUp: true, launcherDied: null })
    expect(() => readFileSync(`${setup}:Zone.Identifier`)).toThrow()
  }, 120_000)

  it('never stops a process that is not part of its own update, even when it is the pid it was given', async () => {
    const outsider = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true })
    children.push(outsider)
    const b = bed()
    b.appPid = outsider.pid!
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53', { exitTimeoutSec: 2 })
    expect(isRunning(outsider.pid!)).toBe(true)
    expect(r.forced).toBe(false)
    expect(readFileSync(join(b.root, 'work', 'launcher.log'), 'utf8')).toContain('is not part of this update')
  }, 120_000)

  it('the watchdog stays out of it when the launcher finishes the job', async () => {
    const b = bed()
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    const run = await startBoth(b, setup, '0.2.53')
    const r = await finished(run)
    expect(r).toMatchObject({ ok: true, recoveredBy: null })
    await until(() => !isRunning(run.watchdog), 15_000)
    expect(isRunning(run.watchdog)).toBe(false)
    expect(readFileSync(join(run.work, 'launcher.log'), 'utf8')).toContain('the launcher finished the job: nothing to do')
  }, 120_000)

  it('the launcher is killed in the middle of the install: the watchdog waits for the installer, keeps the new version and reopens the app', async () => {
    const b = bed()
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog, sleepMs: 8000 })
    const run = await startBoth(b, setup, '0.2.53')
    await until(() => existsSync(b.argsLog), 60_000)
    expect(existsSync(b.argsLog)).toBe(true)
    process.kill(run.launcher)
    const r = await finished(run)
    expect(r).toMatchObject({ ok: true, launcherDied: 'running the installer', recoveredBy: 'watchdog', installerExit: 0, installedVersion: '0.2.53', appUp: true, rolledBack: false })
    await until(() => existsSync(b.marker))
    expect(readFileSync(b.marker, 'utf8')).toContain('0.2.53 C:\\test-data')
  }, 120_000)

  it('the launcher AND the installer are cut off half way: the watchdog puts the old version back and reopens it', async () => {
    const b = bed()
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { to: b.exe, deleteFirst: [b.exe, join(b.appDir, 'resources', 'app.asar')], code: 0, argsLog: b.argsLog, sleepMs: 30_000 })
    const run = await startBoth(b, setup, '0.2.53')
    await until(() => existsSync(b.argsLog), 60_000)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    process.kill(run.launcher)
    // Everything of the install: the batch file's cmd and the installer itself.
    execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like $env:PAT) -or $_.ExecutablePath -eq $env:SETUP } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { env: { ...process.env, SETUP: setup, PAT: '*install.cmd*' }, windowsHide: true })
    const r = await finished(run)
    expect(r).toMatchObject({ ok: false, launcherDied: 'running the installer', recoveredBy: 'watchdog', rolledBack: true, installedVersion: '0.2.52', appUp: true })
    expect(r.error).toMatch(/cut off|exit code/)
    expect(readFileSync(join(b.appDir, 'resources', 'app.asar'), 'utf8')).toBe('old app')
    await until(() => existsSync(b.marker))
    expect(readFileSync(b.marker, 'utf8')).toContain('0.2.52')
  }, 120_000)

  it('a launcher stuck in a stage is stopped by the watchdog, which still reopens the app', async () => {
    const b = bed(600_000)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53', { exitTimeoutSec: 600, stageLimitSec: 4 })
    expect(r).toMatchObject({ ok: false, launcherDied: 'waiting for the app to exit', recoveredBy: 'watchdog', appUp: true })
    expect(existsSync(b.argsLog)).toBe(false)
  }, 150_000)

  it('the new exe refuses to start: it is tried twice, the old version is put back and opens', async () => {
    const b = bed()
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker, 'dies')
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53')
    expect(r).toMatchObject({ ok: false, installerExit: 0, rolledBack: true, installedVersion: '0.2.52', appUp: true, failed: false })
    expect(r.error).toContain('would not start')
    await until(() => (existsSync(b.marker) ? readFileSync(b.marker, 'utf8').includes('0.2.52') : false))
    const starts = readFileSync(b.marker, 'utf8').trim().split(/\r?\n/)
    expect(starts.filter((l) => l.startsWith('0.2.53'))).toHaveLength(2)
    expect(starts.filter((l) => l.startsWith('0.2.52')).length).toBeGreaterThanOrEqual(1)
  }, 150_000)

  it('nothing will start at all: the update says so loudly (result, log, a note on the Desktop and a toast) instead of a silent dead app', async () => {
    const b = bed(500, 'dies')
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker, 'dies')
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53')
    expect(r).toMatchObject({ ok: false, appUp: false, failed: true, finalized: true, rolledBack: true })
    expect(r.toast).toBeTruthy()
    const note = readFileSync(join(b.root, 'AgentTest update failed.txt'), 'utf8')
    expect(note).toContain('could not be opened again')
    expect(note).toContain('launcher.log')
  }, 180_000)})
