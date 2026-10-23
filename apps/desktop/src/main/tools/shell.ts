/**
 * `shell_run`: the agent may use this computer's shell, but only with the person's explicit yes,
 * every single time, with the exact command on the card. There is no "always allow" (PLAN.md 7).
 *
 * The child process never inherits anything that looks like a key, token, secret or password.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, promises as fs, statSync } from 'node:fs'
import { homedir } from 'node:os'

import { int, resultLimitOf, schema, str, type Tool } from '@agent/core'

import type { JsonObject, ToolContext } from '@agent/core'
import type { RunState } from '../../shared/run-record'
import type { EnvironmentFs, ResolvedCommand } from '../runtime/environment'
import { spawnResolved, type SpawnResolvedOptions } from '../runtime/spawn'
import { recordRun, StreamCapture, type ToolRun } from './run-capture'
import { currentVaultRun, hasPlaceholder, shellCommand, vaultEnv } from '../vault/placeholders'

export const DEFAULT_TIMEOUT_SEC = 60
export const MAX_TIMEOUT_SEC = 600
export const MAX_OUTPUT_CHARS = 20_000

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD/i
const ALWAYS_DROP_ENV = new Set(['ELECTRON_RUN_AS_NODE'])

/** The real file probe, so a bare `sh` on PATH can be resolved outside the scan too. */
const realProbe: EnvironmentFs = {
  exists: existsSync,
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  size: (path) => {
    try {
      return statSync(path).size
    } catch {
      return -1
    }
  },
}

export interface ShellSettingsView {
  get(): { shell: 'always' | 'ask' | 'never' }
}

/** The scan, as the shell tool needs it: what is actually on this computer. */
export interface ShellEnvironment {
  resolve(name: string): ResolvedCommand | null
}

export interface ShellToolDeps {
  settings: ShellSettingsView
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
  /** From the environment scan. Without it the tool uses the safest shell it can find. */
  environment?: ShellEnvironment
  /** Tests can say whether an absolute `$SHELL` exists. */
  exists?: (path: string) => boolean
  /** The folder a command runs in when the agent names none. Defaults to the person's home folder. */
  home?: () => string
}

export function shellTools(deps: ShellToolDeps): Tool[] {
  return [shellRunTool(deps)]
}

/** Everything harmless from an environment, with secret-looking names left out. */
export function sanitiseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SECRET_ENV.test(name)) continue
    if (ALWAYS_DROP_ENV.has(name.toUpperCase())) continue
    clean[name] = value
  }
  return clean
}

