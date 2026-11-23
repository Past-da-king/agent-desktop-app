/**
 * The piece the Runner talks to when the agent runs on the person's own plan (Claude or ChatGPT) instead
 * of an API key. It owns the local tool server, finds the engine each SDK ships with (unpacked from the
 * app archive in an installed build), keeps each conversation's session id between turns and across
 * restarts, and knows whether the person has signed in on this computer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { accountsOf } from '@agent/core'
import type { AgentEvent, AiAccount, AiAccountStatus, AiUsageWindow, JsonObject, Settings, Tool, ToolContext } from '@agent/core'

import {
  AccountHomes,
  UsageStore,
  claudeUsageFromApi,
  codexUsage,
  engineHomeEnv,
  identityFromStatus,
  identityOf,
  type HomeEntry,
} from './account-home'
import { isLimitFailure, planModels, runCliTurn, type CliId, type PlanModel } from './cli-agent'
import { engineAccess } from './engine-policy'
import { startToolServer, type ToolServer } from './mcp-server'
import { HELD_STEP, type TurnMessages } from './note-tools'
import { REPLACED_BY_SDK, sdkPermission } from './sdk-permissions'
import { SIGN_IN_CHECK_MS, SIGN_IN_RETRY_MS, isSignInFailure, loginFileDead, signInVerdict } from './sign-in-check'
import { addClaudeRoot } from './run-detail'
import { usableFolder } from './work-folder'

export type { CliId }

export interface CliCall {
  id: string
  name: string
  input: JsonObject
}

/** Which account a turn ran on, written to the run log and handed to whoever listens (the app's log, tests). */
export interface AccountRan {
  at: number
  cli: CliId
  thread: string
  account: string
  /** Set when this run is a failover: the account that hit its limit first. */
  failedOverFrom?: string
}

/** What a running sign-in shows on the account's card. */
export interface SignInPrompt {
  url: string
  code: string
  /** Claude: the page shows a code the person pastes into the card. */
  needsPaste: boolean
}

/** How long an account that hit a limit it gave no reset time for is skipped by failover. */
export const LIMIT_PAUSE_MS = 30 * 60_000

