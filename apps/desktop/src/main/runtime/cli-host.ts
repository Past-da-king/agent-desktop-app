/**
 * The piece the Runner talks to when the agent runs on the person's own plan (Claude or ChatGPT) instead
 * of an API key. It owns the local tool server, finds the engine each SDK ships with (unpacked from the
 * app archive in an installed build), keeps each conversation's session id between turns and across
 * restarts, and knows whether the person has signed in on this computer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import type { AgentEvent, JsonObject, Tool, ToolContext } from '@agent/core'

import { runCliTurn, type CliId } from './cli-agent'
import { startToolServer, type ToolServer } from './mcp-server'

export type { CliId }

export interface CliCall {
  id: string
  name: string
  input: JsonObject
}

export interface CliTurnRequest {
  cli: CliId
  /** Which conversation this is: 'main' continues across turns, a routine starts fresh each time. */
  thread: 'main' | 'routine'
  system: string
  prompt: string
  images?: string[]
  model?: string
  context: ToolContext
  signal: AbortSignal
  onEvent: (event: AgentEvent) => Promise<void>
  onCall: (call: CliCall) => Promise<void>
  onResult: (call: CliCall, result: string, isError: boolean) => Promise<void>
}

/** Tools that start more model runs of their own: on a plan the engine does that work itself. */
const NOT_ON_CLI = /^(delegate|helper_|helpers_)/

/** A native binary inside app.asar cannot be started; electron-builder unpacks it next to the archive. */
function unpacked(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

export class CliHost {
  private server: ToolServer | null = null
  private current: { context: ToolContext; onCall: CliTurnRequest['onCall']; onResult: CliTurnRequest['onResult'] } | null = null
  private readonly sessionsFile: string
  private readonly require: NodeRequire

  constructor(
    private readonly tools: () => Tool[],
    private readonly workDir: string,
    /** The app folder (app.getAppPath()), where the SDK packages are resolved from. */
    appPath: string,
  ) {
    mkdirSync(workDir, { recursive: true })
    this.sessionsFile = join(workDir, 'sessions.json')
    this.require = createRequire(join(appPath, 'package.json'))
  }

  /** The engine binary the SDK ships for this computer, or null to let the SDK find it itself. */
  engine(cli: CliId): string | null {
    const exe = process.platform === 'win32' ? '.exe' : ''
    try {
      if (cli === 'claude') {
        const pkg = this.require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
        const file = join(dirname(pkg), `claude${exe}`)
        return existsSync(unpacked(file)) ? unpacked(file) : existsSync(file) ? file : null
      }
      const pkg = this.require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)
      const vendor = join(dirname(pkg), 'vendor')
      for (const base of [unpacked(vendor), vendor].filter((dir) => existsSync(dir))) {
        for (const triple of readdirSync(base)) {
          const file = join(base, triple, 'bin', `codex${exe}`)
          if (existsSync(file)) return file
        }
      }
    } catch {
      // Not bundled for this platform: the SDK falls back to its own lookup.
    }
    return null
  }

  /** Whether the person has signed in to this tool on this computer (the SDK reuses that login). */
  signedIn(cli: CliId): boolean {
    const home = homedir()
    if (cli === 'claude') {
      const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
      // macOS keeps the Claude login in the keychain, so a config folder is the best signal there.
      return existsSync(join(configDir, '.credentials.json')) || (process.platform === 'darwin' && existsSync(configDir))
    }
    const codexHome = process.env['CODEX_HOME'] ?? join(home, '.codex')
    return existsSync(join(codexHome, 'auth.json'))
  }

  forget(thread: 'main' | 'routine' = 'main'): void {
    const sessions = this.sessions()
    delete sessions[thread]
    this.saveSessions(sessions)
  }

  async turn(request: CliTurnRequest): Promise<{ text: string; error?: string }> {
    const server = await this.ensureServer()
    this.current = { context: request.context, onCall: request.onCall, onResult: request.onResult }
    try {
      const key = `${request.cli}:${request.thread}`
      const run = (sessionId: string | null) =>
        runCliTurn({
          cli: request.cli,
          program: this.engine(request.cli),
          system: request.system,
          prompt: request.prompt,
          images: request.images ?? [],
          sessionId,
          ...(request.model === undefined ? {} : { model: request.model }),
          mcp: { url: server.url, token: server.token },
          workDir: join(this.workDir, request.cli, request.thread),
          signal: request.signal,
          onEvent: request.onEvent,
        })
      mkdirSync(join(this.workDir, request.cli, request.thread), { recursive: true })
      let result = await run(request.thread === 'main' ? (this.sessions()[key] ?? null) : null)
      if (result.error === 'SESSION_LOST') result = await run(null)
      if (request.thread === 'main' && result.sessionId !== null) {
        this.saveSessions({ ...this.sessions(), [key]: result.sessionId })
      }
      return result.error === undefined ? { text: result.text } : { text: result.text, error: result.error }
    } finally {
      this.current = null
    }
  }

  async close(): Promise<void> {
    await this.server?.close()
    this.server = null
  }

  private async ensureServer(): Promise<ToolServer> {
    if (this.server !== null) return this.server
    this.server = await startToolServer({
      tools: () => this.tools().filter((tool) => !NOT_ON_CLI.test(tool.spec.name)),
      context: () => this.current?.context ?? null,
      onCall: (call) => this.current?.onCall(call),
      onResult: (call, result, isError) => this.current?.onResult(call, result, isError),
    })
    return this.server
  }

  private sessions(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.sessionsFile, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
    } catch {
      return {}
    }
  }

  private saveSessions(value: Record<string, string>): void {
    try {
      writeFileSync(this.sessionsFile, JSON.stringify(value), { mode: 0o600 })
    } catch {
      // Losing the session id only means the next turn starts a fresh conversation.
    }
  }
}
