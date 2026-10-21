/**
 * `run_code`: a small scratch folder and a child process, so the agent can calculate, transform data
 * and build files. It runs JavaScript with Node or Python with python3, asks first every time, and
 * is stopped after 30 seconds. Files it makes stay in the scratch folder and are reported back.
 */
import type { ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { enumOf, schema, str, type JsonObject, type Tool } from '@agent/core'

import type { ProgramRef } from '../runtime/environment'
import { spawnResolved } from '../runtime/spawn'
import { killProcessTree, sanitiseEnv } from './shell'
import { recordRun, StreamCapture } from './run-capture'

export const CODE_TIMEOUT_MS = 30_000
export const MAX_CODE_OUTPUT_CHARS = 20_000

export type CodeLanguage = 'javascript' | 'python'

/** The scan, as run_code needs it. */
export interface CodeEnvironment {
  node(): ProgramRef | null
  python(): ProgramRef | null
}

export interface CodeToolDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Tests point the scratch folder somewhere they can clean up. */
  tempRoot?: string
  timeoutMs?: number
  /** Old-style lookup; kept for callers that only need one name. */
  findCommand?: (name: string) => string | null
  /** The environment scan. Without it the app's own runtime runs JavaScript. */
  environment?: CodeEnvironment
  /** The app's own executable, used when no Node is installed. */
  execPath?: string
  /** Tests capture the exact program and arguments without running anything. */
  spawnImpl?: typeof spawn
  /** The person's choice for this computer: run without asking, ask first, or never. Absent means ask. */
  settings?: { get(): { shell: 'always' | 'ask' | 'never' } }
}

export function codeTools(deps: CodeToolDeps = {}): Tool[] {
  return [runCodeTool(deps)]
}

/** A real executable from PATH (honours PATHEXT on Windows). Null when it is not installed. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  if (pathValue.trim() === '') return null
  const extensions =
    platform === 'win32'
      ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter((ext) => ext !== '')
      : ['']

  for (const folder of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (folder.trim() === '') continue
    for (const extension of extensions) {
      const candidate =
        platform === 'win32' && !name.toLowerCase().endsWith(extension.toLowerCase())
          ? `${name}${extension}`
          : name
      try {
        accessSync(join(folder, candidate), constants.X_OK)
        return join(folder, candidate)
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null
}

function runCodeTool(deps: CodeToolDeps): Tool {
  return {
    spec: {
      name: 'run_code',
      description:
        'Run JavaScript (Node) or Python in a temporary folder on this computer. Use it to calculate, parse or transform data and to create files (CSV, JSON, HTML, SVG, Markdown). Print what you want back with console.log or print. No package installs.',
      schema: schema(['language', 'code'], {
        language: enumOf('Which language', 'javascript', 'python'),
        code: str('The whole program to run'),
      }),
    },
    run: async (input, ctx) => {
      const language = input['language']
      if (language !== 'javascript' && language !== 'python') {
        return "Choose 'javascript' or 'python'."
      }
      const code = text(input['code'])
      if (code.trim() === '') return 'Pass the code to run.'

      const chosen = resolveCodeProgram(language, deps)
      if (chosen.program === null) {
        return 'Python is not installed on this computer (no py, python or python3 found), so I could not run that. I did not try to install anything.'
      }

      const choice = deps.settings?.get().shell ?? 'ask'
      const declined = (note: string): void =>
        recordRun(input, { kind: 'code', input: code, label: language, stdout: '', stderr: '', exitCode: null, ms: 0, state: 'declined', trimmed: false, note })
      if (choice === 'never') {
        declined('Running code is turned off in Settings.')
        return 'Running code is turned off on this computer (Settings, This computer). Do the job another way or ask the user to turn it on.'
      }
      const approved =
        choice === 'always' ||
        (await ctx.approve(
          `Run ${language} code`,
          code.length > 4_000 ? `${code.slice(0, 4_000)}\n...(the rest is cut here, but all of it runs)` : code,
          'computer',
        ))
      if (!approved) {
        declined('You did not approve it.')
        return 'The user did not approve running that code, so I did not run it.'
      }

      return execute({ language, code, program: chosen.program, appRuntime: chosen.appRuntime, deps, input })
    },
  }
}

/**
 * JavaScript always works: the person's own Node when the scan found one, otherwise the runtime
 * that ships inside the app (`ELECTRON_RUN_AS_NODE`).
 */
export function resolveCodeProgram(
  language: CodeLanguage,
  deps: CodeToolDeps,
): { program: ProgramRef | null; appRuntime: boolean } {
  return language === 'javascript' ? javascriptChoice(deps) : { program: pythonProgram(deps), appRuntime: false }
}

function javascriptChoice(deps: CodeToolDeps): { program: ProgramRef; appRuntime: boolean } {
  const found = deps.environment?.node() ?? null
  if (found !== null) return { program: found, appRuntime: false }
  if (deps.findCommand !== undefined) {
    const path = deps.findCommand('node')
    if (path !== null) return { program: { path, prefix: [], kind: 'exe' }, appRuntime: false }
  }
  const fallback = deps.execPath ?? process.execPath
  return { program: { path: fallback, prefix: [], kind: 'exe' }, appRuntime: true }
}

