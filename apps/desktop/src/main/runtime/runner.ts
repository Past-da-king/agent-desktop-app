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
  msgToJson,
  repair,
  trimFit,
  userMsg,
  type AgentEvent,
  type Attachment,
  type ChatEvent,
  type Decision,
  type JsonObject,
  type LlmProvider,
  type Msg,
  type RunState,
  type Settings,
  type Tool,
  type ToolCallBlock,
  type ToolContext,
} from '@agent/core'

import type { DataStore } from './data'
import { buildSystemPrompt } from './prompt'

export interface SettingsView {
  get(): Settings
}

export interface SecretsView {
  get(name: string): string | null
}

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
  /** Pushes a ChatEvent to the renderer. */
  emit?: (event: ChatEvent) => void
  /** True while the app window has the person's attention. Defaults to true (no notifications in tests). */
  isFocused?: () => boolean
  now?: () => number
  /** Tests pin a zone; production uses the computer's own. */
  timeZone?: string
}

interface ActivityRow {
  id: string
  text: string
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
  private readonly emit: (event: ChatEvent) => void
  private readonly isFocused: () => boolean
  private readonly now: () => number
  private readonly timeZone: string | undefined

  private running = false
  private controller: AbortController | null = null
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
    this.emit = deps.emit ?? (() => undefined)
    this.isFocused = deps.isFocused ?? (() => true)
    this.now = deps.now ?? Date.now
    this.timeZone = deps.timeZone
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

  /** Answer a question card, now or after a restart. */
  async answer(itemId: string, answer: string): Promise<void> {
    const row = await this.store.get('chat_item', itemId)
    if (row === null || row.kind !== 'question') return
    const meta = parseMeta(row.meta)
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

  /** Approve or decline an approval card, now or after a restart. */
  async decide(itemId: string, decision: Decision): Promise<void> {
    const row = await this.store.get('chat_item', itemId)
    if (row === null || row.kind !== 'approval') return
    const meta = parseMeta(row.meta)
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
   * Startup repair. An activity left running by a crash becomes an error, and cards nobody answered
   * are re-armed so answering one still carries the conversation on.
   */
  async restore(): Promise<void> {
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
  }

  // ---- running a turn ---------------------------------------------------------------------

  private async begin(
    text: string,
    images: string[],
    user: { text: string; meta: string } | null,
  ): Promise<void> {
    this.running = true
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

  private async runTurn(
    text: string,
    images: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const current = this.settings.get()
    const key = (this.secrets.get('apiKey') ?? '').trim()

    if (current.mode === 'subscription') {
      await this.notice('Subscriptions are coming soon. Add an AI key in Settings to start.')
      return undefined
    }
    if (!current.hasKey || key === '') {
      await this.notice('Add an AI key in Settings to start')
      return undefined
    }
    const model =
      current.model.trim() || PROVIDERS.find((provider) => provider.id === current.provider)?.defaultModel || ''
    if (model === '') {
      await this.notice('Choose a model in Settings to start.')
      return undefined
    }
    if (current.provider === 'custom' && current.baseUrl.trim() === '') {
      await this.notice('Add the server address for this provider in Settings.')
      return undefined
    }

    let provider: LlmProvider | null = null
    try {
      provider = this.providerFactory(current, key)
    } catch {
      provider = null
    }
    if (provider === null) {
      await this.notice('Add an AI key in Settings to start')
      return undefined
    }

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
    const row = await this.store.upsert('chat_item', {
      kind: 'activity',
      text: summary,
      meta: JSON.stringify({ tool: call.name, status: 'running', summary }),
    })
    this.activities.set(call.id, { id: row.id, text: summary })
    this.emit({ type: 'chat_changed' })
  }

  private async finishActivity(call: ToolCallBlock, result: string, isError: boolean): Promise<void> {
    const activity = this.activities.get(call.id)
    this.activities.delete(call.id)
    const summary = isError ? clip(result.split('\n')[0] ?? result, MAX_RESULT_CHARS) : describeCall(call)
    const meta: JsonObject = { tool: call.name, status: isError ? 'error' : 'done', summary }
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
    const messages: Msg[] = []
    for (const row of rows) {
      if (row.thread !== 'main') continue
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

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      agentLabel: 'main',
      activity: async (text, meta) => {
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
      ask: (question, options) => this.ask(question, options, signal),
      approve: (summary, details) => this.approve(summary, details, signal),
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
    this.sendNotification('Your agent has a question', clip(question, MAX_NOTIFICATION_CHARS), true)
    return pending
  }

  private async approve(
    summary: string,
    details: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const row = await this.store.upsert('chat_item', {
      kind: 'approval',
      text: summary,
      meta: JSON.stringify({ summary, details: details ?? '', decision: '' }),
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
    this.sendNotification('Approve?', clip(summary, MAX_NOTIFICATION_CHARS), true)
    return pending
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
