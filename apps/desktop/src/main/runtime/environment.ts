/**
 * Look at this computer first; never assume and never install (M12).
 *
 * Everything here is dependency-injected (`platform`, `env`, a tiny file probe, and an `exec` for
 * `--version`) so the Windows rules can be tested on Linux. The scan is read-only: it runs nothing
 * except `<tool> --version`, writes nothing, signs in to nothing and sends nothing anywhere.
 */
import { posix, win32 } from 'node:path'

import type { CommandKind, EnvironmentReport, Found } from '@agent/core'

// ---------------------------------------------------------------------------------------------------------------
// The injected pieces
// ---------------------------------------------------------------------------------------------------------------

/** The little bit of the file system the scan needs. Production passes node:fs; tests pass a map. */
export interface EnvironmentFs {
  exists(path: string): boolean
  isDirectory?(path: string): boolean
  size?(path: string): number
  /** Directory listing, used for case-insensitive Windows lookups. */
  list?(folder: string): string[]
  /** On Linux and macOS a program must also carry the executable bit. */
  isExecutable?(path: string): boolean
}

export interface ExecResult {
  stdout: string
  stderr?: string
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<ExecResult>

export interface CommandDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  fs: EnvironmentFs
}

export interface ScanDeps extends CommandDeps {
  release: string
  arch: string
  hostname: string
  exec: ExecFn
  now(): number
}

export interface ResolvedCommand {
  path: string
  kind: CommandKind
}

/** A program plus any fixed leading arguments (`py -3`), so callers can run it directly. */
export interface ProgramRef extends ResolvedCommand {
  /** Arguments that go before the program's own, for example ['-3'] for the Python launcher. */
  prefix: string[]
}

export const VERSION_TIMEOUT_MS = 4_000
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD', '.PS1']

// ---------------------------------------------------------------------------------------------------------------
// Finding a program on PATH
// ---------------------------------------------------------------------------------------------------------------

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function isDirectory(deps: CommandDeps, path: string): boolean {
  return deps.fs.isDirectory?.(path) ?? false
}

/**
 * A Windows Store app-execution-alias: a zero-byte file under WindowsApps. It looks like a program
 * in a directory listing but running it opens the Store instead. Never treat it as installed.
 */
export function isStoreAlias(path: string, size: number | undefined): boolean {
  if (!/windowsapps/i.test(path)) return false
  return size === 0
}

function kindOf(path: string): CommandKind {
  const dot = path.lastIndexOf('.')
  const extension = dot < 0 ? '' : path.slice(dot).toLowerCase()
  if (extension === '.exe' || extension === '.com') return 'exe'
  if (extension === '.cmd' || extension === '.bat') return 'cmd'
  if (extension === '.ps1') return 'ps1'
  return 'script'
}

function extensionList(env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATHEXT']?.trim() ?? ''
  const parts = raw === '' ? [...DEFAULT_PATHEXT] : raw.split(';').filter((part) => part !== '')
  const normalised = parts.map((part) => (part.startsWith('.') ? part : `.${part}`))
  // Windows does not ship .PS1 in PATHEXT, but the app is asked to find PowerShell shims too.
  if (!normalised.some((part) => part.toUpperCase() === '.PS1')) normalised.push('.PS1')
  return normalised
}

function hasKnownExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
}

/** The names to try in one folder: the exact name, or the name with each PATHEXT suffix. */
function candidateNames(name: string, extensions: string[]): string[] {
  if (hasKnownExtension(name, extensions)) return [name]
  return extensions.map((extension) => `${name}${extension}`)
}

/** Windows path lookup is case-insensitive; ask the injected listing when it can answer. */
function actualNames(deps: CommandDeps, folder: string, wanted: string): string[] {
  if (deps.platform !== 'win32' || deps.fs.list === undefined) return [wanted]
  let entries: string[]
  try {
    entries = deps.fs.list(folder)
  } catch {
    return [wanted]
  }
  const lower = wanted.toLowerCase()
  const matches = entries.filter((entry) => entry.toLowerCase() === lower)
  return matches.length === 0 ? [wanted] : matches
}

