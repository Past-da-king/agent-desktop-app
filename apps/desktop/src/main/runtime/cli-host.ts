/**
 * The piece the Runner talks to when the agent runs on the person's own plan (Claude or ChatGPT) instead
 * of an API key. It owns the local tool server, finds the engine each SDK ships with (unpacked from the
 * app archive in an installed build), keeps each conversation's session id between turns and across
 * restarts, and knows whether the person has signed in on this computer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import type { AgentEvent, JsonObject, Settings, Tool, ToolContext } from '@agent/core'

import { planModels, runCliTurn, type CliId, type PlanModel } from './cli-agent'
import { startToolServer, type ToolServer } from './mcp-server'
import { HELD_STEP, type TurnMessages } from './note-tools'
import { REPLACED_BY_SDK, sdkPermission } from './sdk-permissions'
import { usableFolder } from './work-folder'

export type { CliId }

export interface CliCall {
  id: string
  name: string
  input: JsonObject
}

export interface CliTurnRequest {
  cli: CliId
  /**
   * Which conversation this is: 'main' and 'helper:<id>' continue across turns (a pushed helper resumes
   * its own session), 'routine' starts fresh each time.
   */
  thread: string
  /** The tools this run may use (the main agent's set, or a helper's worker set). */
  tools: Tool[]
  /**
   * A helper thread that was given delegate on purpose (a routine's desk, workers/router.ts). Without it, a
   * helper's session never sees delegate or helper_*, whatever its tool list says.
   */
  delegates?: boolean
  system: string
  prompt: string
  /**
   * The prompt to use instead when there is no session to continue (none was saved, or the engine lost it): a
   * pushed helper's full brief, earlier steps and messages, so it never comes back knowing only its label.
   */
  freshPrompt?: string
  /** Messages for the model that arrive mid-turn: each is delivered as a message of its own, read before the next step. */
  messages?: TurnMessages
  images?: string[]
  model?: string
  /** The project folder the work is in (a project chat and the helpers it starts); absent for everything else. */
  folder?: string
  context: ToolContext
  signal: AbortSignal
  onEvent: (event: AgentEvent) => Promise<void>
  onCall: (call: CliCall) => Promise<void>
  onResult: (call: CliCall, result: string, isError: boolean) => Promise<void>
}

/**
 * Bump when the agent gains something a resumed conversation would not know about (a new way to answer, a
 * new setting). A session that started before it is told once, so it stops repeating what it said earlier.
 */
export const PROMPT_REVISION = 5
const UPDATE_NOTE =
  '[The Agent app was updated since earlier in this conversation. Read your instructions again: they now include GENERATIVE UI (OpenUI Lang), the "visual response" cards you draw by writing an openui-lang block, the user\'s current choice for commands and files, and run_script, which calls many of your tools in one script and returns only a small summary. You now work in the project\'s own folder when there is one, with the access the person chose, your agent tools (memory, tasks, browser, apps, delegate and the rest) are the ones named mcp__agent__* in your tool list, and helpers are mcp__agent__delegate (your engine\'s own sub-agents are gone). Anything you said before about not having these, or about a sandbox keeping you out of the project folder, is out of date.]'

/**
 * Helpers never delegate further, and a routine runs once with nobody to report to. Every chat's own agent
 * (the main thread and each project chat) keeps them: a project chat is its project's main agent.
 */
const NOT_ON_CLI = /^(delegate|helper_|helpers_)/

/** Whether a thread may hand work to helpers: not a helper's own session, not a routine. */
export function threadDelegates(thread: string): boolean {
  return !thread.startsWith('helper:') && thread !== 'routine'
}

/** The tools a plan session is given: no delegate for a helper unless it was granted on purpose (a desk). */
export function toolsForTurn(request: Pick<CliTurnRequest, 'tools' | 'thread' | 'cli' | 'delegates'>): Tool[] {
  return request.tools.filter(
    (tool) =>
      (request.delegates === true || threadDelegates(request.thread) || !NOT_ON_CLI.test(tool.spec.name)) &&
      // Claude brings its own (better) shell and file tools, asked through the app; Codex keeps the app's.
      !(request.cli === 'claude' && REPLACED_BY_SDK.has(tool.spec.name)),
  )
}

/** What run_script may call in a turn: the turn's tools without the delegation ones, the app's shell and files kept. */
export function scriptToolsForTurn(request: Pick<CliTurnRequest, 'tools' | 'thread' | 'delegates'>): Tool[] {
  return request.tools.filter((tool) => request.delegates === true || threadDelegates(request.thread) || !NOT_ON_CLI.test(tool.spec.name))
}

