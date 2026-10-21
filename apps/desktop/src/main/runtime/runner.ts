/**
 * The chat runner: one conversation, one main line (PLAN.md 5.1).
 *
 * It owns the turn rows (the model's own transcript), renders every step into chat rows the UI can
 * show, suspends tools on question and approval cards, and keeps going across a restart: an activity
 * left running becomes "Interrupted", and a card answered later starts a fresh turn with the answer.
 */
import {
  AgentLoop,
  PROVIDERS,
  ProviderException,
  msgFromJson,
  msgText,
  msgToJson,
  repair,
  trimFit,
  userMsg,
  type AgentEvent,
  type AgentProfileInfo,
  type Attachment,
  type ChatEvent,
  type Decision,
  type EnvironmentReport,
  type JsonObject,
  type LlmProvider,
  type Msg,
  type RunState,
  type Settings,
  type Tool,
  type ToolCallBlock,
  type ToolContext,
  type TriggerRow,
} from '@agent/core'

import type { DataStore } from './data'
import type { StepBudget } from './budget'
import type { HelperHost } from './helpers'
import type { CliHost } from './cli-host'
import { buildSystemPrompt } from './prompt'
import { quietTapNote } from './openui-prompt'
import { describeRun, runFinished, runStarted } from './run-detail'
import { redactSecrets } from '../logger'
import { latestDividerAt } from '../memory/chats'

export interface SettingsView {
  get(): Settings
}

export interface SecretsView {
  get(name: string): string | null
}

/** What a routine run hands back to the scheduler. */
export interface RoutineRunResult {
  /** The final text of the run, or the reason it could not start. */
  text: string
  /** True when the routine posted a question or approval card and stopped there. */
  waiting: boolean
}

export const WAITING_FOR_USER = 'Waiting for you'

/** Build the provider for the chosen settings, or null when nothing is set up yet. */
export type ProviderFactory = (settings: Settings, apiKey: string) => LlmProvider | null

export interface RunnerDeps {
  store: DataStore
  settings: SettingsView
  secrets: SecretsView
  providerFactory: ProviderFactory
  tools: Tool[]
  /** Shows an OS notification. The runner decides when it is wanted. */
  notify?: (title: string, body: string) => void
  /** The same, naming the card so a click on the notification can open it. */
  notifyCard?: (itemId: string, title: string, body: string) => void
  /** Pushes a ChatEvent to the renderer. */
  emit?: (event: ChatEvent) => void
  /** True while the app window has the person's attention. Defaults to true (no notifications in tests). */
  isFocused?: () => boolean
  now?: () => number
  /** Tests pin a zone; production uses the computer's own. */
  timeZone?: string
  /** Handing work to helpers (M10). */
  helpers?: HelperHost
  /** The main agent's action-step budget, shared by the tools built in toolset.ts. */
  budget?: StepBudget
  /** What is on this computer, from the cached scan. */
  environment?: () => EnvironmentReport | null
  /** Runs turns through an installed AI tool on the person's own plan (Claude Code). */
  cli?: CliHost
  /** Opens a web address in the person's own browser (sign-in pages). */
  openUrl?: (url: string) => void
  /** The person's profiles and learned app names, for the main agent's PROFILES section. */
  profiles?: () => { profiles: AgentProfileInfo[]; learnedNames: Record<string, string> }
}

interface ActivityRow {
  id: string
  text: string
  /** When the call started, for how long a run took. */
  started?: number
}

const MAX_RESULT_CHARS = 160
const MAX_NOTIFICATION_CHARS = 180

export class Runner {
  private readonly store: DataStore
  private readonly settings: SettingsView
  private readonly secrets: SecretsView
  private readonly providerFactory: ProviderFactory
  private readonly tools: Tool[]
  private readonly notify: (title: string, body: string) => void
  private readonly notifyCard: (itemId: string, title: string, body: string) => void
  private readonly emit: (event: ChatEvent) => void
  private readonly isFocused: () => boolean
  private readonly now: () => number
  private readonly timeZone: string | undefined
  private readonly helpers: HelperHost | undefined
  private readonly budget: StepBudget | undefined
  private readonly environment: () => EnvironmentReport | null
  private readonly cli: CliHost | undefined
  private readonly openUrl: (url: string) => void
  private readonly profilesView: RunnerDeps['profiles']

  private running = false
  private controller: AbortController | null = null
  private routineRunning = false
  private routineWaiting = false
  private routineController: AbortController | null = null
  private readonly steer: string[] = []
  private readonly askWaiters = new Map<string, (answer: string | null) => void>()
  private readonly decisionWaiters = new Map<string, (approved: boolean) => void>()
  private readonly waiting = new Set<string>()
  private readonly activities = new Map<string, ActivityRow>()
  private readonly activityIds = new Map<number, string>()
  private activitySeq = 0