/** Python is only ever the one already on this computer. Nothing is installed. */
function pythonProgram(deps: CodeToolDeps): ProgramRef | null {
  if (deps.environment !== undefined) return deps.environment.python()
  if (deps.findCommand !== undefined) {
    const path = deps.findCommand('python3') ?? deps.findCommand('python')
    return path === null ? null : { path, prefix: [], kind: 'exe' }
  }
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  if (platform === 'win32') {
    const launcher = findOnPath('py', env, platform)
    if (launcher !== null) return { path: launcher, prefix: ['-3'], kind: 'exe' }
  }
  const path = findOnPath('python', env, platform) ?? findOnPath('python3', env, platform)
  return path === null ? null : { path, prefix: [], kind: 'exe' }
}

interface ExecuteRequest {
  language: CodeLanguage
  code: string
  program: ProgramRef
  /** True when JavaScript fell back to the runtime inside the app. */
  appRuntime: boolean
  deps: CodeToolDeps
  /** The call's own input object: the run is recorded against it for the chat row. */
  input?: JsonObject
}

async function execute(request: ExecuteRequest): Promise<string> {
  const platform = request.deps.platform ?? process.platform
  const env = request.deps.env ?? process.env
  const root = request.deps.tempRoot ?? tmpdir()
  let folder: string
  try {
    folder = await fs.mkdtemp(join(root, 'agent-code-'))
  } catch (error) {
    return `Could not make a scratch folder: ${messageOf(error)}`
  }

  const scriptName = request.language === 'javascript' ? 'main.mjs' : 'main.py'
  const script = join(folder, scriptName)
  try {
    await fs.writeFile(script, request.code, 'utf8')
  } catch (error) {
    return `Could not write the program: ${messageOf(error)}`
  }

  const sink = new OutputSink(MAX_CODE_OUTPUT_CHARS)
  const out = new StreamCapture()
  const err = new StreamCapture()
  const started = Date.now()
  const record = (state: 'ok' | 'failed' | 'timeout', exitCode: number | null, note?: string): void => {
    if (request.input === undefined) return
    recordRun(request.input, {
      kind: 'code',
      input: request.code,
      label: request.language,
      cwd: folder,
      stdout: out.text(),
      stderr: err.text(),
      exitCode,
      ms: Date.now() - started,
      state,
      trimmed: out.trimmed() || err.trimmed(),
      ...(note === undefined ? {} : { note }),
    })
  }
  const extra = request.appRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  let child: ChildProcess
  try {
    child = spawnResolved(request.program.path, [...request.program.prefix, script], {
      platform,
      cwd: folder,
      env: { ...sanitiseEnv(env), HOME: folder, USERPROFILE: folder, ...extra },
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(request.deps.spawnImpl === undefined ? {} : { spawnImpl: request.deps.spawnImpl }),
    })
  } catch (error) {
    record('failed', null, `Could not start: ${messageOf(error)}`)
    return `Could not run the program: ${messageOf(error)}`
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    sink.push(chunk)
    out.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    sink.push(chunk)
    err.push(chunk)
  })

  const timeoutMs = request.deps.timeoutMs ?? CODE_TIMEOUT_MS
  let timedOut = false
  let spawnError: string | null = null

  await new Promise<void>((done) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid, platform)
    }, timeoutMs)
    child.once('error', (error) => {
      spawnError = messageOf(error)
      finish()
    })
    child.once('close', finish)
  })

  const written = await listFiles(folder, scriptName)
  const output = sink.text().trimEnd()
  const tail = sink.truncated() ? `\n...(cut, ${sink.total} characters in all)` : ''

  if (spawnError !== null) {
    record('failed', null, `Could not start: ${spawnError}`)
    return `Could not run the program: ${spawnError}`
  }
  const exit = child.exitCode ?? 0
  if (timedOut) record('timeout', child.exitCode, `Timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
  else record(exit === 0 ? 'ok' : 'failed', exit, written.length === 0 ? undefined : `Files written: ${written.join(', ')}`)
  const head = timedOut
    ? `Timed out after ${Math.round(timeoutMs / 1000)} seconds.`
    : `Exit ${child.exitCode ?? 0}`
  const files =
    written.length === 0
      ? ''
      : `\nFiles written:\n${written.map((path) => `- ${path}`).join('\n')}`
  return `${head}\n${output === '' ? '(no output)' : output}${tail}${files}`
}

/** Everything in the scratch folder except the program itself, deepest last. */
async function listFiles(folder: string, scriptName: string): Promise<string[]> {
  const found: string[] = []
  const queue: Array<{ folder: string; depth: number }> = [{ folder, depth: 0 }]
  while (queue.length > 0 && found.length < 100) {
    const next = queue.shift()
    if (next === undefined) break
    let entries
    try {
      entries = await fs.readdir(next.folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(next.folder, entry.name)
      if (entry.isDirectory()) {
        if (next.depth < 4) queue.push({ folder: full, depth: next.depth + 1 })
        continue
      }
      if (full === join(folder, scriptName)) continue
      const size = await fs.stat(full).then(
        (stat) => stat.size,
        () => 0,
      )
      found.push(`${full} (${size} bytes)`)
    }
  }
  return found
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
    const piece = text.slice(0, this.limit - this.length)
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