/** A native binary inside app.asar cannot be started; electron-builder unpacks it next to the archive. */
function unpacked(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

export class CliHost {
  private server: ToolServer | null = null
  private readonly sessionsFile: string
  private readonly require: NodeRequire

  constructor(
    private readonly workDir: string,
    /** The person's current settings: Shell commands and granted folders decide what Claude Code may do. */
    private readonly settings: () => Settings,
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
    // A build without the bundled engines (the headless node) names an installed one: AGENT_CLAUDE_PATH / AGENT_CODEX_PATH.
    const override = process.env[cli === 'claude' ? 'AGENT_CLAUDE_PATH' : 'AGENT_CODEX_PATH']?.trim() ?? ''
    if (override !== '' && existsSync(override)) return override
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

  /**
   * Runs the engine's own sign-in (`claude auth login`, `codex login`). Both open the browser; any sign-in
   * address they print is opened too, in case the engine could not open it itself. Up to 10 minutes.
   */
  login(cli: CliId, openUrl: (url: string) => void): Promise<{ ok: boolean; message: string }> {
    const program = this.engine(cli)
    const name = cli === 'claude' ? 'Claude' : 'ChatGPT'
    if (program === null) return Promise.resolve({ ok: false, message: `The ${name} sign-in is not available in this build.` })
    return new Promise((resolve) => {
      const child = spawn(program, cli === 'claude' ? ['auth', 'login'] : ['login'], {
        cwd: this.workDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const opened = new Set<string>()
      let output = ''
      const scan = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (output.length < 8000) output += text
        for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
          const url = match[0].replace(/[).,]+$/, '')
          if (!opened.has(url) && /claude\.ai|anthropic\.com|openai\.com|chatgpt\.com/.test(url)) {
            opened.add(url)
            openUrl(url)
          }
        }
      }
      child.stdout?.on('data', scan)
      child.stderr?.on('data', scan)
      const timer = setTimeout(() => {
        child.kill()
        resolve({ ok: false, message: 'The sign-in took too long. Try again.' })
      }, 10 * 60 * 1000)
      child.once('error', (error) => {
        clearTimeout(timer)
        resolve({ ok: false, message: `Could not start the ${name} sign-in: ${error.message}` })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve({ ok: true, message: `Signed in to ${name}.` })
        else resolve({ ok: false, message: output.trim().split('\n').pop()?.slice(0, 200) || `The ${name} sign-in did not finish.` })
      })
    })
  }

  /** What the plan offers right now, from the engine itself. */
  async models(cli: CliId): Promise<PlanModel[]> {
    const dir = join(this.workDir, cli, 'models')
    mkdirSync(dir, { recursive: true })
    return planModels(cli, this.engine(cli), dir)
  }

  /** Bumped by forget, so a turn that was running when its thread was forgotten does not save its session back. */
  private readonly forgotten = new Map<string, number>()

  forget(thread = 'main'): void {
    this.forgotten.set(thread, (this.forgotten.get(thread) ?? 0) + 1)
    const sessions = this.sessions()
    // Sessions are kept per engine as "<cli>:<thread>" (plus "#rev"), so forget the thread on every engine.
    for (const key of Object.keys(sessions)) {
      const bare = key.replace(/#rev$/, '')
      if (bare === thread || bare.endsWith(`:${thread}`)) delete sessions[key]
    }
    this.saveSessions(sessions)
  }

  async turn(request: CliTurnRequest): Promise<{ text: string; error?: string }> {
    const server = await this.ensureServer()
    const token = server.open({
      tools: toolsForTurn(request),
      // A script reaches the app's own shell and file tools even where Claude's replace them for the model.
      scriptTools: scriptToolsForTurn(request),
      context: request.context,
      onCall: request.onCall,
      onResult: request.onResult,
    })
    const continues = request.thread !== 'routine'
    const generation = this.forgotten.get(request.thread) ?? 0
    const dir = join(this.workDir, request.cli, request.thread.replace(/[^a-z0-9-]/gi, '_'))
    // A helper another computer placed here works with that computer's commands-and-files choice.
    const settings = (): Settings => {
      const own = this.settings()
      const shell = request.context.shell
      return shell === undefined ? own : { ...own, shell }
    }
    const folder = usableFolder(request.folder)
    try {
      const key = `${request.cli}:${request.thread}`
      const stored = continues ? (this.sessions()[key] ?? null) : null
      const stale = stored !== null && this.sessions()[`${key}#rev`] !== String(PROMPT_REVISION)
      const permission = sdkPermission({
        settings,
        approve: (summary, details) => request.context.approve(summary, details, 'computer'),
        alsoAllowed: [dir],
      })
      const messages = request.messages
      const run = (sessionId: string | null) =>
        runCliTurn({
          cli: request.cli,
          program: this.engine(request.cli),
          system: request.system,
          prompt:
            sessionId === null
              ? (request.freshPrompt ?? request.prompt)
              : stale
                ? `${UPDATE_NOTE}\n\n${request.prompt}`
                : request.prompt,
          images: request.images ?? [],
          sessionId,
          // Kept the moment the engine names it, not only when the turn ends: a restart mid-turn resumes this
          // conversation instead of starting one that knows nothing (25 Oct 2026).
          onSession: (id: string) => {
            if (continues && id !== '' && (this.forgotten.get(request.thread) ?? 0) === generation && this.sessions()[key] !== id) {
              this.saveSessions({ ...this.sessions(), [key]: id, [`${key}#rev`]: String(PROMPT_REVISION) })
            }
          },
          ...(request.model === undefined ? {} : { model: request.model }),
          mcp: { url: server.url, token },
          workDir: dir,
          ...(folder === undefined ? {} : { folder }),
          // Read when the turn starts: Run without asking frees the engine's own tools, as it frees Claude's.
          access: settings().shell === 'always' ? 'free' : 'asked',
          signal: request.signal,
          onEvent: request.onEvent,
          ...(messages === undefined ? {} : { messages }),
          permission: async (name, input) => {
            // A message is on its way: this step waits for the model to read it. The message itself never travels here.
            if (messages?.hold() === true) return { allow: false as const, message: HELD_STEP }
            return permission(name, input)
          },
        })
      mkdirSync(dir, { recursive: true })
      let result = await run(stored)
      if (result.error === 'SESSION_LOST') result = await run(null)
      if (continues && result.sessionId !== null && (this.forgotten.get(request.thread) ?? 0) === generation) {
        this.saveSessions({ ...this.sessions(), [key]: result.sessionId, [`${key}#rev`]: String(PROMPT_REVISION) })
      }
      return result.error === undefined ? { text: result.text } : { text: result.text, error: result.error }
    } finally {
      server.release(token)
    }
  }

  async close(): Promise<void> {
    await this.server?.close()
    this.server = null
  }

  private async ensureServer(): Promise<ToolServer> {
    if (this.server !== null) return this.server
    this.server = await startToolServer()
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