  constructor(deps: RunnerDeps) {
    this.store = deps.store
    this.settings = deps.settings
    this.secrets = deps.secrets
    this.providerFactory = deps.providerFactory
    this.tools = deps.tools
    this.notify = deps.notify ?? (() => undefined)
    this.notifyCard =
      deps.notifyCard ?? ((_itemId, title, body) => this.notify(title, body))
    this.emit = deps.emit ?? (() => undefined)
    this.isFocused = deps.isFocused ?? (() => true)
    this.now = deps.now ?? Date.now
    this.timeZone = deps.timeZone
    this.helpers = deps.helpers
    this.budget = deps.budget
    this.cli = deps.cli
    this.openUrl = deps.openUrl ?? (() => undefined)
    this.profilesView = deps.profiles
    this.environment = deps.environment ?? (() => null)
  }

  // ---- the person's side ------------------------------------------------------------------

  /** Put a message in the chat. While a run is active it joins that run as a steering note. */
  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    const clean = text.trim()
    if (clean === '' && attachments.length === 0) return
    const meta = JSON.stringify({ attachments })
    const modelText = withAttachments(clean, attachments)
    const images = attachments
      .filter((attachment) => attachment.mime.toLowerCase().startsWith('image/'))
      .map((attachment) => attachment.path)

    if (this.running) {
      this.steer.push(modelText)
      await this.addUserItem(clean, meta)
      return
    }