export interface CliTurnRequest {
  cli: CliId
  /** The plan account this turn runs as: its own sign-in home. Absent: the computer's own login (older callers). */
  accountId?: string
  /** Other accounts of the same kind to retry on, in order, when this one hits its limit. Empty: no failover. */
  failover?: string[]
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
  /** Each plan account's own sign-in home (account-home.ts). */
  readonly homes: AccountHomes
  readonly usage: UsageStore
  /** Told which account every run used (and when it was a failover). */
  onRan: ((ran: AccountRan) => void) | null = null
  private readonly runLog: string
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly workDir: string,
    /** The person's current settings: Shell commands and granted folders decide what Claude Code may do. */
    private readonly settings: () => Settings,
    /** The app folder (app.getAppPath()), where the SDK packages are resolved from. */
    appPath: string,
    /** Where the sign-in homes and usage are kept; the app's data folder next to cli/ by default. */
    options: { homes?: AccountHomes; usage?: UsageStore; accounts?: () => AiAccount[]; env?: NodeJS.ProcessEnv; home?: string; root?: string; fetch?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch
    mkdirSync(workDir, { recursive: true })
    this.sessionsFile = join(workDir, 'sessions.json')
    this.runLog = join(workDir, 'account-runs.log')
    this.require = createRequire(join(appPath, 'package.json'))
    this.homes =
      options.homes ??
      new AccountHomes({
        file: join(workDir, 'account-homes.json'),
        root: options.root ?? join(dirname(workDir), 'accounts'),
        accounts: options.accounts ?? (() => accountsOf(this.settings())),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.home === undefined ? {} : { home: options.home }),
      })
    this.usage = options.usage ?? new UsageStore(join(workDir, 'account-usage.json'))
  }

  /** The sign-in home for an account of this kind (the computer's own login when no account is named). */
  entry(cli: CliId, account?: string): HomeEntry {
    const entry = this.homes.resolve(account, cli)
    if (cli === 'claude') addClaudeRoot(entry.dir)
    return entry
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

  /** The file that holds this account's login. */
  private loginFile(cli: CliId, account?: string): string {
    return join(this.entry(cli, account).dir, cli === 'claude' ? '.credentials.json' : 'auth.json')
  }

  /** When the login file last changed (0 when there is none): a new sign-in, or a refresh, changes it. */
  private loginStamp(cli: CliId, account?: string): number {
    try {
      return statSync(this.loginFile(cli, account)).mtimeMs
    } catch {
      return 0
    }
  }

  /** The accounts whose login is known to be dead on this computer, and the login file's stamp when that was found. */
  private readonly refused = new Map<string, { at: number; stamp: number }>()
  /** Told when an account's login is found dead or working again, so the node can say so to the other devices at once. */
  onSignInChange: ((cli: CliId, usable: boolean, account?: string) => void) | null = null

  private static key(cli: CliId, account?: string): string {
    return `${cli}:${account ?? ''}`
  }

  private refuse(cli: CliId, account?: string): void {
    const key = CliHost.key(cli, account)
    const was = this.refused.has(key)
    this.refused.set(key, { at: Date.now(), stamp: this.loginStamp(cli, account) })
    if (!was) this.onSignInChange?.(cli, false, account)
  }

  private accept(cli: CliId, account?: string): void {
    if (this.refused.delete(CliHost.key(cli, account))) this.onSignInChange?.(cli, true, account)
  }

  /**
   * Whether the person has signed in to this tool on this computer (the SDK reuses that login) AND the login still
   * works: a login file whose session ran out for good, or one a turn or a check found dead, does not count until the
   * file changes (a new sign-in) or SIGN_IN_RETRY_MS has passed. A computer that cannot answer must not say it can
   * (12 Nov 2026: the server kept a dead Claude login file, said it was ready, and answered the phone with an error).
   */
  signedIn(cli: CliId, account?: string): boolean {
    const entry = this.entry(cli, account)
    if (cli === 'claude') {
      // macOS keeps the computer's own Claude login in the keychain, so its config folder is the best signal there.
      if (!(existsSync(join(entry.dir, '.credentials.json')) || (process.platform === 'darwin' && entry.shared && existsSync(entry.dir)))) return false
    } else if (!existsSync(this.loginFile(cli, account))) return false
    if (loginFileDead(this.loginFile(cli, account), Date.now())) return false
    const refused = this.refused.get(CliHost.key(cli, account))
    if (refused === undefined) return true
    if (this.loginStamp(cli, account) !== refused.stamp || Date.now() - refused.at > SIGN_IN_RETRY_MS) {
      this.accept(cli, account)
      return true
    }
    return false
  }

  /**
   * Asks the engine itself whether the login works (`claude auth status`, `codex login status`: local, free, quick)
   * and remembers the answer. Unknown (no engine, no answer) changes nothing.
   */
  async checkSignIn(cli: CliId, account?: string): Promise<boolean | null> {
    const program = this.engine(cli)
    if (program === null) return null
    const args = cli === 'claude' ? ['auth', 'status'] : ['login', 'status']
    const env = { ...engineHomeEnv(this.entry(cli, account)), ELECTRON_RUN_AS_NODE: undefined }
    const answer = await new Promise<{ code: number | null; out: string } | null>((resolve) => {
      execFile(program, args, { timeout: 20_000, windowsHide: true, env }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
        resolve(error !== null && code === null ? null : { code, out: `${stdout}\n${stderr}` })
      })
    })
    if (answer === null) return null
    const usable = signInVerdict(cli, answer.code, answer.out)
    if (usable === null) return null
    if (usable) this.accept(cli, account)
    else this.refuse(cli, account)
    return usable
  }

  /**
   * Checks soon and then every [every] ms, for each tool [clis] names (a kind, or { cli, account } for one account's
   * own sign-in); stop it with the function it returns.
   */
  watchSignIn(clis: () => Array<CliId | { cli: CliId; account: string }>, every = SIGN_IN_CHECK_MS): () => void {
    const run = (): void => {
      for (const each of clis()) {
        const target = typeof each === 'string' ? { cli: each, account: undefined } : each
        void this.checkSignIn(target.cli, target.account).catch(() => undefined)
      }
    }
    const first = setTimeout(run, 3_000)
    const timer = setInterval(run, every)
    first.unref?.()
    timer.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }

  /** Sign-ins running now, by account: what to show the person (address, code) and how to reach the engine. */
  private readonly signIns = new Map<string, { prompt: SignInPrompt; child: ChildProcess }>()

  /** What a running sign-in is waiting for, for the account's card: the address, the code, or a code to paste. */
  signInPrompt(account: string): SignInPrompt | null {
    const running = this.signIns.get(account)
    // Nothing to show until the engine has printed its address (and, for Codex, its code).
    if (running === undefined || running.prompt.url === '' || (!running.prompt.needsPaste && running.prompt.code === '')) return null
    return { ...running.prompt }
  }

  /** Claude shows a code on its sign-in page; the person pastes it and it goes to the engine. False when none is waiting. */
  submitSignInCode(account: string, code: string): boolean {
    const running = this.signIns.get(account)
    const text = code.trim()
    if (running === undefined || !running.prompt.needsPaste || text === '' || running.child.stdin === null || running.child.stdin.destroyed) return false
    running.child.stdin.write(`${text}\n`)
    return true
  }

  /** Stops a running sign-in. */
  cancelSignIn(account: string): void {
    const running = this.signIns.get(account)
    if (running === undefined) return
    this.signIns.delete(account)
    running.child.kill()
  }

  /** A program that does nothing, for BROWSER: the engine must not open the computer's default browser. */
  private noBrowser(): string {
    if (process.platform !== 'win32') return 'true'
    const file = join(this.workDir, 'no-browser.cmd')
    if (!existsSync(file)) writeFileSync(file, '@echo off\r\nexit /b 0\r\n')
    return file
  }

  /**
   * Runs the engine's own sign-in in that account's home, never in the computer's default browser (which is usually
   * already signed in as ONE account). Codex uses its device flow (`codex login --device-auth`: an address and a
   * one-time code, no browser); Claude is started with BROWSER set to a no-op and its address is read from its output
   * (the page shows a code to paste, see submitSignInCode). The address and code are kept for the account's card
   * (signInPrompt). mode 'window' also hands the address to `openUrl` (the app's own private window); 'code' only
   * shows it. Up to 10 minutes.
   */
  login(cli: CliId, openUrl: (url: string) => void, account?: string, options: { mode?: 'window' | 'code' } = {}): Promise<{ ok: boolean; message: string }> {
    const program = this.engine(cli)
    const name = cli === 'claude' ? 'Claude' : 'ChatGPT'
    if (program === null) return Promise.resolve({ ok: false, message: `The ${name} sign-in is not available in this build.` })
    const entry = this.entry(cli, account)
    const key = account ?? ''
    this.cancelSignIn(key)
    // A fresh home signs in as whoever completes the page, never as the computer's login: the engine is given only
    // this account's folder, so there is nothing else for it to find.
    const env: Record<string, string | undefined> = { ...engineHomeEnv(entry), ELECTRON_RUN_AS_NODE: undefined }
    if (cli === 'claude') env['BROWSER'] = this.noBrowser()
    return new Promise((resolve) => {
      const child = spawn(program, cli === 'claude' ? ['auth', 'login'] : ['login', '--device-auth'], {
        cwd: this.workDir,
        env,
        windowsHide: true,
        stdio: [cli === 'claude' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      const prompt: SignInPrompt = { url: '', code: '', needsPaste: cli === 'claude' }
      this.signIns.set(key, { prompt, child })
      let opened = false
      let output = ''
      const scan = (chunk: Buffer): void => {
        // The engines colour their output; the address and code are read from the plain text.
        const text = chunk.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '')
        if (output.length < 8000) output += text
        for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
          const url = match[0].replace(/[).,]+$/, '')
          if (prompt.url === '' && /claude\.(ai|com)|anthropic\.com|openai\.com|chatgpt\.com/.test(url)) prompt.url = url
        }
        if (cli === 'codex' && prompt.code === '') {
          const code = text.replace(/https:\/\/[^\s]+/g, '').match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/)
          if (code?.[1] !== undefined) prompt.code = code[1]
        }
        if (!opened && prompt.url !== '' && options.mode === 'window' && (cli === 'claude' || prompt.code !== '')) {
          opened = true
          openUrl(prompt.url)
        }
      }
      child.stdout?.on('data', scan)
      child.stderr?.on('data', scan)
      const finish = (result: { ok: boolean; message: string }): void => {
        clearTimeout(timer)
        if (this.signIns.get(key)?.child === child) this.signIns.delete(key)
        resolve(result)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, message: 'The sign-in took too long. Try again.' })
      }, 10 * 60 * 1000)
      child.once('error', (error) => finish({ ok: false, message: `Could not start the ${name} sign-in: ${error.message}` }))
      child.once('close', (code) => {
        if (code === 0) {
          const who = identityOf(entry)
          finish({ ok: true, message: who.email === '' ? `Signed in to ${name}.` : `Signed in to ${name} as ${who.email}${who.plan === '' ? '' : ` (${who.plan})`}.` })
        } else finish({ ok: false, message: output.trim().split('\n').pop()?.slice(0, 200) || `The ${name} sign-in did not finish.` })
      })
    })
  }

  /** What the plan offers right now, from the engine itself. */
  async models(cli: CliId, account?: string): Promise<PlanModel[]> {
    const dir = join(this.workDir, cli, 'models')
    mkdirSync(dir, { recursive: true })
    return planModels(cli, this.engine(cli), dir, this.entry(cli, account))
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

  /** True while an account is known to be at its limit (its plan said so, or a turn stopped on it, and the reset is not here). */
  limited(account: string | undefined, now = Date.now()): boolean {
    if (account === undefined) return false
    const until = this.usage.get(account)?.limitedUntil ?? 0
    return until > now
  }

  private noteRan(request: CliTurnRequest, account: string | undefined, failedOverFrom?: string): void {
    const ran: AccountRan = {
      at: Date.now(),
      cli: request.cli,
      thread: request.thread,
      account: account ?? '',
      ...(failedOverFrom === undefined ? {} : { failedOverFrom }),
    }
    try {
      appendFileSync(this.runLog, `${new Date(ran.at).toISOString()} ${ran.cli} ${ran.thread} account=${ran.account === '' ? 'shared' : ran.account}${failedOverFrom === undefined ? '' : ` failover-from=${failedOverFrom}`}\n`)
    } catch {
      // The log is a courtesy.
    }
    this.onRan?.(ran)
  }

  /**
   * One turn on the account the request names, and when that account hits its plan's limit, the same turn again on
   * the next signed-in account of the same kind from request.failover (each with its own sign-in home and its own
   * session; the new one starts from the full brief). Every run is logged with the account it used.
   */
  async turn(request: CliTurnRequest): Promise<{ text: string; error?: string }> {
    this.noteRan(request, request.accountId)
    let result = await this.turnOn(request)
    let from = request.accountId
    for (const next of request.failover ?? []) {
      if (!isLimitFailure(result.error) || request.signal.aborted) break
      if (next === from || !this.signedIn(request.cli, next) || this.limited(next)) continue
      this.noteRan(request, next, from)
      result = await this.turnOn({ ...request, accountId: next })
      from = next
    }
    return result
  }

  private async turnOn(request: CliTurnRequest): Promise<{ text: string; error?: string }> {
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
      const entry = this.entry(request.cli, request.accountId)
      // The computer's own login keeps the old key, so its conversations carry on; every other account has its own.
      const key = entry.shared ? `${request.cli}:${request.thread}` : `${request.cli}:${request.accountId ?? ''}:${request.thread}`
      const stored = continues ? (this.sessions()[key] ?? null) : null
      const stale = stored !== null && this.sessions()[`${key}#rev`] !== String(PROMPT_REVISION)
      const permission = sdkPermission({
        settings,
        approve: (summary, details, origin) => request.context.approve(summary, details, 'computer', origin as { tool: string; input: Record<string, never> } | undefined),
        alsoAllowed: [dir],
      })
      const messages = request.messages
      const run = (sessionId: string | null) =>
        runCliTurn({
          cli: request.cli,
          program: this.engine(request.cli),
          home: entry,
          onUsage: (window: AiUsageWindow, rejected: boolean) => this.heard(request.accountId, window, rejected),
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
          access: engineAccess(settings().shell),
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
      // A turn that ends on a dead login settles it for this computer at once; one that ran proves it works.
      if (isSignInFailure(result.error)) this.refuse(request.cli, request.accountId)
      else if (result.error === undefined) this.accept(request.cli, request.accountId)
      if (isLimitFailure(result.error) && request.accountId !== undefined && !this.limited(request.accountId)) {
        const reset = request.cli === 'codex' ? codexUsage(entry.dir).windows.find((window) => window.usedPercent >= 100)?.resetsAt ?? null : null
        this.usage.set(request.accountId, { limitedUntil: reset !== null && reset > Date.now() ? reset : Date.now() + LIMIT_PAUSE_MS })
      }
      return result.error === undefined ? { text: result.text } : { text: result.text, error: result.error }
    } finally {
      server.release(token)
    }
  }

  /** Who an account is signed in as, read from its own sign-in home (no token leaves this). */
  identity(cli: CliId, account?: string): { signedIn: boolean; email: string; plan: string } {
    return identityOf(this.entry(cli, account))
  }

  /** An account was removed: its own sign-in home and usage go (never the computer's shared login). */
  forgetAccount(account: string): void {
    this.homes.forget(account)
    this.usage.forget(account)
  }

  /** A usage window the Claude engine reported during a turn: kept per account; a rejected one pauses it until the reset. */
  private heard(account: string | undefined, window: AiUsageWindow, rejected: boolean): void {
    if (account === undefined) return
    const kept = (this.usage.get(account)?.windows ?? []).filter((each) => each.label !== window.label)
    this.usage.set(account, {
      windows: [...kept, window],
      at: Date.now(),
      ...(rejected ? { limitedUntil: window.resetsAt !== null && window.resetsAt > Date.now() ? window.resetsAt : Date.now() + LIMIT_PAUSE_MS } : window.usedPercent < 100 ? { limitedUntil: 0 } : {}),
    })
  }

  /**
   * Who each plan account is signed in as, its plan and its usage. Labels and numbers only: the email and plan come from
   * the id token's public claims (Codex) and the engine's own config and status (Claude), never a token.
   */
  async status(accounts: AiAccount[]): Promise<AiAccountStatus[]> {
    const out: AiAccountStatus[] = []
    for (const account of accounts) {
      if (account.kind === 'api') continue
      const entry = this.entry(account.kind, account.id)
      const who = identityOf(entry)
      let email = who.email
      let plan = who.plan
      const signedIn = who.signedIn && this.signedIn(account.kind, account.id)
      if (account.kind === 'claude' && who.signedIn && (email === '' || plan === '')) {
        const said = await this.claudeStatusText(account.id)
        const more = identityFromStatus(said)
        email = email || more.email
        plan = plan || more.plan
      }
      let windows: AiUsageWindow[] = []
      let at = 0
      if (account.kind === 'codex') {
        const seen = codexUsage(entry.dir)
        windows = seen.windows
        at = seen.at
      }
      let kept = this.usage.get(account.id)
      if (account.kind === 'claude' && who.signedIn) {
        // Claude Code's own /usage numbers, asked at most every two minutes per account.
        if (kept === null || Date.now() - kept.at > 2 * 60_000) {
          const asked = await claudeUsageFromApi(entry.dir, this.fetchImpl)
          if (asked.length > 0) {
            this.usage.set(account.id, { windows: asked, at: Date.now() })
            kept = this.usage.get(account.id)
          }
        }
        if (kept !== null) {
          windows = kept.windows
          at = kept.at
        }
      }
      out.push({
        id: account.id,
        kind: account.kind,
        label: account.label,
        signedIn,
        email,
        plan,
        usage: windows,
        usageAt: at,
        limited: this.limited(account.id) || windows.some((window) => window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > Date.now())),
        sharedLogin: entry.shared,
        ...(this.signInPrompt(account.id) === null ? {} : { signIn: this.signInPrompt(account.id)! }),
      })
    }
    return out
  }

  private claudeStatusText(account: string): Promise<string> {
    const program = this.engine('claude')
    if (program === null) return Promise.resolve('')
    const env = { ...engineHomeEnv(this.entry('claude', account)), ELECTRON_RUN_AS_NODE: undefined }
    return new Promise((resolve) => {
      execFile(program, ['auth', 'status'], { timeout: 15_000, windowsHide: true, env }, (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`))
    })
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
