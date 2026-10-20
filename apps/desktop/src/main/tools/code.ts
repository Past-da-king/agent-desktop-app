/**
 * `run_code`: a small scratch folder and a child process, so the agent can calculate, transform data
 * and build files. It runs JavaScript with Node or Python with python3, asks first every time, and
 * is stopped after 30 seconds. Files it makes stay in the scratch folder and are reported back.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { enumOf, schema, str, type Tool } from '@agent/core'

import { killProcessTree, sanitiseEnv } from './shell'

export const CODE_TIMEOUT_MS = 30_000
export const MAX_CODE_OUTPUT_CHARS = 20_000

export type CodeLanguage = 'javascript' | 'python'

export interface CodeToolDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Tests point the scratch folder somewhere they can clean up. */
  tempRoot?: string
  timeoutMs?: number
  findCommand?: (name: string) => string | null
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

      const platform = deps.platform ?? process.platform
      const env = deps.env ?? process.env
      const find = deps.findCommand ?? ((name: string) => findOnPath(name, env, platform))
      const command =
        language === 'javascript'
          ? find('node')
          : (find('python3') ?? find(platform === 'win32' ? 'python' : 'python3'))
      if (command === null) {
        return language === 'javascript'
          ? 'JavaScript is not available on this computer.'
          : 'Python is not installed on this computer (no python3 found).'
      }

      const approved = await ctx.approve(
        `Run ${language} code`,
        code.length > 4_000 ? `${code.slice(0, 4_000)}\n...(the rest is cut here, but all of it runs)` : code,
      )
      if (!approved) return 'The user did not approve running that code, so I did not run it.'

      return execute({ language, code, command, deps, platform, env })
    },
  }
}

interface ExecuteRequest {
  language: CodeLanguage
  code: string
  command: string
  deps: CodeToolDeps
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

async function execute(request: ExecuteRequest): Promise<string> {
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
  const child = spawn(request.command, [script], {
    cwd: folder,
    env: { ...sanitiseEnv(request.env), HOME: folder, USERPROFILE: folder },
    detached: request.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => sink.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => sink.push(chunk))

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
      killProcessTree(child.pid, request.platform)
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

  if (spawnError !== null) return `Could not run the program: ${spawnError}`
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
