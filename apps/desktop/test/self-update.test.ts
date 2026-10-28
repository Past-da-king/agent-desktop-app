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
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
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
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
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
function fakeStart(started: string[], behave: 'ready' | 'silent' | 'throw' = 'ready'): (commandLine: string) => Promise<number> {
  return async (commandLine) => {
    started.push(commandLine)
    if (behave === 'throw') throw new Error('Windows could not start the update launcher through WMI: Win32_Process.Create returned 9')
    const params = /"([^"]+params\.json)"/.exec(commandLine)?.[1]
    if (behave === 'ready' && params !== undefined) {
      const values = JSON.parse(readFileSync(params, 'utf8')) as { log: string }
      writeFileSync(values.log, '2026-10-28T00:00:00Z launcher running pid 4321\n')
    }
    return 4321
  }
}

function setup(patch: Partial<SelfUpdateDeps> = {}, behave: 'ready' | 'silent' | 'throw' = 'ready'): Rig {
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
    version: 1, wanted: '0.2.53', stage: 'done', ok: false, appExited: true, forced: false, killed: [], locked: null, installerExit: null,
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
    expect(started).toHaveLength(1)
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
    expect(script).toContain("'/S --updated /D=' + $dir")
    expect(script).not.toContain('--force-run')
    expect(script).toContain('$proc.ExitCode')
    expect(script).toContain('VersionInfo.ProductVersion')
    expect(script).toContain('AgentRmHolders')
    // The note now points at this attempt's folder and launcher.
    expect(JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'))).toMatchObject({ to: '0.2.53', chat: 'chat_42', launcher: 4321 })
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

  it('never quits into nothing: a launcher that cannot start, or never runs, leaves the app up and tells the chat why', async () => {
    for (const behave of ['throw', 'silent'] as const) {
      const { updater, dir, quits, told, busy } = setup({}, behave)
      await updater.install(installer(dir, 'Agent-0.2.53-setup.exe'), 'chat_7')
      busy.on = false
      await until(() => told.length > 0)
      expect(quits).toEqual([])
      expect(told[0]?.chat).toBe('chat_7')
      expect(told[0]?.text).toMatch(behave === 'throw' ? /Win32_Process\.Create returned 9/ : /started but never ran its script/)
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
function makeApp(path: string, version: string, marker: string): void {
  const cs = `using System; using System.IO; using System.Reflection;
[assembly: AssemblyInformationalVersion("${version}")]
class P { static void Main() { File.AppendAllText(@"${marker}", "${version} " + Environment.GetEnvironmentVariable("AGENT_USER_DATA") + Environment.NewLine); } }`
  execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition $env:CS -OutputAssembly $env:OUT -OutputType WindowsApplication`], {
    env: { ...process.env, CS: cs, OUT: path },
    windowsHide: true,
  })
}

/** A windowless fake installer: logs its arguments, optionally deletes then copies files, exits with `code`. */
function makeInstaller(path: string, opts: { from?: string; to: string; deleteFirst?: string[]; code: number; argsLog: string }): void {
  const del = (opts.deleteFirst ?? []).map((f) => `try { File.Delete(@"${f}"); } catch {}`).join(' ')
  const copy = opts.from !== undefined ? `File.Copy(@"${opts.from}", @"${opts.to}", true);` : ''
  const cs = `using System; using System.IO;
class P { static int Main(string[] a) { File.AppendAllText(@"${opts.argsLog}", string.Join(" ", a) + Environment.NewLine); ${del} ${copy} return ${opts.code}; } }`
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
function bed(exitAfterMs = 1500): Bed {
  const root = temp()
  const appDir = join(root, 'Programs', 'Agent Test')
  mkdirSync(join(appDir, 'resources'), { recursive: true })
  const marker = join(root, 'started.txt')
  const exe = join(appDir, 'AgentTest.exe')
  makeApp(exe, '0.2.52', marker)
  writeFileSync(join(appDir, 'resources', 'app.asar'), 'old app')
  const app = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${exitAfterMs})`], { stdio: 'ignore', windowsHide: true })
  children.push(app)
  return { root, appDir, exe, marker, argsLog: join(root, 'installer-args.txt'), appPid: app.pid! }
}

async function runLauncher(b: Bed, installerPath: string, wanted: string, extra: Record<string, unknown> = {}): Promise<LauncherResult> {
  const work = join(b.root, 'work')
  mkdirSync(work, { recursive: true })
  const script = join(work, 'launcher.ps1')
  writeFileSync(script, '\uFEFF' + LAUNCHER_PS1.replace(/\r?\n/g, '\r\n'), 'utf8')
  const params = join(work, 'params.json')
  writeFileSync(
    params,
    JSON.stringify({
      appPid: b.appPid, installDir: b.appDir, exe: b.exe, installer: installerPath, wanted,
      result: join(work, 'result.json'), log: join(work, 'launcher.log'), backup: join(b.root, 'backup'),
      env: { AGENT_USER_DATA: 'C:\\test-data' }, exitTimeoutSec: 20, settleTimeoutSec: 5, lockTimeoutSec: 3, installerTimeoutSec: 60, ...extra,
    }),
  )
  // Started the way the app starts it: through WMI, outside this process.
  const pid = await startViaWmi(launcherCommandLine(script, params))
  expect(pid).toBeGreaterThan(0)
  const resultFile = join(work, 'result.json')
  const done = (): LauncherResult | null => {
    try {
      const r = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')) as LauncherResult
      return r.relaunched || (r.error !== null && !existsSync(b.exe)) ? r : null
    } catch {
      return null
    }
  }
  await until(() => done() !== null, 60_000)
  await new Promise((resolve) => setTimeout(resolve, 500))
  return JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')) as LauncherResult
}

describe.runIf(onWindows)('the update launcher on Windows (real WMI start, real files)', () => {
  it('waits for the app, installs into its folder, checks the version, reopens it with its environment', async () => {
    const b = bed()
    const fresh = join(b.root, 'new.exe')
    makeApp(fresh, '0.2.53', b.marker)
    const setup = join(b.root, 'Agent-0.2.53-setup.exe')
    makeInstaller(setup, { from: fresh, to: b.exe, code: 0, argsLog: b.argsLog })
    const r = await runLauncher(b, setup, '0.2.53')
    expect(r).toMatchObject({ ok: true, stage: 'done', appExited: true, forced: false, installerExit: 0, installedVersion: '0.2.53', rolledBack: false, relaunched: true, error: null })
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
      expect({ stage: r.stage, error: r.error }).toMatchObject({ stage: 'checking that no file is in use' })
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
})
