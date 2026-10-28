/**
 * The app installs a newer version of itself from an installer file the agent was given (tools/app-control.ts
 * app_update), with no clicks:
 *
 *  1. The installer is checked: a file named like this app's own installers (`<productName>-<version>-setup.exe`),
 *     a version that is not older than this one, and an app that was installed (a development run cannot).
 *  2. A note is written to `<userData>/update-pending.json` (versions, the chat that asked, when).
 *  3. When the turn that asked has ended (so its reply is in the chat and nothing is cut off), the app writes a
 *     launcher script and its parameters to `<userData>/updates/<version>-<time>/` and starts it through WMI
 *     (Win32_Process.Create). That puts the launcher outside this app's process tree and job, with a console of its
 *     own (hidden), so it outlives the app. A PowerShell started as a plain detached child (DETACHED_PROCESS, no
 *     console) exits at once without running anything on Windows 11, which is why updates used to fail silently.
 *     The app quits only once the launcher has written that it is running; if it never does, the app stays up and
 *     the chat hears the real reason.
 *  4. The launcher (LAUNCHER_PS1): waits for this process to exit (forcing it after a timeout), waits for every other
 *     process started from the install folder to end (stopping the ones left), checks that no file in the folder is
 *     still open (Restart Manager names the process holding it), backs the folder up, runs the installer silently
 *     into the folder the app runs from (electron-builder NSIS: `/S` silent, `--updated`, `/D=<dir>` last and
 *     unquoted), records its exit code, reads the version of the installed exe, puts the backup back if anything
 *     failed, and opens the app again either way. Everything goes to `result.json` and `launcher.log` there.
 *  5. On the next start `resume()` reads the note and the result, compares the running version and the installed
 *     exe's version with the one wanted, and the agent gets either "[App update finished: ...]" or the real failure
 *     (exit code, locked file and who held it, log path) in the same chat, so it carries on.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export interface PendingUpdate {
  from: string
  to: string
  chat: string
  installer: string
  at: number
  /** The folder holding this attempt's launcher, parameters, result and log. */
  work?: string
  /** The launcher's process id, once started. */
  launcher?: number
}

/** What the launcher writes to result.json. */
export interface LauncherResult {
  version: number
  wanted: string
  stage: string
  ok: boolean
  appExited: boolean
  forced: boolean
  killed: Array<{ pid: number; name: string; path: string }>
  locked: { file: string; holders: Array<{ pid: number; name: string; path: string | null }> } | null
  installerExit: number | null
  installedVersion: string | null
  rolledBack: boolean
  relaunched: boolean
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface LauncherParams {
  appPid: number
  installDir: string
  exe: string
  installer: string
  wanted: string
  result: string
  log: string
  backup: string
  /** Environment the reopened app needs (e.g. AGENT_USER_DATA of a test copy); WMI starts with the user's default one. */
  env: Record<string, string>
  exitTimeoutSec: number
  settleTimeoutSec: number
  lockTimeoutSec: number
  installerTimeoutSec: number
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
  /** Starts the launcher outside this app (default: WMI Win32_Process.Create, hidden). Returns its process id. */
  startLauncher?: (commandLine: string) => Promise<number>
  /** Ends the app (app.quit). */
  quit: () => void
  /** Tells a chat something (the update could not start). */
  tell?: (chat: string, text: string) => void
  log?: (message: string, detail?: Record<string, unknown>) => void
  now?: () => number
  /** This process (the launcher waits for it to exit). */
  pid?: number
  /** Passed to the reopened app (WMI does not inherit this process's environment). */
  relaunchEnv?: Record<string, string>
  /** Where the install folder is backed up during the install. */
  backupDir?: string
  /** How often to look whether the turn has ended, and the most to wait for it. */
  pollMs?: number
  maxWaitMs?: number
  /** The most to wait for the launcher to say it runs before giving up (and not quitting). */
  launcherReadyMs?: number
}

const NOTE_FILE = 'update-pending.json'
const UPDATES_DIR = 'updates'
const READY_LINE = 'launcher running'

/** "0.2.53" from "Agent-0.2.53-setup.exe" (and pre-release tags like 0.3.0-beta.1), or null. */
export function versionOfInstaller(file: string, productName: string): string | null {
  // Either slash: a Windows path read anywhere (tests, a server checking a path it was given).
  const name = file.split(/[\\/]/).pop() ?? file
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

/** What an electron-builder NSIS installer's exit code means. */
export function installerExitMeaning(code: number): string {
  if (code === 0) return 'success'
  if (code === 1) return 'cancelled (another installer of this app was already running, or it was cancelled)'
  if (code === 2) return 'aborted by the installer (usually: the old version could not be removed or the app could not be closed because its files were in use)'
  return 'an unexpected installer error'
}

/** Windows PowerShell 5.1, by full path (PATH can hold another powershell.exe). */
function powershellExe(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The command line WMI runs: the launcher script with its parameters file. */
export function launcherCommandLine(script: string, params: string, powershell = powershellExe()): string {
  return `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" "${params}"`
}

/** Asks WMI to start the command line, hidden, outside this process's tree and job; resolves with its process id. */
export const WMI_START_PS =
  "$ErrorActionPreference = 'Stop'; " +
  '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ' +
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:AGENT_UPDATE_COMMAND; ProcessStartupInformation = $s }; ' +
  "if ($r.ReturnValue -ne 0) { [Console]::Error.Write('Win32_Process.Create returned ' + $r.ReturnValue); exit 3 }; " +
  '[Console]::Out.Write([string]$r.ProcessId)'

export function startViaWmi(commandLine: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WMI_START_PS],
      { env: { ...process.env, AGENT_UPDATE_COMMAND: commandLine }, windowsHide: true, timeout: 60_000 },
      (error, stdout, stderr) => {
        const pid = Number.parseInt(String(stdout).trim(), 10)
        if (error !== null || !Number.isFinite(pid) || pid <= 0) {
          const why = String(stderr).trim() || (error instanceof Error ? error.message : `no process id (${String(stdout).trim()})`)
          reject(new Error(`Windows could not start the update launcher through WMI: ${why}`))
          return
        }
        resolve(pid)
      },
    )
  })
}