    await this.begin(modelText, images, { text: clean, meta })
  }

  /** Stop the turn in flight. The run finishes with a "Stopped" notice. */
  stop(): void {
    this.steer.length = 0
    const controller = this.controller
    if (controller !== null) controller.abort()
  }

  state(): RunState {
    return { running: this.running, waiting: [...this.waiting] }
  }

  /**
   * A finished helper's result, as a new main turn. There is no user bubble: the note is the turn's
   * first message. While a turn is running it joins that run as a steering note instead.
   */
  async deliver(text: string): Promise<void> {
    const clean = text.trim()
    if (clean === '') return
    if (this.running) {
      this.steer.push(clean)
      this.emit({ type: 'chat_changed' })
      return
    }
    await this.begin(clean, [], null)
  }

  /** Answer a question card, now or after a restart. */
  async answer(itemId: string, answer: string): Promise<void> {
    const row = await this.store.get('chat_item', itemId)
    if (row === null || row.kind !== 'question') return
    const meta = parseMeta(row.meta)
    if (typeof meta['helper'] === 'string' && this.helpers?.answer !== undefined) {
      if (await this.helpers.answer(itemId, answer)) return
    }
    const answered = typeof meta['answer'] === 'string' && meta['answer'] !== ''
    const waiter = this.askWaiters.get(itemId)

    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...meta, answer }),
    })
    this.waiting.delete(itemId)
    this.emit({ type: 'chat_changed' })

    if (waiter !== undefined) {
      waiter(answer)
      return
    }
    if (answered) return
    await this.continueAfterCard(`The user answered your question "${row.text}" with: ${answer}`)
  }

  /**
   * The person chose Run without asking for this computer: every card still waiting on a command, code or a
   * file (the main agent's or a helper's) goes ahead too. Cards for anything sent or done elsewhere stay.
   */
  async approveComputerCards(): Promise<number> {
    const rows = await this.store.list('chat_item')
    let count = 0
    for (const row of rows) {
      if (row.kind !== 'approval') continue
      const meta = parseMeta(row.meta)
      if (meta['scope'] !== 'computer' || (typeof meta['decision'] === 'string' && meta['decision'] !== '')) continue
      await this.decide(row.id, 'approve')
      count += 1
    }
    return count
  }

  /** Approve or decline an approval card, now or after a restart. */
  async decide(itemId: string, decision: Decision): Promise<void> {
    const row = await this.store.get('chat_item', itemId)
    if (row === null || row.kind !== 'approval') return
    const meta = parseMeta(row.meta)
    if (typeof meta['helper'] === 'string' && this.helpers?.decide !== undefined) {
      if (await this.helpers.decide(itemId, decision)) return
    }
    const decided = typeof meta['decision'] === 'string' && meta['decision'] !== ''
    const waiter = this.decisionWaiters.get(itemId)
    const summary = typeof meta['summary'] === 'string' ? meta['summary'] : row.text

    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...meta, decision }),
    })
    this.waiting.delete(itemId)
    this.emit({ type: 'chat_changed' })

    if (waiter !== undefined) {
      waiter(decision === 'approve')
      return
    }
    if (decided) return
    const verb = decision === 'approve' ? 'approved' : 'declined'
    await this.continueAfterCard(`The user ${verb} your request: ${summary}`)
  }

  /**
   * A tap on a button the agent drew (OpenUI). It goes to the agent quietly: no bubble from the person, the model
   * is told it was a button tap, and the message remembers the tap so the button keeps saying Sent. As on the
   * phone (AgentRuntime.sendQuiet). While a run is active it joins that run as a steering note.
   */
  async tap(itemId: string, label: string, message: string): Promise<void> {
    const clean = message.trim()
    if (clean === '') return
    const row = await this.store.get('chat_item', itemId)
    if (row === null || row.kind !== 'agent') return
    const meta = parseMeta(row.meta)
    const taps = Array.isArray(meta['taps']) ? meta['taps'].filter((t): t is string => typeof t === 'string') : []
    if (!taps.includes(clean)) {
      await this.store.upsert('chat_item', {
        id: row.id,
        kind: row.kind,
        text: row.text,
        meta: JSON.stringify({ ...meta, taps: [...taps, clean].slice(-50) }),
      })
      this.emit({ type: 'chat_changed' })
    }
    const note = quietTapNote(label, clean)
    if (this.running) {
      this.steer.push(note)
      return
    }
    // A tap is the person acting, so it starts a fresh action budget like a typed message.
    this.budget?.reset()
    await this.begin(note, [], null)
  }

  /**
   * Startup repair. An activity left running by a crash becomes an error, and cards nobody answered
   * are re-armed so answering one still carries the conversation on.
   */
  async restore(): Promise<void> {
    await this.helpers?.restore?.()
    const items = await this.store.list('chat_item')
    let changed = false

    for (const item of items) {
      const meta = parseMeta(item.meta)

      if (item.kind === 'activity' && meta['status'] === 'running') {
        await this.store.upsert('chat_item', {
          id: item.id,
          kind: item.kind,
          text: item.text,
          meta: JSON.stringify({ ...meta, status: 'error', summary: 'Interrupted' }),
        })
        changed = true
      }

      if (item.kind === 'question' && !isSet(meta['answer'])) this.waiting.add(item.id)
      if (item.kind === 'approval' && !isSet(meta['decision'])) this.waiting.add(item.id)
    }

    if (changed) this.emit({ type: 'chat_changed' })
  }

  dispose(): void {
    this.stop()
    this.routineController?.abort()
  }

  // ---- routines ---------------------------------------------------------------------------

  /**
   * Run one routine in the background. It is a separate run from the main conversation: it does not
   * queue, steer or block what the person types, and it leaves no turn rows behind. If it needs the
   * person, it posts a question or approval card and ends with "Waiting for you".
   */
  async runRoutine(trigger: TriggerRow): Promise<RoutineRunResult> {
    if (this.routineRunning) return { text: 'Another routine is still running.', waiting: false }
    this.routineRunning = true
    this.routineWaiting = false
    try {
      return await this.runRoutineTurn(trigger)
    } finally {
      this.routineRunning = false
      this.routineWaiting = false
      this.routineController = null
    }
  }

  private async runRoutineTurn(trigger: TriggerRow): Promise<RoutineRunResult> {
    if (this.settings.get().mode === 'subscription') return this.runCliRoutine(trigger)
    const resolved = this.resolveModel()
    if (!resolved.ok) return { text: resolved.message, waiting: false }

    try {
      const memories = await this.store.list('memory')
      const goals = await this.store.list('goal')
      const tasks = await this.store.list('task')
      const first = userMsg(trigger.prompt)
      const history: Msg[] = [first]
      const system = buildSystemPrompt({
        settings: resolved.current,
        now: new Date(this.now()),
        platform: process.platform,
        memories,
        goals,
        tasks,
        latestUserText: trigger.prompt,
        role: 'routine',
        routineName: trigger.name,
        environment: this.environment(),
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
      })

      const controller = new AbortController()
      this.routineController = controller
      const context = this.toolContext(controller.signal, 'routine')
      const loop = new AgentLoop({ provider: resolved.provider, model: resolved.model, tools: this.tools })
      const text = await loop.run(system, history, context, { signal: controller.signal })

      if (this.routineWaiting) return { text: WAITING_FOR_USER, waiting: true }
      const summary = text.trim()
      return {
        text: summary === '' ? 'The routine finished without a summary.' : summary,
        waiting: false,
      }
    } catch (error) {
      return { text: friendlyError(error), waiting: false }
    }
  }

  // ---- running a turn ---------------------------------------------------------------------

  private async begin(
    text: string,
    images: string[],
    user: { text: string; meta: string } | null,
  ): Promise<void> {
    this.running = true
    // A message the person sent starts a fresh action budget. A helper's result does not.
    if (user !== null) this.budget?.reset()
    const controller = new AbortController()
    this.controller = controller
    this.emit({ type: 'run_started' })

    let error: string | undefined
    try {
      if (user !== null) await this.addUserItem(user.text, user.meta)
      error = await this.drive(text, images, controller.signal)
    } finally {
      if (this.controller === controller) this.controller = null
      this.running = false
      this.emit(error === undefined ? { type: 'run_finished' } : { type: 'run_finished', error })
      // A note that landed in the last instant of the run still deserves an answer.
      const leftover = this.steer.splice(0)
      if (!controller.signal.aborted && leftover.length > 0) {
        void this.begin(leftover.join('\n\n'), [], null)
      }
    }
  }

  private async continueAfterCard(prompt: string): Promise<void> {
    if (this.running) {
      this.steer.push(prompt)
      this.emit({ type: 'chat_changed' })
      return
    }
    await this.begin(prompt, [], null)
  }

  private async drive(
    first: string,
    images: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let text = first
    let pendingImages = images
    let error: string | undefined

    for (;;) {
      error = await this.runTurn(text, pendingImages, signal)
      if (signal.aborted) break
      const queued = this.steer.splice(0)
      if (queued.length === 0) break
      text = queued.join('\n\n')
      pendingImages = []
    }
    return error
  }

  private resolveModel():
    | { ok: true; provider: LlmProvider; model: string; current: Settings }
    | { ok: false; message: string } {
    const current = this.settings.get()
    const key = (this.secrets.get('apiKey') ?? '').trim()

    if (current.mode === 'subscription') {
      return {
        ok: false,
        message: 'Subscriptions are coming soon. Add an AI key in Settings to start.',
      }
    }
    if (!current.hasKey || key === '') {
      return { ok: false, message: 'Add an AI key in Settings to start' }
    }
    const model =
      current.model.trim() || PROVIDERS.find((provider) => provider.id === current.provider)?.defaultModel || ''
    if (model === '') return { ok: false, message: 'Choose a model in Settings to start.' }
    if (current.provider === 'custom' && current.baseUrl.trim() === '') {
      return { ok: false, message: 'Add the server address for this provider in Settings.' }
    }

    let provider: LlmProvider | null = null
    try {
      provider = this.providerFactory(current, key)
    } catch {
      provider = null
    }
    if (provider === null) return { ok: false, message: 'Add an AI key in Settings to start' }
    return { ok: true, provider, model, current }
  }

  private async runTurn(
    text: string,
    images: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (this.settings.get().mode === 'subscription') return this.runCliTurn(text, images, signal)
    const resolved = this.resolveModel()
    if (!resolved.ok) {
      await this.notice(resolved.message)
      return undefined
    }
    const { provider, model, current } = resolved

    const memories = await this.store.list('memory')
    const goals = await this.store.list('goal')
    const tasks = await this.store.list('task')
    const history = await this.loadHistory()
    const first = userMsg(text, images)
    history.push(first)
    await this.appendTurn(first)

    const system = buildSystemPrompt({
      settings: current,
      now: new Date(this.now()),
      platform: process.platform,
      memories,
      goals,
      tasks,
      latestUserText: text,
      role: 'main',
      helperModel: model,
      liveHelpers: this.helpers?.live() ?? [],
      ...this.profilePrompt(),
      environment: this.environment(),
      ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
    })
    const context = this.toolContext(signal)
    const loop = new AgentLoop({ provider, model, tools: this.tools })

    try {
      await loop.run(system, history, context, {
        onEvent: (event) => this.render(event),
        onAppend: (message) => this.appendTurn(message),
        incoming: () => this.steer.splice(0),
        signal,
      })
      if (signal.aborted) await this.notice('Stopped')
      return undefined
    } catch (error) {
      if (signal.aborted) {
        await this.notice('Stopped')
        return undefined
      }
      const message = friendlyError(error)
      await this.notice(message)
      return message
    }
  }

  // ---- running on an installed AI tool (the person's own plan) ---------------------------------

  /** The PROFILES section's input for the main agent, or nothing when there are no profiles. */
  private profilePrompt(): { profiles?: AgentProfileInfo[]; learnedNames?: Record<string, string> } {
    if (this.profilesView === undefined) return {}
    try {
      return this.profilesView()
    } catch {
      return {}
    }
  }

  private async cliSystem(text: string, role: 'main' | 'routine', routineName?: string): Promise<string> {
    const current = this.settings.get()
    return buildSystemPrompt({
      settings: current,
      now: new Date(this.now()),
      platform: process.platform,
      memories: await this.store.list('memory'),
      goals: await this.store.list('goal'),
      tasks: await this.store.list('task'),
      latestUserText: text,
      role,
      ...(routineName === undefined ? {} : { routineName }),
      helperModel: current.cli === 'codex' ? 'Codex' : 'Claude',
      liveHelpers: this.helpers?.live() ?? [],
      ...this.profilePrompt(),
      canDelegate: this.helpers !== undefined,
      environment: this.environment(),
      ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
    })
  }

  private async runCliTurn(text: string, images: string[], signal: AbortSignal): Promise<string | undefined> {
    if (this.cli === undefined) {
      await this.notice('This build cannot run on a subscription. Add an AI key in Settings to start.')
      return undefined
    }
    const current = this.settings.get()
    this.emit({ type: 'thinking', step: 1 })
    const result = await this.cli.turn({
      cli: current.cli === '' ? 'claude' : current.cli,
      thread: 'main',
      tools: this.tools,
      system: await this.cliSystem(text, 'main'),
      prompt: text,
      images,
      ...(current.cliModel.trim() === '' ? {} : { model: current.cliModel.trim() }),
      context: this.toolContext(signal),
      signal,
      onEvent: (event) => this.render(event),
      onCall: (call) => this.startActivity({ t: 'call', id: call.id, name: call.name, input: call.input }),
      onResult: (call, result, isError) =>
        this.finishActivity({ t: 'call', id: call.id, name: call.name, input: call.input }, result, isError),
    })
    if (signal.aborted) {
      await this.notice('Stopped')
      return undefined
    }
    if (result.error !== undefined) {
      await this.notice(result.error)
      return result.error
    }
    return undefined
  }

  private async runCliRoutine(trigger: TriggerRow): Promise<RoutineRunResult> {
    if (this.cli === undefined) return { text: 'This build cannot run routines on a subscription.', waiting: false }
    const current = this.settings.get()
    const controller = new AbortController()
    this.routineController = controller
    const result = await this.cli.turn({
      cli: current.cli === '' ? 'claude' : current.cli,
      thread: 'routine',
      tools: this.tools,
      system: await this.cliSystem(trigger.prompt, 'routine', trigger.name),
      prompt: trigger.prompt,
      ...(current.cliModel.trim() === '' ? {} : { model: current.cliModel.trim() }),
      context: this.toolContext(controller.signal, 'routine'),
      signal: controller.signal,
      onEvent: async () => undefined,
      onCall: async () => undefined,
      onResult: async () => undefined,
    })
    if (this.routineWaiting) return { text: WAITING_FOR_USER, waiting: true }
    if (result.error !== undefined) return { text: result.error, waiting: false }
    const summary = result.text.trim()
    return { text: summary === '' ? 'The routine finished without a summary.' : summary, waiting: false }
  }

  /**
   * One plain model call with no tools, on whatever the person runs (their API key or their plan). Used to file a
   * chat into memory and for the end-of-day pass. Throws with a plain message when it cannot answer.
   */
  async oneShot(system: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const current = this.settings.get()
    if (current.mode === 'subscription') {
      if (this.cli === undefined) throw new Error('This build cannot run on a subscription.')
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      signal?.addEventListener('abort', abort)
      const timer = setTimeout(abort, 300_000)
      try {
        const result = await this.cli.turn({
          cli: current.cli === '' ? 'claude' : current.cli,
          thread: 'routine',
          tools: [],
          system,
          prompt,
          ...(current.cliModel.trim() === '' ? {} : { model: current.cliModel.trim() }),
          context: this.toolContext(controller.signal, 'routine'),
          signal: controller.signal,
          onEvent: async () => undefined,
          onCall: async () => undefined,
          onResult: async () => undefined,
        })
        if (controller.signal.aborted) throw new Error('The model took too long to answer.')
        if (result.error !== undefined) throw new Error(result.error)
        return result.text
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
    const resolved = this.resolveModel()
    if (!resolved.ok) throw new Error(resolved.message)
    try {
      const completion = await resolved.provider.complete(system, [userMsg(prompt)], [], resolved.model, 4096)
      return msgText(completion.message)
    } catch (error) {
      throw new Error(friendlyError(error))
    }
  }

  /** The chosen plan's own sign-in, then the same tiny check. */
  async planModels(): Promise<Array<{ id: string; label: string; line: string }>> {
    if (this.cli === undefined) return []
    const current = this.settings.get()
    return this.cli.models(current.cli === 'codex' ? 'codex' : 'claude')
  }

  async cliLogin(): Promise<{ ok: boolean; message: string }> {
    if (this.cli === undefined) return { ok: false, message: 'This build cannot run on a subscription.' }
    const chosen = this.settings.get().cli
    const signedIn = await this.cli.login(chosen === '' ? 'claude' : chosen, (url) => this.openUrl(url))
    if (!signedIn.ok) return signedIn
    return this.checkCli()
  }

  /** One tiny real turn, so onboarding and Settings can say whether the person's plan works here. */
  async checkCli(): Promise<{ ok: boolean; message: string }> {
    if (this.cli === undefined) return { ok: false, message: 'This build cannot run on a subscription.' }
    const chosen = this.settings.get().cli
    const cli = chosen === '' ? 'claude' : chosen
    const name = cli === 'claude' ? 'Claude' : 'Codex'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const result = await this.cli.turn({
        cli,
        thread: 'routine',
        tools: [],
        system: 'Reply with exactly the word OK and nothing else.',
        prompt: 'Reply with exactly the word OK.',
        context: this.toolContext(controller.signal, 'routine'),
        signal: controller.signal,
        onEvent: async () => undefined,
        onCall: async () => undefined,
        onResult: async () => undefined,
      })
      if (controller.signal.aborted) return { ok: false, message: `${name} took too long to answer. Try again.` }
      if (result.error !== undefined) return { ok: false, message: result.error }
      return { ok: true, message: `${name} is signed in and working on your plan.` }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- rendering into chat rows -----------------------------------------------------------

  private async render(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'thinking':
        this.emit({ type: 'thinking', step: event.step })
        return
      case 'said':
        await this.store.upsert('chat_item', { kind: 'agent', text: event.text, meta: '{}' })
        this.emit({ type: 'chat_changed' })
        return
      case 'tool_started':
        await this.startActivity(event.call)
        return
      case 'tool_finished':
        await this.finishActivity(event.call, event.result, event.isError)
        return
    }
  }

  private async startActivity(call: ToolCallBlock): Promise<void> {
    const summary = describeCall(call)
    // What it is running, so the row shows the command while it works.
    const run = runStarted(call)
    const row = await this.store.upsert('chat_item', {
      kind: 'activity',
      text: summary,
      meta: JSON.stringify({ tool: call.name, status: 'running', summary, ...(run === null ? {} : { run }) }),
    })
    this.activities.set(call.id, { id: row.id, text: summary, started: Date.now() })
    this.emit({ type: 'chat_changed' })
  }

  private async finishActivity(call: ToolCallBlock, result: string, isError: boolean): Promise<void> {
    const activity = this.activities.get(call.id)
    this.activities.delete(call.id)
    // An error line can quote the command or its output, so it is redacted like the run record.
    const summary = isError ? clip(redactSecrets(result.split('\n')[0] ?? result), MAX_RESULT_CHARS) : describeCall(call)
    const meta: JsonObject = { tool: call.name, status: isError ? 'error' : 'done', summary }
    const run = runFinished(call, result, isError, activity?.started ?? Date.now())
    if (run !== null) meta['run'] = run as unknown as JsonObject
    const text = isError ? `${activity?.text ?? describeCall(call)} failed` : activity?.text ?? summary

    if (activity !== undefined) {
      await this.store.upsert('chat_item', {
        id: activity.id,
        kind: 'activity',
        text,
        meta: JSON.stringify(meta),
      })
    } else {
      await this.store.upsert('chat_item', { kind: 'activity', text, meta: JSON.stringify(meta) })
    }
    this.emit({ type: 'chat_changed' })
  }

  private async notice(text: string): Promise<void> {
    await this.store.upsert('chat_item', { kind: 'notice', text, meta: '{}' })
    this.emit({ type: 'chat_changed' })
  }

  private async addUserItem(text: string, meta: string): Promise<void> {
    await this.store.upsert('chat_item', { kind: 'user', text, meta })
    this.emit({ type: 'chat_changed' })
  }

  private async appendTurn(message: Msg): Promise<void> {
    if (this.controller?.signal.aborted === true) return
    await this.store.upsert('turn', { thread: 'main', json: JSON.stringify(msgToJson(message)) })
  }

  private async loadHistory(): Promise<Msg[]> {
    const rows = await this.store.list('turn')
    // New Chat takes everything before the newest divider out of context. Nothing is deleted: the agent can still
    // find it with chats_search.
    const since = latestDividerAt(await this.store.list('chat_item'))
    const messages: Msg[] = []
    for (const row of rows) {
      if (row.thread !== 'main') continue
      if (since > 0 && row.createdAt <= since) continue
      try {
        messages.push(msgFromJson(JSON.parse(row.json) as unknown))
      } catch {
        // A half-written row from an older version must not block the whole conversation.
      }
    }
    // Never start mid tool-exchange: the first message the model sees must be the user's.
    while (messages.length > 0) {
      const first = messages[0]
      if (first !== undefined && first.role === 'USER' && first.blocks.some((block) => block.t === 'text')) break
      messages.shift()
    }
    const fixed = repair(messages)
    trimFit(fixed)
    return fixed
  }

  // ---- questions and approvals ------------------------------------------------------------

  private toolContext(signal: AbortSignal, role: 'main' | 'routine' = 'main'): ToolContext {
    return {
      agentLabel: role === 'routine' ? 'routine' : 'main',
      owner: role,
      activity: async (text, meta) => {
        if (role === 'routine') return ++this.activitySeq
        const id = ++this.activitySeq
        const row = await this.store.upsert('chat_item', {
          kind: 'activity',
          text,
          meta: JSON.stringify({ ...(meta ?? {}), status: 'running' }),
        })
        this.activityIds.set(id, row.id)
        this.emit({ type: 'chat_changed' })
        return id
      },
      updateActivity: async (id, text, meta) => {
        if (role === 'routine') return
        const cid = this.activityIds.get(id)
        if (cid === undefined) return
        await this.store.upsert('chat_item', {
          id: cid,
          kind: 'activity',
          text,
          meta: JSON.stringify({ ...(meta ?? {}), status: 'done' }),
        })
        this.emit({ type: 'chat_changed' })
      },
      ask: (question, options) =>
        role === 'routine' ? this.askInRoutine(question, options) : this.ask(question, options, signal),
      approve: (summary, details, scope) =>
        role === 'routine' ? this.approveInRoutine(summary, details) : this.approve(summary, details, signal, scope),
      notify: async (title, body) => this.sendNotification(title, body, false),
      signal,
    }
  }

  private async ask(question: string, options: string[], signal: AbortSignal): Promise<string | null> {
    const row = await this.store.upsert('chat_item', {
      kind: 'question',
      text: question,
      meta: JSON.stringify({ options, answer: '' }),
    })
    // Register the waiter before telling the UI: the person may answer the moment the card appears.
    const pending = new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (answer: string | null): void => {
        if (settled) return
        settled = true
        this.askWaiters.delete(row.id)
        signal.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = (): void => finish(null)
      if (signal.aborted) {
        finish(null)
        return
      }
      this.askWaiters.set(row.id, finish)
      signal.addEventListener('abort', onAbort, { once: true })
    })

    this.waiting.add(row.id)
    this.emit({ type: 'chat_changed' })
    this.emit({ type: 'needs_you', itemId: row.id })
    this.sendCardNotification(row.id, 'Your agent has a question', clip(question, MAX_NOTIFICATION_CHARS))
    return pending
  }

  /** Post the card and stop the routine there; nobody is at the desk to answer mid-run. */
  private async askInRoutine(question: string, options: string[]): Promise<string | null> {
    const row = await this.store.upsert('chat_item', {
      kind: 'question',
      text: question,
      meta: JSON.stringify({ options, answer: '' }),
    })
    this.routineWaiting = true
    this.waiting.add(row.id)
    this.emit({ type: 'chat_changed' })
    this.emit({ type: 'needs_you', itemId: row.id })
    this.sendCardNotification(row.id, 'Your agent has a question', clip(question, MAX_NOTIFICATION_CHARS))
    this.routineController?.abort()
    return null
  }

  private async approve(
    summary: string,
    details: string | undefined,
    signal: AbortSignal,
    scope?: 'computer',
  ): Promise<boolean> {
    const row = await this.store.upsert('chat_item', {
      kind: 'approval',
      text: summary,
      meta: JSON.stringify({ summary, details: details ?? '', decision: '', ...(scope === undefined ? {} : { scope }) }),
    })
    // Register the waiter before telling the UI, so an instant decision finds it.
    const pending = new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (approved: boolean): void => {
        if (settled) return
        settled = true
        this.decisionWaiters.delete(row.id)
        signal.removeEventListener('abort', onAbort)
        resolve(approved)
      }
      const onAbort = (): void => finish(false)
      if (signal.aborted) {
        finish(false)
        return
      }
      this.decisionWaiters.set(row.id, finish)
      signal.addEventListener('abort', onAbort, { once: true })
    })

    this.waiting.add(row.id)
    this.emit({ type: 'chat_changed' })
    this.emit({ type: 'needs_you', itemId: row.id })
    this.sendCardNotification(row.id, 'Approve?', clip(summary, MAX_NOTIFICATION_CHARS))
    return pending
  }

  /** Post the approval card and stop the routine there; it never decides for the person. */
  private async approveInRoutine(summary: string, details: string | undefined): Promise<boolean> {
    const row = await this.store.upsert('chat_item', {
      kind: 'approval',
      text: summary,
      meta: JSON.stringify({ summary, details: details ?? '', decision: '' }),
    })
    this.routineWaiting = true
    this.waiting.add(row.id)
    this.emit({ type: 'chat_changed' })
    this.emit({ type: 'needs_you', itemId: row.id })
    this.sendCardNotification(row.id, 'Approve?', clip(summary, MAX_NOTIFICATION_CHARS))
    this.routineController?.abort()
    return false
  }

  private sendNotification(title: string, body: string, onlyWhenUnfocused: boolean): void {
    if (!this.settings.get().notifications) return
    if (onlyWhenUnfocused && this.isFocused()) return
    try {
      this.notify(title, body)
    } catch {
      // A notification failing must never take a run down with it.
    }
  }

  /** A card notification carries its id, so clicking it can open the card. */
  private sendCardNotification(itemId: string, title: string, body: string): void {
    if (!this.settings.get().notifications) return
    if (this.isFocused()) return
    try {
      this.notifyCard(itemId, title, body)
    } catch {
      // A notification failing must never take a run down with it.
    }
  }
}

