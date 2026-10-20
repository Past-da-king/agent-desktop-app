/**
 * `shell_run`: the agent may use this computer's shell, but only with the person's explicit yes,
 * every single time, with the exact command on the card. There is no "always allow" (PLAN.md 7).
 *
 * The child process never inherits anything that looks like a key, token, secret or password.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'

import { int, schema, str, type Tool } from '@agent/core'

import type { ToolContext } from '@agent/core'

export const DEFAULT_TIMEOUT_SEC = 60
export const MAX_TIMEOUT_SEC = 600
export const MAX_OUTPUT_CHARS = 20_000

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD/i

export interface ShellSettingsView {
  get(): { shell: 'ask' | 'never' }
}

export interface ShellToolDeps {
  settings: ShellSettingsView
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
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
    clean[name] = value
  }
  return clean
}

/** Kill the command and anything it started. POSIX uses the process group set up by `detached`. */
export function killProcessTree(pid: number | undefined, platform = process.platform): void {
  if (pid === undefined) return
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
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
      }),
    },
    run: async (input, ctx) => {
      const command = text(input['command']).trim()
      if (command === '') return 'Pass the command to run.'

      if (deps.settings.get().shell === 'never') {
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

      const approved = await ctx.approve(
        `Run: ${command}`,
        `${cwd === undefined ? '' : `In ${cwd}\n`}This runs a real command on this computer. It stops after ${timeoutSec} seconds.`,
      )
      if (!approved) return 'The user did not approve that command, so I did not run it.'

      return runCommand({ command, cwd, timeoutSec, ctx, deps })
    },
  }
}

interface RunRequest {
  command: string
  cwd: string | undefined
  timeoutSec: number
  ctx: ToolContext
  deps: ShellToolDeps
}

async function runCommand(request: RunRequest): Promise<string> {
  const platform = request.deps.platform ?? process.platform
  const env = sanitiseEnv({ ...(request.deps.env ?? process.env) })
  const shell =
    platform === 'win32'
      ? { file: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', request.command] }
      : { file: '/bin/sh', args: ['-c', request.command] }

  const sink = new OutputSink(MAX_OUTPUT_CHARS)
  let child: ChildProcess
  try {
    child = (request.deps.spawnImpl ?? spawn)(shell.file, shell.args, {
      cwd: request.cwd,
      env,
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return `Could not start that command: ${messageOf(error)}`
  }

  child.stdout?.on('data', (chunk: Buffer) => sink.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => sink.push(chunk))

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
  if (spawnError !== null) return `Could not start that command: ${spawnError}`
  if (stopped) return `Stopped by the user.${output === '' ? '' : `\n${output}${tail}`}`
  if (timedOut) {
    const seconds = request.timeoutSec === 1 ? '1 second' : `${request.timeoutSec} seconds`
    return `Timed out after ${seconds}.${output === '' ? '' : `\n${output}${tail}`}`
  }
  return `Exit ${child.exitCode ?? 0}\n${output === '' ? '(no output)' : output}${tail}`
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