/**
 * The launcher. Run as `powershell -File launcher.ps1 params.json`; never needs this app to be alive. Every step is
 * logged; result.json is rewritten after each stage so a launcher that dies part way still says where.
 */
export const LAUNCHER_PS1 = String.raw`param([string]$ParamsFile)
$ErrorActionPreference = 'Stop'
$p = Get-Content -Raw -LiteralPath $ParamsFile | ConvertFrom-Json
$r = [ordered]@{ version = 1; wanted = $p.wanted; stage = 'start'; ok = $false; appExited = $false; forced = $false; killed = @(); locked = $null; installerExit = $null; installedVersion = $null; rolledBack = $false; relaunched = $false; error = $null; startedAt = (Get-Date).ToString('o'); finishedAt = $null }
function Retry([scriptblock]$write) { for ($i = 0; $i -lt 40; $i++) { try { & $write; return } catch { Start-Sleep -Milliseconds 50 } } }
function Log([string]$m) { $line = (Get-Date).ToString('o') + ' ' + $m + [Environment]::NewLine; Retry { [IO.File]::AppendAllText($p.log, $line, [Text.Encoding]::UTF8) } }
function Save { $r.finishedAt = (Get-Date).ToString('o'); $json = $r | ConvertTo-Json -Depth 6; Retry { [IO.File]::WriteAllText($p.result, $json, [Text.Encoding]::UTF8) } }
$dir = $p.installDir.TrimEnd('\')
$prefix = $dir + '\'
function FromDir { @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; path = [string]$_.ExecutablePath } }) }
function Describe($list) { ($list | ForEach-Object { '{0} (pid {1}{2})' -f $_.name, $_.pid, $(if ($_.path) { ', ' + $_.path } else { '' }) }) -join '; ' }
function FirstLocked {
  foreach ($f in Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue) {
    try { $s = [IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None'); $s.Dispose() }
    catch [UnauthorizedAccessException] { }
    catch { if ($_.Exception.InnerException -is [IO.IOException] -or $_.Exception -is [IO.IOException]) { return $f.FullName } }
  }
  return $null
}
function Holders([string]$file) {
  try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class AgentRmHolders {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName; public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static int[] For(string path) {
    uint h; var list = new List<int>();
    if (RmStartSession(out h, 0, new StringBuilder(64)) != 0) return list.ToArray();
    try {
      if (RmRegisterResources(h, 1, new[] { path }, 0, null, 0, null) != 0) return list.ToArray();
      uint needed = 0, n = 0, reasons = 0;
      int rc = RmGetList(h, out needed, ref n, null, ref reasons);
      if (rc == 234 && needed > 0) { var info = new RM_PROCESS_INFO[needed]; n = needed; rc = RmGetList(h, out needed, ref n, info, ref reasons); if (rc == 0) for (int i = 0; i < n; i++) list.Add(info[i].Process.dwProcessId); }
    } finally { RmEndSession(h); }
    return list.ToArray();
  }
}
'@
  } catch { }
  $ids = @()
  try { $ids = [AgentRmHolders]::For($file) } catch { }
  @($ids | ForEach-Object { $q = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_) -ErrorAction SilentlyContinue; [ordered]@{ pid = [int]$_; name = $(if ($q) { [string]$q.Name } else { '?' }); path = $(if ($q) { [string]$q.ExecutablePath } else { $null }) } })
}
function SameVersion([string]$have, [string]$want) { if (-not $have) { return $false }; $h = $have.Trim(); $w = $want.Trim(); return ($h -eq $w) -or ($h -eq ($w + '.0')) }
function Mirror([string]$from, [string]$to) { & robocopy $from $to /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; return $LASTEXITCODE }
$backedUp = $false
try {
  Log ('${READY_LINE} pid ' + $PID + ': app pid ' + $p.appPid + ', ' + $p.installer + ' -> ' + $dir + ' (wanted ' + $p.wanted + ')')
  $r.stage = 'waiting for the app to exit'; Save
  $deadline = (Get-Date).AddSeconds($p.exitTimeoutSec)
  while ((Get-Process -Id $p.appPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Process -Id $p.appPid -ErrorAction SilentlyContinue) {
    Log ('the app did not exit within ' + $p.exitTimeoutSec + ' s: stopping it')
    Stop-Process -Id $p.appPid -Force -ErrorAction SilentlyContinue; $r.forced = $true; Start-Sleep -Seconds 1
  }
  $r.appExited = $true
  Log 'the app has exited'
  $r.stage = 'waiting for its other processes'; Save
  $deadline = (Get-Date).AddSeconds($p.settleTimeoutSec)
  while (@(FromDir).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $left = @(FromDir)
  if ($left.Count -gt 0) {
    Log ('stopping processes still running from the app folder: ' + (Describe $left))
    foreach ($x in $left) { Stop-Process -Id $x.pid -Force -ErrorAction SilentlyContinue }
    $r.killed = $left; Start-Sleep -Seconds 1
  }
  $r.stage = 'checking that no file is in use'; Save
  $deadline = (Get-Date).AddSeconds($p.lockTimeoutSec)
  do { $busy = FirstLocked; if ($busy) { Start-Sleep -Milliseconds 500 } } while ($busy -and (Get-Date) -lt $deadline)
  if ($busy) {
    $who = @(Holders $busy)
    $r.locked = [ordered]@{ file = $busy; holders = $who }
    throw ('a file of the app is still in use after ' + $p.lockTimeoutSec + ' s: ' + $busy + $(if ($who.Count -gt 0) { ', held by ' + (Describe $who) } else { ' (Windows did not say which process holds it)' }))
  }
  Log 'no file of the app is in use'
  $r.stage = 'backing up the app folder'; Save
  if (Test-Path -LiteralPath $p.backup) { Remove-Item -LiteralPath $p.backup -Recurse -Force }
  $code = Mirror $dir $p.backup
  if ($code -ge 8) { throw ('could not back up the app folder to ' + $p.backup + ' (robocopy exit ' + $code + ')') }
  $backedUp = $true
  Log ('backed up to ' + $p.backup)
  $r.stage = 'running the installer'; Save
  $proc = Start-Process -FilePath $p.installer -ArgumentList ('/S --updated /D=' + $dir) -PassThru
  $null = $proc.Handle
  if (-not $proc.WaitForExit([int]$p.installerTimeoutSec * 1000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; throw ('the installer did not finish within ' + $p.installerTimeoutSec + ' s') }
  $r.installerExit = [int]$proc.ExitCode
  Log ('installer exit code ' + $r.installerExit)
  $r.stage = 'checking the installed version'; Save
  if (Test-Path -LiteralPath $p.exe) { $r.installedVersion = [string](Get-Item -LiteralPath $p.exe).VersionInfo.ProductVersion }
  Log ('installed exe reports ' + $r.installedVersion)
  if ($r.installerExit -ne 0) { throw ('the installer failed with exit code ' + $r.installerExit) }
  if (-not (SameVersion $r.installedVersion $p.wanted)) { throw ('the installer finished but ' + $p.exe + ' reports ' + $(if ($r.installedVersion) { $r.installedVersion } else { 'nothing (missing)' }) + ', not ' + $p.wanted) }
  $r.ok = $true
  $r.stage = 'done'
  Log 'update installed'
} catch {
  $r.error = [string]$_.Exception.Message
  Log ('FAILED while ' + $r.stage + ': ' + $r.error)
  if ($backedUp) {
    $code = Mirror $p.backup $dir
    $r.rolledBack = ($code -lt 8)
    if (Test-Path -LiteralPath $p.exe) { $r.installedVersion = [string](Get-Item -LiteralPath $p.exe).VersionInfo.ProductVersion }
    Log ('put the backup back (robocopy exit ' + $code + '): the folder has ' + $r.installedVersion)
  }
} finally {
  Save
  if ($backedUp -and ($r.ok -or $r.rolledBack)) { Remove-Item -LiteralPath $p.backup -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $p.exe) {
    foreach ($k in $p.env.PSObject.Properties) { Set-Item -Path ('Env:' + $k.Name) -Value ([string]$k.Value) }
    try { Start-Process -FilePath $p.exe -WorkingDirectory $dir; $r.relaunched = $true; Log 'reopened the app' } catch { Log ('could not reopen the app: ' + $_.Exception.Message) }
  } else { Log ('cannot reopen the app: ' + $p.exe + ' is missing') }
  Save
}
`

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
    void this.whenIdle(chat).then(() => this.go(note))
    const same = compareVersions(to, from) === 0
    return {
      ok: true,
      from,
      to,
      text:
        `${same ? `Reinstalling ${to}` : `Updating ${from} -> ${to}`}: when this reply is done the app closes, installs silently and opens again (about a minute or two). ` +
        'You will get a note in this chat when it is back, saying whether it worked and, if not, exactly why. Tell the person the app is restarting for the update; do not start other work in this turn.',
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

  /** Writes this attempt's launcher and parameters; returns the paths. */
  prepare(note: PendingUpdate): { work: string; script: string; params: string; values: LauncherParams } {
    const root = join(this.deps.userData, UPDATES_DIR)
    mkdirSync(root, { recursive: true })
    pruneAttempts(root, 4)
    const work = join(root, `${note.to}-${this.now()}`)
    mkdirSync(work, { recursive: true })
    const exe = this.deps.execPath
    const values: LauncherParams = {
      appPid: this.deps.pid ?? process.pid,
      installDir: dirname(exe),
      exe,
      installer: note.installer,
      wanted: note.to,
      result: join(work, 'result.json'),
      log: join(work, 'launcher.log'),
      backup: this.deps.backupDir ?? join(tmpdir(), `${basename(exe, '.exe')}-update-backup`),
      env: this.deps.relaunchEnv ?? {},
      exitTimeoutSec: 120,
      settleTimeoutSec: 30,
      lockTimeoutSec: 20,
      installerTimeoutSec: 600,
    }
    const script = join(work, 'launcher.ps1')
    const params = join(work, 'params.json')
    // A byte order mark so Windows PowerShell reads the script as UTF-8 whatever the system code page.
    writeFileSync(script, '\uFEFF' + LAUNCHER_PS1.replace(/\r?\n/g, '\r\n'), 'utf8')
    writeFileSync(params, JSON.stringify(values, null, 2), 'utf8')
    return { work, script, params, values }
  }

  private async go(note: PendingUpdate): Promise<void> {
    const fail = (why: string): void => {
      this.scheduled = false
      rmSync(this.noteFile, { force: true })
      this.deps.log?.('Update could not start', { message: why })
      this.deps.tell?.(
        note.chat,
        `[App update FAILED before the app closed: ${why}. The app did not restart and is still on ${this.deps.currentVersion}. Tell the person exactly this.]`,
      )
    }
    let prepared: ReturnType<SelfUpdater['prepare']>
    try {
      prepared = this.prepare(note)
    } catch (error) {
      fail(`could not write the update launcher: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let pid: number
    try {
      pid = await (this.deps.startLauncher ?? startViaWmi)(launcherCommandLine(prepared.script, prepared.params))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    // Quit only once the launcher is really running: never close into nothing.
    const readyBy = this.now() + (this.deps.launcherReadyMs ?? 30_000)
    const ready = (): boolean => {
      try {
        return readFileSync(prepared.values.log, 'utf8').includes(READY_LINE)
      } catch {
        return false
      }
    }
    while (!ready() && this.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 100))
    if (!ready()) {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
      fail(`the update launcher (process ${pid}) started but never ran its script; see ${prepared.work}`)
      return
    }
    writeFileSync(this.noteFile, JSON.stringify({ ...note, work: prepared.work, launcher: pid } satisfies PendingUpdate, null, 2), 'utf8')
    this.deps.log?.('Update starting: quitting for the installer', { dir: prepared.values.installDir, launcher: pid, work: prepared.work })
    this.deps.quit()
  }

  /** On start: the update that was waiting, read once (the note is removed), or null. */
  resume(): UpdateOutcome | null {
    let note: PendingUpdate
    try {
      note = JSON.parse(readFileSync(this.noteFile, 'utf8')) as PendingUpdate
    } catch {
      return null
    }
    rmSync(this.noteFile, { force: true })
    if (typeof note.from !== 'string' || typeof note.to !== 'string') return null
    const now = this.deps.currentVersion
    const chat = typeof note.chat === 'string' && note.chat !== '' ? note.chat : 'main'
    let result: LauncherResult | null = null
    const work = typeof note.work === 'string' ? note.work : null
    if (work !== null) {
      try {
        result = JSON.parse(readFileSync(join(work, 'result.json'), 'utf8').replace(/^\uFEFF/, '')) as LauncherResult
      } catch {
        result = null
      }
    }
    // The version this process runs must be the one wanted, and a launcher that reported a failure is a failure even
    // then (a reinstall of the same version that never ran the installer still runs that version).
    const ok = compareVersions(now, note.to) >= 0 && (result === null || result.ok)
    return { ...note, chat, now, ok, result, reason: ok ? null : failureReason(note, now, result, work) }
  }
}

export type UpdateOutcome = PendingUpdate & { now: string; ok: boolean; result: LauncherResult | null; reason: string | null }

/** Keeps the newest `keep` attempt folders. */
function pruneAttempts(root: string, keep: number): void {
  try {
    const dirs = readdirSync(root)
      .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of dirs.slice(keep)) rmSync(join(root, old.name), { recursive: true, force: true })
  } catch {
    // Best effort.
  }
}

function lastLines(file: string, count: number): string {
  try {
    return readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-count).join(' | ')
  } catch {
    return ''
  }
}

/** The real reason an update did not land, in one paragraph. */
export function failureReason(note: PendingUpdate, now: string, result: LauncherResult | null, work: string | null): string {
  if (work === null) return `the app was started again on ${now} without the update having run (no launcher was recorded)`
  const log = join(work, 'launcher.log')
  if (result === null) {
    const tail = lastLines(log, 3)
    return `the update launcher left no result at ${join(work, 'result.json')}${tail !== '' ? `; its log ends: ${tail}` : ` and no log at ${log}`}`
  }
  const parts: string[] = []
  if (result.error !== null && result.error !== '') parts.push(`while ${result.stage}: ${result.error}`)
  else if (!result.ok) parts.push(`the launcher stopped while ${result.stage}`)
  if (result.installerExit !== null && result.installerExit !== 0) parts.push(`installer exit code ${result.installerExit} = ${installerExitMeaning(result.installerExit)}`)
  if (result.killed.length > 0) parts.push(`had to stop ${result.killed.map((k) => `${k.name} (pid ${k.pid})`).join(', ')}`)
  if (result.forced) parts.push('the app did not exit by itself and was stopped')
  if (result.installedVersion !== null) parts.push(`the installed exe reports ${result.installedVersion}`)
  if (result.rolledBack) parts.push('the previous version was put back')
  if (result.ok && compareVersions(now, note.to) < 0) parts.push(`the installer reported success but the app that started is ${now}`)
  parts.push(`launcher log: ${log}`)
  return parts.join('; ')
}

/** The line the agent gets in the chat after the restart. */
export function resumeNote(done: UpdateOutcome): string {
  if (done.ok) {
    const installed = done.result?.installedVersion
    return `[App update finished: ${done.from} -> ${done.now}. The app restarted on the new version${installed ? ` (installed exe reports ${installed}, running ${done.now})` : ''}. Carry on with what you were doing before the update, and tell the person it is done.]`
  }
  return `[App update FAILED: wanted ${done.to} from ${basename(done.installer)}, the app is running ${done.now}. Reason: ${done.reason ?? 'unknown'}. Tell the person exactly this (the reason, not just that it failed), and carry on with what you were doing.]`
}