/** The command that kills a whole process tree, or null on POSIX where the group is signalled. */
export function treeKillCommand(
  pid: number,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  if (platform !== 'win32') return null
  return { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
}

/** Kill the command and anything it started. POSIX uses the process group set up by `detached`. */
export function killProcessTree(pid: number | undefined, platform = process.platform): void {
  if (pid === undefined) return
  try {
    const command = treeKillCommand(pid, platform)
    if (command !== null) {
      spawn(command.file, command.args, { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The command may have already finished; that is fine.
    }
  }
}

export type ShellId = 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh'

export interface ShellChoice {
  id: ShellId
  label: string
  file: string
  args: string[]
  windows: boolean
}

export type ShellPlan = ShellChoice | { error: string }

export interface ShellChoiceOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  command: string
  resolve?: (name: string) => ResolvedCommand | null
  exists?: (path: string) => boolean
  /** The agent may ask for powershell, cmd or bash, but only when it is really there. */
  requested?: string
}

/** PowerShell writes UTF-8 back to us, whatever the machine's old code page is. */
export function utf8PowerShell(command: string): string {
  return (
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    command
  )
}

/** cmd's console switches to UTF-8 before the real command runs. */
export function utf8Cmd(command: string): string {
  return `chcp 65001 >nul & ${command}`
}

/**
 * Pick the shell from the scan, never from an assumption. Windows prefers PowerShell 7, then
 * Windows PowerShell, then cmd. Elsewhere the person's own `$SHELL`, then sh.
 */
export function chooseShell(options: ShellChoiceOptions): ShellPlan {
  const find = (name: string): ResolvedCommand | null => options.resolve?.(name) ?? null
  const requested = options.requested?.trim().toLowerCase() ?? ''
  const command = options.command

  if (options.platform === 'win32') {
    if (requested === 'bash') {
      const bash = find('bash')
      if (bash === null) return { error: 'Bash is not on this computer.' }
      return { id: 'bash', label: 'Bash', file: bash.path, args: ['-c', command], windows: false }
    }
    if (requested !== '' && requested !== 'cmd' && requested !== 'powershell' && requested !== 'pwsh' && requested !== 'powershell7') {
      return { error: `There is no ${requested} shell to use.` }
    }

    if (requested !== 'cmd') {
      const pwsh = find('pwsh')
      if (pwsh !== null) {
        return {
          id: 'pwsh',
          label: 'PowerShell 7',
          file: pwsh.path,
          args: ['-NoProfile', '-NonInteractive', '-Command', utf8PowerShell(command)],
          windows: true,
        }
      }
      const powershell = find('powershell')
      if (powershell !== null) {
        return {
          id: 'powershell',
          label: 'Windows PowerShell',
          file: powershell.path,
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            utf8PowerShell(command),
          ],
          windows: true,
        }
      }
      if (requested !== '') return { error: 'PowerShell is not on this computer.' }
    }

    const cmd = find('cmd')
    return {
      id: 'cmd',
      label: 'Command Prompt',
      file: cmd?.path ?? options.env['ComSpec']?.trim() ?? 'cmd.exe',
      args: ['/d', '/s', '/c', utf8Cmd(command)],
      windows: true,
    }
  }

  if (requested !== '' && requested !== 'bash' && requested !== 'sh') {
    return { error: `There is no ${requested} shell to use.` }
  }
  if (requested === 'bash') {
    const bash = find('bash')
    if (bash === null) return { error: 'Bash is not on this computer.' }
    return { id: 'bash', label: 'Bash', file: bash.path, args: ['-c', command], windows: false }
  }
  if (requested === 'sh') {
    return { id: 'sh', label: 'sh', file: find('sh')?.path ?? 'sh', args: ['-c', command], windows: false }
  }
  const userShell = options.env['SHELL']?.trim() ?? ''
  const userFound =
    userShell !== '' && (find(userShell) !== null || options.exists?.(userShell) === true)
  if (userFound) {
    const name = userShell.split('/').pop() ?? 'sh'
    const id: ShellId = name === 'zsh' ? 'zsh' : name === 'bash' ? 'bash' : 'sh'
    return { id, label: name, file: userShell, args: ['-c', command], windows: false }
  }
  return { id: 'sh', label: 'sh', file: 'sh', args: ['-c', command], windows: false }
}

function shellRunTool(deps: ShellToolDeps): Tool {
  return {
    spec: {
      name: 'shell_run',
      description:
        'Run a command in this computer\'s shell and return its output. The person always sees the exact command and must approve it. Use it for things that need a real program (git, ffmpeg, scripts); use run_code for quick calculations.',
      schema: schema(['command'], {
        command: str('The exact command line to run'),
        cwd: str('Folder to run it in, defaults to the person\'s home folder'),
        timeoutSec: int('Seconds before it is stopped, default 60, at most 600'),
        shell: {
          type: 'string',
          description: 'Which shell to use, when you need a particular one. Only one found on this computer.',
          enum: ['powershell', 'cmd', 'bash'],
        },
      }),
    },
    run: async (input, ctx) => {
      const asked = text(input['command']).trim()
      if (asked === '') return 'Pass the command to run.'
      let command = asked

      // A helper another computer placed here works with that computer's choice (ctx.shell).
      const policy = ctx.shell ?? deps.settings.get().shell
      if (policy === 'never') {
        recordRun(input, declinedRun(command, 'Shell commands are turned off in Settings.'))
        return 'Shell commands are turned off in Settings, so I did not run it.'
      }

      const timeoutSec = clamp(
        Math.trunc(number(input['timeoutSec'], DEFAULT_TIMEOUT_SEC)),
        1,
        MAX_TIMEOUT_SEC,
      )
      const cwd = text(input['cwd']).trim() || undefined
      if (cwd !== undefined) {
        const info = await fs.stat(cwd).catch(() => null)
        if (info === null || !info.isDirectory()) return `${cwd} is not a folder.`
      }

      let plan = chooseShell({
        platform: deps.platform ?? process.platform,
        env: deps.env ?? process.env,
        command,
        ...(deps.environment === undefined ? {} : { resolve: (name: string) => deps.environment?.resolve(name) ?? null }),
        ...(deps.exists === undefined ? {} : { exists: deps.exists }),
        ...(text(input['shell']).trim() === '' ? {} : { requested: text(input['shell']).trim() }),
      })
      if ('error' in plan) return plan.error

      // {{vault:ref}}: the value goes in as an environment variable; the command (and the card) only names it.
      if (hasPlaceholder(command)) {
        const run = currentVaultRun()
        if (run === undefined) return 'There is no vault here, so {{vault:...}} cannot be used.'
        const kind = plan.id === 'cmd' ? 'cmd' : plan.id === 'pwsh' || plan.id === 'powershell' ? 'powershell' : 'posix'
        const rewritten = shellCommand(command, kind, run)
        if ('error' in rewritten) return rewritten.error
        command = rewritten.command
        const again = chooseShell({
          platform: deps.platform ?? process.platform,
          env: deps.env ?? process.env,
          command,
          ...(deps.environment === undefined ? {} : { resolve: (name: string) => deps.environment?.resolve(name) ?? null }),
          ...(deps.exists === undefined ? {} : { exists: deps.exists }),
          ...(text(input['shell']).trim() === '' ? {} : { requested: text(input['shell']).trim() }),
        })
        if ('error' in again) return again.error
        plan = again
      }

      // The person chose "Run without asking" for this computer.
      const approved =
        policy === 'always' ||
        (await ctx.approve(
        `Run: ${command}`,
        `${cwd === undefined ? '' : `In ${cwd}\n`}Shell: ${plan.label}\nThis runs a real command on this computer. It stops after ${timeoutSec} seconds.`,
          'computer',
        ))
      if (!approved) {
        recordRun(input, { ...declinedRun(command, 'You did not approve it.'), label: plan.label, ...(cwd === undefined ? {} : { cwd }) })
        return 'The user did not approve that command, so I did not run it.'
      }

      return runCommand({ command, cwd, timeoutSec, ctx, deps, plan, input })
    },
  }
}

interface RunRequest {
  command: string
  cwd: string | undefined
  timeoutSec: number
  ctx: ToolContext
  deps: ShellToolDeps
  plan: ShellChoice
  /** The call's own input object: the run is recorded against it for the chat row. */
  input?: JsonObject
}

function declinedRun(command: string, note: string): ToolRun {
  return { kind: 'shell', input: command, label: 'Shell', stdout: '', stderr: '', exitCode: null, ms: 0, state: 'declined', trimmed: false, note }
}

async function runCommand(request: RunRequest): Promise<string> {
  const platform = request.deps.platform ?? process.platform
  // A vault value the command names comes in here, after the clean-up that drops anything looking like a key.
  const env = { ...sanitiseEnv({ ...(request.deps.env ?? process.env) }), ...vaultEnv() }

  // No folder named means the person's home folder, as the tool tells the model, never the app's install folder.
  const cwd = request.cwd ?? (request.deps.home ?? homedir)()
  // A script reads all the output (ToolContext.resultLimit); a model reads the first MAX_OUTPUT_CHARS.
  const sink = new OutputSink(resultLimitOf(request.ctx, MAX_OUTPUT_CHARS))
  // The person's copy: stdout and stderr apart, longer than the model's, start and end kept.
  const out = new StreamCapture()
  const err = new StreamCapture()
  const started = Date.now()
  const record = (state: RunState, exitCode: number | null, note?: string): void => {
    if (request.input === undefined) return
    recordRun(request.input, {
      kind: 'shell',
      input: request.command,
      label: request.plan.label,
      cwd,
      stdout: out.text(),
      stderr: err.text(),
      exitCode,
      ms: Date.now() - started,
      state,
      trimmed: out.trimmed() || err.trimmed(),
      ...(note === undefined ? {} : { note }),
    })
  }
  let child: ChildProcess
  try {
    const spawnOptions: SpawnResolvedOptions = {
      cwd,
      env,
      platform,
      resolve: { platform, env, fs: realProbe },
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    child = spawnResolved(request.plan.file, request.plan.args, {
      ...spawnOptions,
      ...(request.deps.spawnImpl === undefined ? {} : { spawnImpl: request.deps.spawnImpl }),
    })
  } catch (error) {
    record('failed', null, `Could not start: ${messageOf(error)}`)
    return `Could not start that command: ${messageOf(error)}`
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    sink.push(chunk)
    out.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    sink.push(chunk)
    err.push(chunk)
  })

  let timedOut = false
  let stopped = false
  let spawnError: string | null = null

  await new Promise<void>((done) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.ctx.signal.removeEventListener('abort', onAbort)
      done()
    }

    const kill = (): void => killProcessTree(child.pid, platform)
    const onAbort = (): void => {
      stopped = true
      kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, request.timeoutSec * 1000)

    child.once('error', (error) => {
      spawnError = messageOf(error)
      finish()
    })
    child.once('close', finish)
    if (request.ctx.signal.aborted) onAbort()
    else request.ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  const output = sink.text().trimEnd()
  const tail = sink.truncated() ? `\n...(cut, ${sink.total} characters in all)` : ''
  if (spawnError !== null) {
    record('failed', null, `Could not start: ${spawnError}`)
    return `Could not start that command: ${spawnError}`
  }
  if (stopped) {
    record('stopped', child.exitCode, 'Stopped by you.')
    return `Stopped by the user.${output === '' ? '' : `\n${output}${tail}`}`
  }
  if (timedOut) {
    const seconds = request.timeoutSec === 1 ? '1 second' : `${request.timeoutSec} seconds`
    record('timeout', child.exitCode, `Timed out after ${seconds}.`)
    return `Timed out after ${seconds}.${output === '' ? '' : `\n${output}${tail}`}`
  }
  const exit = child.exitCode ?? 0
  record(exit === 0 ? 'ok' : 'failed', exit)
  return `Exit ${exit}\n${output === '' ? '(no output)' : output}${tail}`
}

class OutputSink {
  total = 0
  private readonly parts: string[] = []
  private length = 0
  private cut = false

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const text = chunk.toString('utf8')
    this.total += text.length
    if (this.length >= this.limit) {
      this.cut = true
      return
    }
    const room = this.limit - this.length
    const piece = text.slice(0, room)
    this.parts.push(piece)
    this.length += piece.length
    if (piece.length < text.length) this.cut = true
  }

  text(): string {
    return this.parts.join('')
  }

  truncated(): boolean {
    return this.cut || this.total > this.limit
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
