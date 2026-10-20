/**
 * Starting another program correctly on every system (M12).
 *
 * Windows is the awkward one: a `.exe` must be spawned directly (no shell), a `.cmd` or `.bat`
 * cannot be spawned directly on current Node (it throws EINVAL) and must go through
 * `cmd.exe /d /s /c`, and a `.ps1` goes through Windows PowerShell. Quoting has to keep spaces,
 * quotes, `&`, `%` and `^` in arguments intact.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'

import type { CommandKind } from '@agent/core'

import { resolveCommand, type CommandDeps, type ResolvedCommand } from './environment'

export interface SpawnResolvedOptions extends SpawnOptions {
  /** Defaults to the host platform; set explicitly when a caller has already chosen a shell. */
  platform?: NodeJS.Platform
  /** Injected in tests, and by the main process, so the right PATH and platform are used. */
  resolve?: CommandDeps
  spawnImpl?: typeof spawn
  /** Overrides for tests. Production uses ComSpec and powershell.exe. */
  cmdExe?: string
  powershellExe?: string
}

const POWERSHELL_FLAGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']

/**
 * One argument for a cmd.exe command line. Every argument is double-quoted, so cmd's own
 * characters (`&`, `|`, `<`, `>`, `^`, brackets) are literal. Backslashes before a quote are
 * doubled so the Win32 parser hands the child the exact string, and a literal percent is written
 * as `%%` because the shims reached this way are batch files.
 */
export function quoteCmdArgument(value: string): string {
  return quoteWin32(value).replace(/%/g, '%%')
}

/** The program path itself: the same quoting rules, and it is what the outer quotes protect. */
export function quoteCmdFile(value: string): string {
  return quoteWin32(value).replace(/%/g, '%%')
}

function quoteWin32(value: string): string {
  let out = `${value}`
  out = out.replace(/(\\*)"/g, '$1$1\\"')
  out = out.replace(/(\\*)$/, '$1$1')
  return `"${out}"`
}

/** The exact `cmd.exe` invocation used for a shim. Exported so the quoting can be tested. */
export function cmdInvocation(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; verbatim: true } {
  const line = [quoteCmdFile(file), ...args.map((arg) => quoteCmdArgument(arg))].join(' ')
  return {
    file: env['ComSpec']?.trim() || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  }
}

/** The PowerShell invocation used for a `.ps1`. */
export function powershellInvocation(
  file: string,
  args: string[],
  exe = 'powershell.exe',
): { file: string; args: string[] } {
  return { file: exe, args: [...POWERSHELL_FLAGS, file, ...args] }
}

function kindOfPath(path: string): CommandKind {
  const extension = win32.extname(path).toLowerCase()
  if (extension === '.exe' || extension === '.com') return 'exe'
  if (extension === '.cmd' || extension === '.bat') return 'cmd'
  if (extension === '.ps1') return 'ps1'
  return 'script'
}

function looksLikePath(command: string): boolean {
  return command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)
}

/** Resolve, then start, a program. Throws a plain Error when it is not on this computer. */
export function spawnResolved(
  command: string,
  args: string[],
  options: SpawnResolvedOptions = {},
): ChildProcess {
  const {
    platform: platformOption,
    resolve: resolveDeps,
    spawnImpl: spawnImplOption,
    cmdExe,
    powershellExe,
    ...spawnOptions
  } = options
  const platform = platformOption ?? resolveDeps?.platform ?? process.platform
  const env = options.env ?? resolveDeps?.env ?? process.env
  const spawnImpl = spawnImplOption ?? spawn

  let resolved: ResolvedCommand
  if (resolveDeps !== undefined) {
    const found = resolveCommand(command, resolveDeps)
    if (found === null) throw new Error(`Could not find ${command} on this computer.`)
    resolved = found
  } else if (looksLikePath(command)) {
    resolved = { path: command, kind: kindOfPath(command) }
  } else {
    throw new Error(`Could not find ${command} on this computer.`)
  }

  const common: SpawnOptions = { ...spawnOptions, env }

  if (platform === 'win32') {
    if (resolved.kind === 'cmd') {
      const invocation = cmdInvocation(resolved.path, args, env)
      return spawnImpl(cmdExe ?? invocation.file, invocation.args, {
        ...common,
        windowsHide: common.windowsHide ?? true,
        windowsVerbatimArguments: true,
        shell: false,
      })
    }
    if (resolved.kind === 'ps1') {
      const invocation = powershellInvocation(resolved.path, args, powershellExe)
      return spawnImpl(invocation.file, invocation.args, {
        ...common,
        windowsHide: common.windowsHide ?? true,
        shell: false,
      })
    }
    if (resolved.kind === 'script') {
      throw new Error(`${resolved.path} is not a program Windows can start directly.`)
    }
    return spawnImpl(resolved.path, args, { ...common, windowsHide: common.windowsHide ?? true, shell: false })
  }

  return spawnImpl(resolved.path, args, { ...common, shell: false })
}
