/**
 * The piece the Runner talks to when the agent runs on an installed AI tool instead of an API key.
 * It owns the local tool server, finds the program, keeps each conversation's CLI session id between
 * turns (and across restarts), and starts and stops the process the right way on every system.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentEvent, JsonObject, Tool, ToolContext } from '@agent/core'

import { killProcessTree } from '../tools/shell'
import { runCliTurn, type CliId } from './cli-agent'
import { resolveCommand } from './environment'
import { fileProbe } from './environment-host'
import { startToolServer, type ToolServer } from './mcp-server'
import { spawnResolved } from './spawn'

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
  model?: string
  context: ToolContext
  signal: AbortSignal
  onEvent: (event: AgentEvent) => Promise<void>
  onCall: (call: CliCall) => Promise<void>
  onResult: (call: CliCall, result: string, isError: boolean) => Promise<void>
}

/** Tools that start more model runs of their own: on a subscription the CLI does that work itself. */
const NOT_ON_CLI = /^(delegate|helper_|helpers_)/

export class CliHost {
  private server: ToolServer | null = null
  private current: { context: ToolContext; onCall: CliTurnRequest['onCall']; onResult: CliTurnRequest['onResult'] } | null = null
  private readonly sessionsFile: string

  constructor(
    private readonly tools: () => Tool[],
    private readonly workDir: string,
  ) {
    mkdirSync(workDir, { recursive: true })
    this.sessionsFile = join(workDir, 'sessions.json')
  }

  /** Where the program lives, or null when it is not installed. */
  program(cli: CliId): string | null {
    return resolveCommand(cli, { platform: process.platform, env: process.env, fs: fileProbe })?.path ?? null
  }

  forget(thread: 'main' | 'routine' = 'main'): void {
    const sessions = this.sessions()
    delete sessions[thread]
    this.saveSessions(sessions)
  }

  async turn(request: CliTurnRequest): Promise<{ text: string; error?: string }> {
    const program = this.program(request.cli)
    if (program === null) {
      return { text: '', error: 'Claude Code is not installed on this computer. Install it, sign in once, then try again.' }
    }
    const server = await this.ensureServer()
    this.current = { context: request.context, onCall: request.onCall, onResult: request.onResult }
    try {
      const sessions = this.sessions()
      const run = (sessionId: string | null) =>
        runCliTurn({
          cli: request.cli,
          program,
          system: request.system,
          prompt: request.prompt,
          sessionId,
          ...(request.model === undefined ? {} : { model: request.model }),
          mcp: { url: server.url, token: server.token },
          workDir: join(this.workDir, request.thread),
          signal: request.signal,
          spawn: (file, args, options) =>
            spawnResolved(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
          kill: (child) => killProcessTree(child.pid, process.platform),
          onEvent: request.onEvent,
        })
      let result = await run(request.thread === 'main' ? (sessions[request.thread] ?? null) : null)
      if (result.error === 'SESSION_LOST') result = await run(null)
      if (request.thread === 'main' && result.sessionId !== null) {
        this.saveSessions({ ...this.sessions(), main: result.sessionId })
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
      // Losing the session id only means the next turn starts a fresh CLI conversation.
    }
  }
}