function tryCandidate(deps: CommandDeps, candidate: string): ResolvedCommand | null {
  if (!deps.fs.exists(candidate)) return null
  if (isDirectory(deps, candidate)) return null
  if (deps.platform === 'win32' && isStoreAlias(candidate, deps.fs.size?.(candidate))) return null
  if (deps.platform !== 'win32' && deps.fs.isExecutable !== undefined && !deps.fs.isExecutable(candidate)) {
    return null
  }
  return { path: candidate, kind: kindOf(candidate) }
}

/**
 * Find an executable on PATH. Windows tries PATHEXT in order, ignores directories and Store alias
 * stubs; Linux and macOS require the executable bit. Returns null when it is not there.
 */
export function resolveCommand(name: string, deps: CommandDeps): ResolvedCommand | null {
  const clean = name.trim()
  if (clean === '') return null
  const api = pathApi(deps.platform)
  const extensions = deps.platform === 'win32' ? extensionList(deps.env) : ['']
  const names = candidateNames(clean, extensions)

  // An absolute or relative path with a separator is checked directly, not searched for.
  if (clean.includes('/') || clean.includes('\\')) {
    for (const candidateName of names) {
      const direct = tryCandidate(deps, api.normalize(candidateName))
      if (direct !== null) return direct
    }
    return null
  }

  const pathValue = deps.env['PATH'] ?? deps.env['Path'] ?? ''
  if (pathValue.trim() === '') return null
  const folders = pathValue.split(deps.platform === 'win32' ? ';' : ':')

  for (const rawFolder of folders) {
    const folder = rawFolder.trim().replace(/^"(.*)"$/, '$1')
    if (folder === '') continue
    for (const candidateName of names) {
      for (const actual of actualNames(deps, folder, candidateName)) {
        const found = tryCandidate(deps, api.join(folder, actual))
        if (found !== null) return found
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// The tools this app looks for
// ---------------------------------------------------------------------------------------------------------------

interface ToolLookup {
  id: string
  label: string
  names: string[]
  /** Absolute places to look after PATH, built from env vars only (no user names in the source). */
  candidates?: (deps: CommandDeps) => string[]
}

function joinFor(deps: CommandDeps, ...parts: string[]): string {
  return pathApi(deps.platform).join(...parts)
}

function homeOf(deps: CommandDeps): string {
  return deps.env['USERPROFILE'] ?? deps.env['HOME'] ?? ''
}

function localAppData(deps: CommandDeps): string {
  return deps.env['LOCALAPPDATA'] ?? ''
}

function appData(deps: CommandDeps): string {
  return deps.env['APPDATA'] ?? ''
}

function installCandidates(deps: CommandDeps, id: string): string[] {
  const home = homeOf(deps)
  const roaming = appData(deps)
  const local = localAppData(deps)
  const paths: string[] = []
  const add = (...parts: string[]): void => {
    if (parts.some((part) => part === '')) return
    paths.push(joinFor(deps, ...parts))
  }

  switch (id) {
    case 'claude':
      add(roaming, 'npm', 'claude.cmd')
      add(roaming, 'npm', 'claude.ps1')
      add(local, 'Programs', 'Claude', 'Claude.exe')
      add(home, '.claude', 'local', 'claude.exe')
      add(home, '.local', 'bin', 'claude')
      break
    case 'opencode':
      add(roaming, 'npm', 'opencode.cmd')
      add(roaming, 'npm', 'opencode.ps1')
      add(local, 'Programs', 'opencode', 'opencode.exe')
      add(home, '.opencode', 'bin', 'opencode')
      add(home, '.local', 'bin', 'opencode')
      break
    case 'gemini':
      add(roaming, 'npm', 'gemini.cmd')
      add(roaming, 'npm', 'gemini.ps1')
      add(local, 'Programs', 'gemini', 'gemini.exe')
      add(home, '.local', 'bin', 'gemini')
      break
    case 'codex':
      add(roaming, 'npm', 'codex.cmd')
      add(roaming, 'npm', 'codex.ps1')
      add(local, 'Programs', 'codex', 'codex.exe')
      add(home, '.local', 'bin', 'codex')
      break
    case 'antigravity':
      add(local, 'Programs', 'Antigravity', 'Antigravity.exe')
      add(local, 'Programs', 'antigravity', 'antigravity.exe')
      add(local, 'Antigravity', 'Antigravity.exe')
      add(roaming, 'npm', 'antigravity.cmd')
      add(home, '.local', 'bin', 'antigravity')
      if (deps.platform === 'darwin') {
        paths.push('/Applications/Antigravity.app/Contents/MacOS/Antigravity')
      }
      break
    default:
      break
  }
  return paths
}

const SHELL_LOOKUPS: Record<'win32' | 'posix', ToolLookup[]> = {
  win32: [
    { id: 'pwsh', label: 'PowerShell 7', names: ['pwsh'] },
    { id: 'powershell', label: 'Windows PowerShell', names: ['powershell'] },
    { id: 'cmd', label: 'Command Prompt', names: ['cmd'] },
  ],
  posix: [
    { id: 'bash', label: 'Bash', names: ['bash'] },
    { id: 'zsh', label: 'Zsh', names: ['zsh'] },
    { id: 'sh', label: 'Shell', names: ['sh'] },
  ],
}

const RUNTIME_LOOKUPS: ToolLookup[] = [
  { id: 'node', label: 'Node', names: ['node'] },
  { id: 'python', label: 'Python', names: ['py', 'python', 'python3'] },
  { id: 'git', label: 'Git', names: ['git'] },
]

const AI_LOOKUPS: ToolLookup[] = [
  { id: 'claude', label: 'Claude Code', names: ['claude'] },
  { id: 'opencode', label: 'OpenCode', names: ['opencode'] },
  { id: 'gemini', label: 'Gemini CLI', names: ['gemini'] },
  { id: 'codex', label: 'Codex', names: ['codex'] },
  { id: 'antigravity', label: 'Antigravity', names: ['antigravity'] },
]

/** The Python launcher varies by machine: `py -3`, then `python`, then `python3`. */
export function resolvePython(deps: CommandDeps): ProgramRef | null {
  if (deps.platform === 'win32') {
    const launcher = resolveCommand('py', deps)
    if (launcher !== null) return { ...launcher, prefix: ['-3'] }
  }
  for (const name of ['python', 'python3']) {
    const found = resolveCommand(name, deps)
    if (found !== null) return { ...found, prefix: [] }
  }
  return null
}

export function resolveNode(deps: CommandDeps): ProgramRef | null {
  const found = resolveCommand('node', deps)
  return found === null ? null : { ...found, prefix: [] }
}

function findLookup(lookup: ToolLookup, deps: CommandDeps): ProgramRef | null {
  for (const name of lookup.names) {
    const found = resolveCommand(name, deps)
    if (found !== null) return { ...found, prefix: [] }
  }
  if (lookup.candidates === undefined) return null
  const extras = lookup.candidates(deps)
  for (const extra of extras) {
    const found = tryCandidate(deps, extra)
    if (found !== null) return { ...found, prefix: [] }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------------

/** The first version-looking token: "Python 3.12.1" -> 3.12.1, "git version 2.43.0.windows.1" -> 2.43.0. */
export function firstVersion(text: string): string | undefined {
  const match = text.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/)
  return match?.[1]
}

function versionArgs(program: ProgramRef): string[] {
  return [...program.prefix, '--version']
}

async function readVersion(program: ProgramRef, deps: ScanDeps): Promise<string | undefined> {
  try {
    const result = await deps.exec(program.path, versionArgs(program), { timeoutMs: VERSION_TIMEOUT_MS })
    const text = `${result.stdout}\n${result.stderr ?? ''}`
    return firstVersion(text)
  } catch {
    // A tool that hangs or fails is still installed; it simply has no known version.
    return undefined
  }
}

function foundRow(lookup: ToolLookup, program: ProgramRef | null, version?: string): Found {
  if (program === null) return { id: lookup.id, label: lookup.label, found: false }
  return {
    id: lookup.id,
    label: lookup.label,
    found: true,
    path: program.path,
    kind: program.kind,
    ...(version === undefined ? {} : { version }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------------------------

/** Everything the computer has, in three groups. Read-only, parallel and never throwing. */
export async function scanEnvironment(deps: ScanDeps): Promise<EnvironmentReport> {
  const shellLookups = deps.platform === 'win32' ? SHELL_LOOKUPS.win32 : SHELL_LOOKUPS.posix
  const shells: Array<{ lookup: ToolLookup; program: ProgramRef | null }> = []
  for (const lookup of shellLookups) {
    shells.push({ lookup, program: findLookup(lookup, deps) })
  }

  const runtimes = RUNTIME_LOOKUPS.map((lookup) => ({
    lookup,
    program: lookup.id === 'python' ? resolvePython(deps) : findLookup(lookup, deps),
  }))
  const aiTools = AI_LOOKUPS.map((lookup) => ({
    lookup,
    program: findLookup({ ...lookup, candidates: (d) => installCandidates(d, lookup.id) }, deps),
  }))

  const jobs: Array<Promise<Found>> = []
  for (const entry of [...shells, ...runtimes, ...aiTools]) {
    if (entry.program === null) {
      jobs.push(Promise.resolve(foundRow(entry.lookup, null)))
      continue
    }
    const program = entry.program
    jobs.push(readVersion(program, deps).then((version) => foundRow(entry.lookup, program, version)))
  }
  const rows = await Promise.all(jobs)
  const shellCount = shells.length
  const runtimeCount = runtimes.length

  const notes: string[] = []
  if (deps.platform === 'win32') {
    const wsl = resolveCommand('wsl', deps)
    if (wsl !== null) {
      notes.push('Windows Subsystem for Linux is present. The app uses Windows tools directly and does not need it.')
    }
  }

  return {
    os: {
      platform: deps.platform,
      release: deps.release,
      arch: deps.arch,
      hostname: deps.hostname,
    },
    shells: rows.slice(0, shellCount),
    runtimes: rows.slice(shellCount, shellCount + runtimeCount),
    aiTools: rows.slice(shellCount + runtimeCount),
    notes,
    scannedAt: deps.now(),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The session cache
// ---------------------------------------------------------------------------------------------------------------

export interface EnvironmentService {
  /** The scan, cached for the session unless `refresh` is true. Concurrent callers share one run. */
  scan(options?: { refresh?: boolean }): Promise<EnvironmentReport>
  /** The last report, or null before the first scan. Never triggers a scan. */
  current(): EnvironmentReport | null
  /** A program on PATH, for the shell and code tools. */
  resolve(name: string): ResolvedCommand | null
  node(): ProgramRef | null
  python(): ProgramRef | null
}

export function createEnvironment(deps: ScanDeps): EnvironmentService {
  let cached: EnvironmentReport | null = null
  let inFlight: Promise<EnvironmentReport> | null = null

  const run = (): Promise<EnvironmentReport> => {
    if (inFlight !== null) return inFlight
    inFlight = scanEnvironment(deps)
      .then((report) => {
        cached = report
        return report
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    scan(options = {}) {
      if (cached !== null && options.refresh !== true) return Promise.resolve(cached)
      return run()
    },
    current() {
      return cached
    },
    resolve(name: string) {
      return resolveCommand(name, deps)
    },
    node() {
      return resolveNode(deps)
    },
    python() {
      return resolvePython(deps)
    },
  }
}