/** Plain words for the chat when a provider call fails. Ported from friendlyError in AgentRuntime.kt. */
export function friendlyError(error: unknown): string {
  if (error instanceof ProviderException) {
    if (error.status === 401) return 'Your API key was rejected. Check it in Settings.'
    if (error.status === 429) {
      return 'The AI provider says we are sending too much right now (rate limit or out of credit). Try again shortly.'
    }
    if (error.status === 0) return 'I could not reach the AI provider. Check your connection.'
    if (error.status === 400 && /image/i.test(error.message)) {
      return "This model can't look at images. Pick a vision model in Settings, or send it as text."
    }
    return `Something went wrong: ${clip(error.message, 240)}`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `Something went wrong: ${clip(message, 240)}`
}

/** What the activity row says while a tool runs. Kept in one switch so every row reads the same. */
export function describeCall(call: ToolCallBlock): string {
  // Commands, code and files: what was run, with any secret in it redacted.
  const run = describeRun(call)
  if (run !== null) return run
  const input = call.input
  const title = stringField(input['title']) || stringField(input['summary'])
  switch (call.name) {
    case 'now':
      return 'Checked the time'
    case 'memory_search': {
      const query = stringField(input['query'])
      return query === '' ? 'Searched memory' : `Searched memory for "${clip(query, 80)}"`
    }
    case 'memory_get':
      return 'Read a memory page'
    case 'memory_save':
      return title === '' ? 'Updated memory' : `Remembered: ${clip(title, 80)}`
    case 'memory_update':
      return 'Updated memory'
    case 'chats_search': {
      const query = stringField(input['query'])
      return query === '' ? 'Searched earlier chats' : `Searched earlier chats for "${clip(query, 80)}"`
    }
    case 'chat_read':
      return 'Read an earlier chat'
    case 'task_add':
      return title === '' ? 'Added a task' : `Added a task: ${clip(title, 80)}`
    case 'task_list':
      return 'Checked tasks'
    case 'task_update':
      return 'Updated a task'
    case 'goal_create':
      return title === '' ? 'Started a goal' : `New goal: ${clip(title, 80)}`
    case 'ask_user':
      return 'Waiting for you'
    case 'request_approval':
      return 'Waiting for your approval'
    case 'notify_user':
      return 'Sent a notification'
    case 'web_fetch':
      return `Read ${hostOf(stringField(input['url']))}`
    case 'report':
      return title === '' ? 'Wrote a report' : `Wrote a report: ${clip(title, 80)}`
    case 'routine_create':
      return title === '' ? 'Created a routine' : `New routine: ${clip(title, 80)}`
    case 'routine_list':
      return 'Checked routines'
    case 'routine_delete':
      return 'Deleted a routine'
    default:
      return call.name.replace(/_/g, ' ')
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || 'a page'
  } catch {
    return 'a page'
  }
}

function withAttachments(text: string, attachments: Attachment[]): string {
  const rest = attachments.filter((attachment) => !attachment.mime.toLowerCase().startsWith('image/'))
  if (rest.length === 0) return text
  const list = rest.map((attachment) => `- ${attachment.name} (${attachment.path})`).join('\n')
  return `${text === '' ? 'I attached some files.' : text}\n\nAttached files:\n${list}`
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function isSet(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}
