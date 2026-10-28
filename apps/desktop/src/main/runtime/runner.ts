/**
 * The chat runner: one conversation, one main line (PLAN.md 5.1).
 *
 * It owns the turn rows (the model's own transcript), renders every step into chat rows the UI can
 * show, suspends tools on question and approval cards, and keeps going across a restart: an activity
 * left running becomes "Interrupted", and a card answered later starts a fresh turn with the answer.
 */
import {
  AgentLoop,
  MAIN_CHAT,
  NoteBell,
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
  type ChatItem,
  type ChatRunInfo,
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
  accountById,
  defaultGoodFor,
  pickModel,
  rosterName,
  type ChatBrain,
} from '@agent/core'

import { listWhere, type DataStore } from './data'
import { liveRuns } from './live-runs'
import type { StepBudget } from './budget'
import { chatBrainOf, isBrain, mainBrain, pickBrain, rosterFor, type Brain, type BrainDeps, type BrainLocks } from './brains'
import type { HelperHost } from './helpers'
import type { CliHost } from './cli-host'
import { projectFolderOf } from './work-folder'
import { buildSystemPrompt, type ProjectContext } from './prompt'
import type { CliId } from './cli-agent'
import { quietTapNote } from './openui-prompt'
import { prepareMessage, type PreparedMessage } from './attachment-text'
import { branchChat, chatOf, chatTag, handoffText, threadFor } from './chat-lines'
import {
  CLASSIFIER_SYSTEM,
  alongsideBrief,
  classifierPrompt,
  decideRoute,
  joinNote,
  parseVerdict,
  type Classifier,
} from './chat-route'
import { describeRun, finishRun, runStarted } from './run-detail'
import { viaLabel, type ChatVia } from '../tools/projects'
import { redactSecrets } from '../logger'
import { latestDividerAt } from '../memory/chats'
import type { MessageOrigin } from '../devices/types'
import type { LeaseHook } from './turns'
import { MAIN_IDLE_MS, runEnded } from '../browser/run-tabs'
import { promptRulesFor } from './prompt-rules'
import { isInterruptible } from './read-only'
import { withNoteTools } from './note-tools'

/** The browser owner of a main-agent run: the main thread, a chat of its own, or the routine run. */
export function browserOwnerOf(role: 'main' | 'routine', chat: string): string {
  return role === 'routine' ? 'routine' : chat === MAIN_CHAT ? 'main' : `chat:${chat}`
}

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
  /** True when it was stopped (its card's X, helper_stop, the routine switched off). */
  stopped?: boolean
  /** True when the routine posted a question or approval card and stopped there. */
  waiting: boolean
  /** True when the run itself failed (no brain, an error), not when it ran and reported a problem. */
  failed?: boolean
}

/**
 * A routine run's card in the main chat (28 Oct 2026: a routine ran with nothing on screen, so he could not see it
 * working). A `helper` row, so the sidebar, the helpers view and a phone show it like any helper: its name, its live
 * step, its result. One row per routine (`rt-<trigger id>`), opened again by each run. It carries `routine` so the
 * helper service never takes it for a helper run of its own.
 */
export const routineCardId = (triggerId: string): string => `rt-${triggerId}`

/** How often a routine's card is rewritten with the step it is on (each write is a row a phone may pull). */
const ROUTINE_STEP_MS = 1_500

/** A step left running, as its meta reads inside the stored row (meta is JSON text in the row's JSON). */
const RUNNING_IN_META = '\\"status\\":\\"running\\"'
/** How far back the start-up repair reads every step, whatever its meta looks like. */
const RECENT_STEPS_MS = 2 * 24 * 60 * 60 * 1000

export const WAITING_FOR_USER = 'Waiting for you'

/** Build the provider for the chosen settings, or null when nothing is set up yet. */
export type ProviderFactory = (settings: Settings, apiKey: string) => LlmProvider | null

/** Devices (docs/devices-protocol.md s8), each part optional: turn leases work with Devices off too. */
export interface RunnerDevices {
  /** Turn leases: crash resume and failover (runtime/turns.ts). */
  leases?: LeaseHook
  /** This node's own facts, stored as meta.origin on messages typed here. */
  selfOrigin?: () => object | null
  /** The prompt's one line about which device the newest message came from. */
  originLine?: (chat: string) => Promise<string>
  /**
   * A project chat another computer placed here works with that computer's commands-and-files choice (the person
   * made it there). Undefined: this computer's own setting.
   */
  shellFor?: (chat: string) => 'always' | 'ask' | 'never' | undefined
}

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
  /** What each chat last ran on, so a change of engine waits for its next new chat (runtime/brains.ts). */
  locks?: BrainLocks
  /** What is on this computer, from the cached scan. */
  environment?: () => EnvironmentReport | null
  /** Runs turns through an installed AI tool on the person's own plan (Claude Code). */
  cli?: CliHost
  /** Opens a web address in the person's own browser (sign-in pages). */
  openUrl?: (url: string) => void
  /** The person's profiles and learned app names, for the main agent's PROFILES section. */
  profiles?: () => { profiles: AgentProfileInfo[]; learnedNames: Record<string, string> }
  /** Files the person attached: the agent may open them without asking (the session's picked files). */
  allowFiles?: (paths: string[]) => void
  /**
   * Decides whether a message sent while a chat is busy is the same task or different work. Left out: a short
   * call on the chosen model (or the plan's quickest one). Null: never classify, every busy message joins.
   */
  classifier?: Classifier | null
  /** How long a joined message may wait to be read before it is started alongside instead. */
  joinPickupMs?: number
  devices?: RunnerDevices
  /**
   * Where the person is right now (presence/presence.ts): one note in front of each of his own messages in the main
   * thread and project chats, never in the system prompt. Left out: no note.
   */
  presence?: { note(chat: string, meta: string): Promise<string> }
}

interface ActivityRow {
  id: string
  text: string
  /** When the call started, for how long a run took. */
  started?: number
}

const MAX_RESULT_CHARS = 160
const MAX_NOTIFICATION_CHARS = 180

/** A message waiting to join a running chat at its next step. */
interface Steer {
  text: string
  images: string[]
  /** The person's chat row, for a typed message (helper results and card answers have none). */
  itemId?: string
  at: number
  /**
   * His own words (a typed message, a tap, an answer): read NOW, never after the step in flight (26 Oct 2026). A step
   * that only reads is cut off for it; one that changes something finishes and the message rides with its result.
   */
  urgent?: boolean
}

/**
 * One chat's line of work. Chats run in parallel: each has its own run, Stop, steer queue and transcript, and
 * the rows it writes carry its chat id.
 */
interface ChatLine {
  chat: string
  running: boolean
  controller: AbortController | null
  /** On a plan: the SDK turn in flight, so a joined message can pause it and resume the same session. */
  turn: AbortController | null
  /** True after a turn was paused for a joined message, so the next prompt says so. */
  paused: boolean
  steer: Steer[]
  /** What the person last asked this chat to do: the running task. */
  goal: string
  /** Cards this chat's run is waiting on right now. */
  waitingOn: Set<string>
  /** The approval cards among them: a run waiting on an approval is never paused (the card decides an action). */
  approving: Set<string>
  /** Rung when a message of his arrives, so the step in flight is cut off (API loop) or the plan turn paused. */
  bell: NoteBell
  /** When he last sent this chat a message: a second one soon after is about the same task by default. */
  lastUserAt: number
  /** A plan turn's tool calls in flight: an app tool's (mcp) or the engine's own. */
  inflight: Map<string, { name: string; input: Record<string, unknown>; mcp: boolean }>
  /** A message of his is waiting for a changing step of the plan turn to finish, then the turn is paused for it. */
  pauseWhenSafe: boolean
  /** Entries handed to the run whose rows are not yet marked delivered. */
  taken: Steer[]
  /** The last transcript row written, so a note riding with it can be stored with it. */
  lastTurnId: string
}

/** A joined message the run has not read after this long is started alongside instead, so it is never stuck. */
export const JOIN_PICKUP_MS = 120_000

/** How long the first turn after New chat waits for the summary of what came before. */
const CARRY_WAIT_MS = 20_000

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
  private readonly allowFiles: (paths: string[]) => void
  private readonly classifierOverride: Classifier | null | undefined
  private readonly joinPickupMs: number
  private readonly locks: BrainLocks | undefined
  private readonly devices: RunnerDevices | undefined
  private readonly presence: RunnerDeps['presence']
  /** The app is quitting: a turn cut off now keeps its lease running, so the next start resumes it. */
  private disposing = false

  private readonly lines = new Map<string, ChatLine>()
  private routineRunning = false
  private routineWaiting = false
  private routineController: AbortController | null = null
  /** Why the running routine was stopped (the card's X, helper_stop, switching it off), or null. */
  private routineStopBy: string | null = null
  /** The running routine's id and its entry in the live runs (runtime/live-runs.ts). */
  private routineTriggerId: string | null = null
  private routineLive: { step(line: string): void; end(): void } | null = null
  /** The running routine's card (routineCardId) and when its step line was last written. */
  private routineCard: { id: string; stepAt: number; step: string; timer: ReturnType<typeof setTimeout> | null } | null = null
  private readonly askWaiters = new Map<string, (answer: string | null) => void>()
  private readonly decisionWaiters = new Map<string, (approved: boolean) => void>()
  /** Card id -> the chat it is in, for every card waiting on the person. */
  private readonly waiting = new Map<string, string>()
  /** Stops following the store's card rows (dispose). */
  private readonly offCards: (() => void) | null
  private readonly activities = new Map<string, ActivityRow>()
  private readonly activityIds = new Map<number, string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
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
    this.allowFiles = deps.allowFiles ?? (() => undefined)
    this.classifierOverride = deps.classifier
    this.joinPickupMs = deps.joinPickupMs ?? JOIN_PICKUP_MS
    this.locks = deps.locks
    this.devices = deps.devices
    this.presence = deps.presence
    // Every card row is a card the person can answer, whoever wrote it: this runner, a helper (runtime/helpers.ts),
    // a project agent, or a row synced from another device. Before 22 Oct 2026 only the runner's own cards were
    // tracked, so a helper's question or approval was counted on the rail ("Waiting for you", 2) but never drawn
    // in Needs you or on the phone, and a card whose helper had ended could not be answered from there at all.
    const watched = deps.store as DataStore & { onChange?: (listener: (change: CardChange) => void) => () => void }
    this.offCards =
      watched.onChange?.((change) => {
        this.trackCard(change)
        this.routineCardStopped(change)
        this.routineSwitchedOff(change)
      }) ?? null
  }

  /** Keep the waiting list in step with the store: an open card row is waiting, an answered or deleted one is not. */
  private trackCard(change: CardChange): void {
    if (change.entity !== 'chat_item') return
    if (change.reset === true) {
      void this.rearmCards().catch(() => undefined)
      return
    }
    if (change.deleted === true) {
      const id = change.id ?? (change.row as { id?: string } | undefined)?.id
      if (id !== undefined && this.waiting.delete(id)) this.emit({ type: 'chat_changed' })
      return
    }
    const row = change.row as ChatItem | undefined
    if (row === undefined || (row.kind !== 'question' && row.kind !== 'approval')) return
    if (isOpenCardRow(row)) {
      if (this.waiting.get(row.id) === chatOf(row)) return
      this.waiting.set(row.id, chatOf(row))
      this.emitFor(chatOf(row), { type: 'chat_changed' })
    } else if (this.waiting.delete(row.id)) {
      this.emitFor(chatOf(row), { type: 'chat_changed' })
    }
  }

  /** Read every card again (the store was reset, for example by a sync). */
  private async rearmCards(): Promise<void> {
    const rows = await listWhere(this.store, 'chat_item', { kinds: ['question', 'approval'] })
    const open = new Map<string, string>()
    for (const row of rows) if (isOpenCardRow(row)) open.set(row.id, chatOf(row))
    let changed = false
    for (const id of [...this.waiting.keys()]) if (!open.has(id)) changed = this.waiting.delete(id) || changed
    for (const [id, chat] of open) if (this.waiting.get(id) !== chat) {
      this.waiting.set(id, chat)
      changed = true
    }
    if (changed) this.emit({ type: 'chat_changed' })
  }

  /** What runtime/brains.ts needs to say which AI a chat thinks with. */
  /** The helper models a chat may use, by name, with what each is good for (the person's words, else a guess). */
  private async helperModels(chat: string): Promise<Array<{ name: string; goodFor: string }>> {
    const settings = this.settings.get()
    try {
      return (await rosterFor(this.brainDeps(), chat)).map((entry) => ({
        name: rosterName(settings, entry),
        goodFor: entry.goodFor.trim() || defaultGoodFor(pickModel(settings, entry)),
      }))
    } catch {
      return []
    }
  }

  private brainDeps(): BrainDeps {
    return {
      settings: this.settings,
      secrets: this.secrets,
      providerFactory: this.providerFactory,
      hasCli: this.cli !== undefined,
      store: this.store,
      ...(this.locks === undefined ? {} : { locks: this.locks }),
    }
  }

  /** What a chat thinks with, for the picker in its header. */
  chatBrain(chat: string = MAIN_CHAT): Promise<ChatBrain> {
    return chatBrainOf(this.brainDeps(), chat)
  }

  private line(chat: string = MAIN_CHAT): ChatLine {
    let line = this.lines.get(chat)
    if (line === undefined) {
      line = {
        chat,
        running: false,
        controller: null,
        turn: null,
        paused: false,
        steer: [],
        goal: '',
        waitingOn: new Set(),
        approving: new Set(),
        bell: new NoteBell(),
        lastUserAt: 0,
        inflight: new Map(),
        pauseWhenSafe: false,
        taken: [],
        lastTurnId: '',
      }
      this.lines.set(chat, line)
    }
    return line
  }

  /** An event for a chat. The first chat's events look as they always did (no `chat` field). */
  private emitFor(chat: string, event: ChatEvent): void {
    this.emit(chat === MAIN_CHAT ? event : ({ ...event, chat } as ChatEvent))
  }

  // ---- the person's side ------------------------------------------------------------------

  /**
   * Put a message in a chat. When the chat is idle it starts a run. When the chat is busy the message is
   * routed: about the same task, it joins the running work; different work, it runs alongside as its own run
   * and leaves a summary block. Either way the person's row says which.
   */
  async send(text: string, attachments: Attachment[] = [], chat: string = MAIN_CHAT, origin?: MessageOrigin | JsonObject, via?: ChatVia): Promise<void> {
    const clean = text.trim()
    if (clean === '' && attachments.length === 0) return
    // The person handed these files over: the agent may open them without asking again.
    if (attachments.length > 0) this.allowFiles(attachments.map((attachment) => attachment.path))
    const prepared = await prepareMessage(clean, attachments)
    // Which device it was sent from (docs/devices-protocol.md s8): the wire caller's, else this node's own.
    // Not the person's own words (a call handing over its work): the row says who, so no window draws it as his.
    const meta: JsonObject = {
      attachments: attachments as unknown as JsonObject[],
      ...chatTag(chat),
      ...this.originMeta(origin as JsonObject | undefined),
      ...(via === undefined ? {} : { via: via as unknown as JsonObject }),
    }
    const line = this.line(chat)

    if (!line.running) {
      await this.begin(line, prepared.text, prepared.images, { text: clean, meta: JSON.stringify(meta) })
      return
    }

    const sinceLastMs = this.now() - line.lastUserAt
    if (via === undefined) line.lastUserAt = this.now()
    const row = await this.addUserItem(line.chat, clean, JSON.stringify({ ...meta, route: 'pending' }))
    // His own message joining running work carries where he is too (it is read at once, mid-step).
    const presence = via === undefined ? await this.presenceNote(line.chat, row.meta) : ''
    await this.routeBusy(line, row.id, clean, prepared, attachments.length > 0, presence, sinceLastMs)
  }

  /** The presence note for one of his messages (already stored), or '' when there is none. */
  private async presenceNote(chat: string, meta: string): Promise<string> {
    const presence = this.presence
    if (presence === undefined) return ''
    try {
      return await presence.note(chat, meta)
    } catch {
      return ''
    }
  }

  /**
   * A message from another chat: the main agent starting or steering a project chat, or a project chat writing to
   * the main thread (tools/projects.ts). It shows in `chat` labelled with who sent it and runs that chat's turn like
   * a message from the person; while the chat is busy it joins the running work. Never waits for the turn.
   */
  async receive(chat: string, text: string, via: ChatVia): Promise<void> {
    const clean = text.trim()
    if (clean === '') return
    const line = this.line(chat)
    const meta = JSON.stringify({ ...chatTag(chat), via: via as unknown as JsonObject })
    const said = `${viaLabel(via)} ${clean}`
    if (!line.running) {
      void this.begin(line, said, [], { text: clean, meta })
      return
    }
    const row = await this.addUserItem(chat, clean, meta)
    this.pushSteer(line, { text: said, images: [], itemId: row.id, at: this.now() })
    this.emitFor(chat, { type: 'chat_changed' })
  }

  /** Same task joins, different work goes alongside; see chat-route.ts. */
  private async routeBusy(line: ChatLine, itemId: string, clean: string, prepared: PreparedMessage, hasFiles: boolean, presence = '', sinceLastMs = 0): Promise<void> {
    const canAlongside = this.helpers?.alongside !== undefined
    // Decided locally and at once; a model is asked only when nothing else settles it, and for a few seconds at most.
    const decision = canAlongside
      ? await decideRoute({ goal: line.goal, text: clean, recent: await this.recentLines(line.chat), hasFiles, sinceLastMs }, this.classifier())
      : null

    if (decision !== null && decision.route === 'alongside' && line.running) {
      if (await this.startAlongside(line, itemId, prepared, '')) return
    }
    await this.join(line, itemId, prepared, presence)
  }

  private async startAlongside(line: ChatLine, itemId: string, prepared: PreparedMessage, why: string): Promise<boolean> {
    const start = this.helpers?.alongside
    if (start === undefined) return false
    let id: string | null = null
    try {
      id = await start.call(this.helpers, {
        chat: line.chat,
        text: alongsideBrief(prepared.text, line.goal),
        images: prepared.images,
        goal: line.goal,
        userItem: itemId,
      })
    } catch {
      id = null
    }
    if (id === null) return false
    // Gone its own way: never redelivered to the run after a restart.
    await this.patchMeta(itemId, { route: 'alongside', helper: id, delivered: '', ...(why === '' ? {} : { routeWhy: why }) })
    this.emitFor(line.chat, { type: 'chat_changed' })
    return true
  }

  /** The message joins the running work at its next step, or starts the next turn if the run just ended. */
  private async join(line: ChatLine, itemId: string, prepared: PreparedMessage, presence = ''): Promise<void> {
    const lead = presence === '' ? '' : `${presence}\n`
    if (!line.running) {
      await this.patchMeta(itemId, { route: '' })
      await this.begin(line, lead + prepared.text, prepared.images, null)
      return
    }
    const pictures = prepared.images.length > 0 ? `\n(Pictures attached: ${prepared.images.join(', ')}. Look at them with your file tools.)` : ''
    // Stored as joined and not yet delivered first, so a restart before the run reads it delivers it then (restore).
    await this.patchMeta(itemId, { route: 'join', delivered: false })
    this.pushSteer(line, { text: lead + joinNote(prepared.text) + pictures, images: prepared.images, itemId, at: this.now(), urgent: true })
    this.emitFor(line.chat, { type: 'chat_changed' })
    this.watch(line, itemId, prepared)
  }

  /**
   * A note for the running work. Never twice: a message already waiting or already handed over is not added again.
   * His own words ring the bell: the API loop cuts off a step that only reads (and never one that changes something),
   * a plan turn is paused now or as soon as its changing step is done (interruptPlan).
   */
  private pushSteer(line: ChatLine, entry: Steer): void {
    if (entry.itemId !== undefined && (line.steer.some((each) => each.itemId === entry.itemId) || line.taken.some((each) => each.itemId === entry.itemId))) return
    line.steer.push(entry)
    if (entry.urgent !== true) return
    line.bell.ring()
    this.interruptPlan(line)
  }

  /** Is a message of his waiting for the run? */
  private urgentWaiting(line: ChatLine): boolean {
    return line.steer.some((entry) => entry.urgent === true)
  }

  /**
   * A plan engine runs its own loop, so a message of his reaches it one of two ways, whichever is sooner and safe:
   *  - an app tool that only reads is in flight: the bell cuts it off and the message rides with its result;
   *  - otherwise (the model is thinking, or the engine's own read is running) the turn is paused now and the same
   *    session resumed with the message (drive);
   *  - a step that changes something (a write, a send, a push, a command that is not read-only) is never cut: an app
   *    tool hands the message over with its result, an engine tool's end pauses the turn right after it.
   * Never while an approval card waits: that card decides an action and must stay answerable.
   */
  private interruptPlan(line: ChatLine): void {
    const turn = line.turn
    if (turn === null || turn.signal.aborted || line.approving.size > 0 || !this.urgentWaiting(line)) {
      if (!this.urgentWaiting(line)) line.pauseWhenSafe = false
      return
    }
    const calls = [...line.inflight.values()]
    if (calls.some((call) => !isInterruptible(call.name, call.input))) {
      line.pauseWhenSafe = true
      return
    }
    line.pauseWhenSafe = false
    // An app tool that only reads is cut off by the bell, and the message goes in with its result.
    if (calls.some((call) => call.mcp)) return
    line.paused = true
    turn.abort()
  }

  /** A plan turn's tool started or finished: track it, and pause for a waiting message once nothing changing runs. */
  private planTool(line: ChatLine, id: string, name: string, input: Record<string, unknown>, running: boolean, mcp: boolean): void {
    if (running) line.inflight.set(id, { name, input, mcp })
    else line.inflight.delete(id)
    if (!running && line.pauseWhenSafe) this.interruptPlan(line)
  }

  /** A joined message nobody has read after a long while goes alongside, so it is never left unanswered. */
  private watch(line: ChatLine, itemId: string, prepared: PreparedMessage): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      const index = line.steer.findIndex((entry) => entry.itemId === itemId)
      if (index < 0 || !line.running) return
      // Waiting on the person: the run moves on as soon as they answer, so the message keeps its place.
      if (line.waitingOn.size > 0) {
        this.watch(line, itemId, prepared)
        return
      }
      const [entry] = line.steer.splice(index, 1)
      void this.startAlongside(line, itemId, prepared, 'slow').then((started) => {
        if (!started && entry !== undefined) {
          if (line.running) this.pushSteer(line, entry)
          else {
            void this.markDelivered([entry])
            void this.begin(line, entry.text, entry.images, null)
          }
        }
      })
    }, this.joinPickupMs)
    timer.unref?.()
    this.timers.add(timer)
  }

  /** Hand every waiting note to the run (once). Their rows are marked delivered by `delivered`. */
  private takeSteer(line: ChatLine): string[] {
    const entries = line.steer.splice(0)
    line.taken.push(...entries)
    if (entries.some((entry) => entry.urgent === true)) line.pauseWhenSafe = false
    return entries.map((entry) => entry.text)
  }

  /** The notes handed over are in the run's transcript now: their rows say delivered, so a restart never resends them. */
  private async delivered(line: ChatLine): Promise<void> {
    const entries = line.taken.splice(0)
    await this.markDelivered(entries)
  }

  private async markDelivered(entries: Steer[]): Promise<void> {
    for (const entry of entries) {
      if (entry.itemId === undefined) continue
      try {
        const row = await this.store.get('chat_item', entry.itemId)
        if (row !== null && parseMeta(row.meta)['delivered'] === false) await this.patchMeta(entry.itemId, { delivered: true })
      } catch {
        // The row is gone: nothing to mark.
      }
    }
  }

  /** Stop a chat's turn in flight. Messages already sent to it are not lost: they start the next turn. */
  stop(chat: string = MAIN_CHAT): void {
    const controller = this.line(chat).controller
    if (controller !== null) controller.abort()
  }

  /** One chat's run and cards. With no chat: whether any chat is running, and every waiting card. */
  state(chat?: string): RunState {
    if (chat === undefined) {
      return { running: [...this.lines.values()].some((line) => line.running), waiting: [...this.waiting.keys()] }
    }
    return {
      running: this.lines.get(chat)?.running ?? false,
      waiting: [...this.waiting.entries()].filter(([, owner]) => owner === chat).map(([id]) => id),
    }
  }

  /** Every chat with something going on: running, waiting on the person, or with work alongside. */
  states(): ChatRunInfo[] {
    const chats = new Set<string>([...this.lines.keys(), ...this.waiting.values()])
    const live = this.helpers?.live() ?? []
    for (const helper of live) chats.add(helper.chat ?? MAIN_CHAT)
    const out: ChatRunInfo[] = []
    for (const chat of chats) {
      const running = this.lines.get(chat)?.running ?? false
      const waiting = [...this.waiting.entries()].filter(([, owner]) => owner === chat).map(([id]) => id)
      const alongside = live.filter((helper) => (helper.chat ?? MAIN_CHAT) === chat).length
      if (running || waiting.length > 0 || alongside > 0) out.push({ chat, running, waiting, alongside })
    }
    return out
  }

  /** A new chat with this message's chat history up to and including it. Returns the new chat id. */
  async branch(itemId: string): Promise<string> {
    const point = await this.store.get('chat_item', itemId)
    const result = await branchChat(this.store, itemId, this.now)
    if (result === null || point === null) throw new Error('That message is gone.')
    // A branch of a project chat is a chat in the same project.
    const from = chatOf(point)
    const project = from === MAIN_CHAT ? undefined : (await this.store.list('project')).find((each) => each.chats.includes(from))
    if (project !== undefined) await this.store.upsert('project', { id: project.id, chats: [...project.chats, result.chat] })
    this.emitFor(result.chat, { type: 'chat_changed' })
    return result.chat
  }

  /**
   * A finished helper's result, as a new turn in the chat that started it. There is no user bubble: the note is
   * the turn's first message. While that chat is running it joins the run as a steering note instead.
   */
  async deliver(text: string, chat: string = MAIN_CHAT): Promise<void> {
    const clean = text.trim()
    if (clean === '') return
    const line = this.line(chat)
    if (line.running) {
      this.pushSteer(line, { text: clean, images: [], at: this.now() })
      this.emitFor(chat, { type: 'chat_changed' })
      return
    }
    await this.begin(line, clean, [], null)
  }

  /** A separate run (a different job sent while the chat was busy) finished; its summary block is in the chat. */
  async alongsideDone(chat: string, helperId: string): Promise<void> {
    this.emitFor(chat, { type: 'chat_changed' })
    const row = await this.store.get('chat_item', helperId)
    if (row === null) return
    const meta = parseMeta(row.meta)
    // Merged back into the conversation: a run still going reads it at its next step (an idle chat's next turn does).
    const line = this.line(chat)
    if (line.running && meta['told'] !== true) {
      const asked = typeof meta['ask'] === 'string' ? ((await this.store.get('chat_item', meta['ask']))?.text ?? '') : ''
      const result = typeof meta['result'] === 'string' ? meta['result'] : ''
      await this.patchMeta(helperId, { told: true })
      this.pushSteer(line, {
        text: `[Done alongside while you were busy (the user already saw its summary; do not redo it): they asked "${clip(asked, 300)}". ${meta['state'] === 'done' ? 'Result' : 'It failed'}: ${clip(result, 1500)}]`,
        images: [],
        at: this.now(),
      })
    }
    const label = typeof meta['label'] === 'string' ? meta['label'] : 'A separate job'
    const state = meta['state'] === 'done' ? 'is done' : 'stopped short'
    this.sendNotification(`${label} ${state}`, clip(typeof meta['result'] === 'string' ? meta['result'] : '', MAX_NOTIFICATION_CHARS), true)
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
    const chat = chatOf(row)

    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...meta, answer }),
    })
    this.waiting.delete(itemId)
    this.emitFor(chat, { type: 'chat_changed' })

    if (waiter !== undefined) {
      waiter(answer)
      return
    }
    if (answered) return
    await this.continueAfterCard(`The user answered your question "${row.text}" with: ${answer}`, chat)
  }

  /**
   * The person chose Run without asking for this computer: every card still waiting on a command, code or a
   * file (the main agent's or a helper's) goes ahead too. Cards for anything sent or done elsewhere stay.
   */
  async approveComputerCards(): Promise<number> {
    const rows = await listWhere(this.store, 'chat_item', { kind: 'approval' })
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
    const chat = chatOf(row)

    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...meta, decision }),
    })
    this.waiting.delete(itemId)
    this.emitFor(chat, { type: 'chat_changed' })

    if (waiter !== undefined) {
      waiter(decision === 'approve')
      return
    }
    if (decided) return
    const verb = decision === 'approve' ? 'approved' : 'declined'
    await this.continueAfterCard(`The user ${verb} your request: ${summary}`, chat)
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
    const chat = chatOf(row)
    const meta = parseMeta(row.meta)
    const taps = Array.isArray(meta['taps']) ? meta['taps'].filter((t): t is string => typeof t === 'string') : []
    if (!taps.includes(clean)) {
      await this.store.upsert('chat_item', {
        id: row.id,
        kind: row.kind,
        text: row.text,
        meta: JSON.stringify({ ...meta, taps: [...taps, clean].slice(-50) }),
      })
      this.emitFor(chat, { type: 'chat_changed' })
    }
    const note = quietTapNote(label, clean)
    const line = this.line(chat)
    if (line.running) {
      this.pushSteer(line, { text: note, images: [], at: this.now(), urgent: true })
      return
    }
    // A tap is the person acting, so it starts a fresh action budget like a typed message.
    this.budget?.reset()
    await this.begin(line, note, [], null)
  }

  /**
   * Startup repair. An activity left running by a crash becomes an error, and cards nobody answered
   * are re-armed so answering one still carries the conversation on.
   */
  async restore(): Promise<void> {
    // Helpers the app closed under are ended and their creators told, once this repair is done (a notice starts a
    // turn, whose rows must not be caught by the repair below).
    await this.helpers?.restore?.({ defer: true })
    try {
      await this.repairRows()
    } finally {
      this.helpers?.flushNotices?.()
    }
  }

  private async repairRows(): Promise<void> {
    // Steps left running, by a raw match inside the database, and every row that is not a step: never the 57,000
    // finished steps (nearly all of the table's 240 MB) parsed on every start (28 Oct 2026).
    // The last two days' steps are read whole too, so a step written some other way is still caught.
    const [running, recent, rest] = await Promise.all([
      listWhere(this.store, 'chat_item', { kind: 'activity', contains: RUNNING_IN_META }),
      listWhere(this.store, 'chat_item', { kind: 'activity', since: this.now() - RECENT_STEPS_MS }),
      listWhere(this.store, 'chat_item', { exceptKinds: ['activity'] }),
    ])
    const items = [...new Map([...running, ...recent, ...rest].map((row) => [row.id, row])).values()]
    const undelivered = new Map<string, ChatItem[]>()
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

      if (isOpenCardRow(item)) this.waiting.set(item.id, chatOf(item))

      // A message of his that the run never read (it joined running work, or was still being routed) when the app
      // closed: it is delivered now, once. One already in the transcript is only marked.
      if (item.kind === 'user' && (meta['route'] === 'pending' || (meta['route'] === 'join' && meta['delivered'] === false))) {
        const chat = chatOf(item)
        if (await this.inTranscript(chat, item)) {
          await this.patchMeta(item.id, { route: 'join', delivered: true })
        } else {
          await this.patchMeta(item.id, { route: 'join', delivered: false })
          const list = undelivered.get(chat) ?? []
          list.push(item)
          undelivered.set(chat, list)
        }
        changed = true
      }
    }

    if (changed) this.emit({ type: 'chat_changed' })
    for (const [chat, rows] of undelivered) this.redeliver(chat, rows)
  }

  /** Is this message of his already in its chat's transcript (handed over before the app closed)? */
  private async inTranscript(chat: string, item: ChatItem): Promise<boolean> {
    const words = item.text.trim()
    if (words === '') return false
    const needle = JSON.stringify(words).slice(1, -1)
    const turns = await listWhere(this.store, 'turn', { thread: threadFor(chat), since: Math.max(0, item.createdAt - 1) })
    return turns.some((turn) => turn.thread === threadFor(chat) && turn.createdAt >= item.createdAt - 1 && (turn.json.includes(needle) || turn.json.includes(words)))
  }

  /** Messages of his the run never read before a restart: into the running work, or a turn of their own. */
  private redeliver(chat: string, rows: ChatItem[]): void {
    const line = this.line(chat)
    const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt)
    const entries: Steer[] = sorted.map((row) => ({
      text: joinNote(row.text),
      images: [],
      itemId: row.id,
      at: this.now(),
      urgent: true,
    }))
    if (line.running) {
      for (const entry of entries) this.pushSteer(line, entry)
      return
    }
    void this.markDelivered(entries)
    void this.begin(line, entries.map((entry) => entry.text).join('\n\n'), [], null)
  }

  dispose(): void {
    this.disposing = true
    this.offCards?.()
    for (const line of this.lines.values()) line.controller?.abort()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
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
    this.routineStopBy = null
    // The run's own stop, made before anything starts: the card's X, helper_stop, Stop all and switching the routine
    // off all end it through here, the engine's process included (28 Oct 2026: none of them could).
    const controller = new AbortController()
    this.routineController = controller
    this.routineTriggerId = trigger.id
    const live = liveRuns.start({
      id: routineCardId(trigger.id),
      kind: 'routine',
      label: trigger.name,
      owner: 'routine',
      startedAt: this.now(),
      stop: (by) => {
        if (this.routineStopBy === null) this.routineStopBy = by === '' ? 'it was stopped' : `stopped by ${by}`
        controller.abort()
      },
    })
    this.routineLive = live
    let outcome: RoutineRunResult = { text: 'The routine stopped.', waiting: false, failed: true }
    await this.openRoutineCard(trigger).catch(() => undefined)
    try {
      // Only a stop from outside (its X, helper_stop, switched off) makes it stopped; a routine that ends itself on a
      // card aborts its own turn and is waiting, not stopped.
      outcome = this.routineStopBy !== null ? { text: 'Stopped before it started.', waiting: false, failed: true, stopped: true } : await this.runRoutineTurn(trigger)
      if (this.routineStopBy !== null) outcome = { text: `Stopped: ${this.routineStopBy}.`, waiting: false, failed: true, stopped: true }
      return outcome
    } catch (error) {
      outcome = this.routineStopBy !== null
        ? { text: `Stopped: ${this.routineStopBy ?? 'it was stopped'}.`, waiting: false, failed: true, stopped: true }
        : { text: friendlyError(error), waiting: false, failed: true }
      throw error
    } finally {
      await this.closeRoutineCard(outcome).catch(() => undefined)
      live.end()
      this.routineLive = null
      this.routineTriggerId = null
      this.routineRunning = false
      this.routineWaiting = false
      this.routineController = null
      // The routine's run is over: the tabs it opened close now (browser/run-tabs.ts).
      runEnded('routine')
    }
  }

  /** The routine's card goes up in the main chat as working, so the sidebar shows it running. */
  private async openRoutineCard(trigger: TriggerRow): Promise<void> {
    const id = routineCardId(trigger.id)
    const existing = await this.store.get('chat_item', id)
    const old = existing === null ? {} : parseMeta(existing.meta)
    const startedAt = this.now()
    this.routineCard = { id, stepAt: 0, step: '', timer: null }
    await this.store.upsert('chat_item', {
      id,
      kind: 'helper',
      text: trigger.prompt.slice(0, 2000),
      meta: JSON.stringify({
        ...old,
        id,
        label: trigger.name,
        state: 'working',
        summary: 'Starting',
        queued: false,
        startedAt,
        endedAt: null,
        result: '',
        routine: { id: trigger.id, name: trigger.name },
      }),
    })
    this.emitFor(MAIN_CHAT, { type: 'chat_changed' })
  }

  /** The step a routine is on, as its card's line: written at most every ROUTINE_STEP_MS, the newest one last. */
  private routineStep(text: string): void {
    const card = this.routineCard
    const step = clip(text.replace(/\s+/g, ' ').trim(), 140)
    if (card === null || step === '') return
    card.step = step
    this.routineLive?.step(step)
    if (card.timer !== null) return
    const wait = Math.max(0, card.stepAt + ROUTINE_STEP_MS - this.now())
    card.timer = setTimeout(() => {
      card.timer = null
      if (this.routineCard !== card) return
      card.stepAt = this.now()
      void this.keepRoutineCard(card.id, card.step).catch(() => undefined)
    }, wait)
    card.timer.unref?.()
  }

  private async closeRoutineCard(outcome: RoutineRunResult): Promise<void> {
    const card = this.routineCard
    this.routineCard = null
    if (card === null) return
    if (card.timer !== null) clearTimeout(card.timer)
    const result = outcome.waiting ? WAITING_FOR_USER : outcome.text.trim()
    await this.patchRoutineCard(card.id, {
      state: outcome.stopped === true ? 'stopped' : outcome.failed === true ? 'failed' : 'done',
      summary: clip((result.split('\n').find((line) => line.trim() !== '') ?? 'Done').trim(), 140),
      result: result.slice(0, 6000),
      endedAt: this.now(),
    }, false)
  }

  private async patchRoutineCard(id: string, patch: Record<string, unknown>, onlyWhileWorking: boolean): Promise<void> {
    const row = await this.store.get('chat_item', id)
    if (row === null) return
    const meta = parseMeta(row.meta)
    if (onlyWhileWorking && meta['state'] !== 'working') return
    await this.store.upsert('chat_item', { id, kind: row.kind, text: row.text, meta: JSON.stringify({ ...meta, ...patch }) })
    this.emitFor(MAIN_CHAT, { type: 'chat_changed' })
  }

  /**
   * The running routine's card says working, with its step, for as long as it runs: anything that marked it ended
   * while it still ran (the start-up repair did, 28 Oct 2026, and the run went on unseen) is put right. A card
   * marked stopped stops the run instead.
   */
  private async keepRoutineCard(id: string, step: string): Promise<void> {
    const row = await this.store.get('chat_item', id)
    if (row === null || this.routineCard?.id !== id) return
    const meta = parseMeta(row.meta)
    if (meta['state'] === 'stopped') {
      liveRuns.stop(id, 'the person, from its card')
      return
    }
    await this.store.upsert('chat_item', { id, kind: row.kind, text: row.text, meta: JSON.stringify({ ...meta, state: 'working', summary: step, endedAt: null, result: '', endReason: undefined }) })
    this.emitFor(MAIN_CHAT, { type: 'chat_changed' })
  }

  /** A routine switched off or deleted while it runs: its run stops. */
  private routineSwitchedOff(change: CardChange): void {
    const id = this.routineTriggerId
    if (id === null || (change.entity as string) !== 'trigger') return
    const row = change.row as { id?: unknown; enabled?: unknown } | undefined
    const gone = change.deleted === true && change.id === id
    const off = row !== undefined && row.id === id && row.enabled === false
    if (gone || off) liveRuns.stop(routineCardId(id), gone ? 'deleting the routine' : 'switching the routine off')
  }

  /** Stop on a routine's card (the helpers view, a phone): the helper service marks it stopped, and the run ends. */
  private routineCardStopped(change: CardChange): void {
    const card = this.routineCard
    const row = change.row as { id?: unknown; meta?: unknown } | undefined
    if (card === null || row === undefined || row.id !== card.id || typeof row.meta !== 'string') return
    if (parseMeta(row.meta)['state'] === 'stopped') liveRuns.stop(card.id, 'the person, from its card')
  }

  private async runRoutineTurn(trigger: TriggerRow): Promise<RoutineRunResult> {
    const brain = mainBrain(this.brainDeps())
    if (!isBrain(brain)) return { text: brain.message, waiting: false, failed: true }
    if (brain.kind === 'plan') return this.runCliRoutine(trigger, brain)
    const resolved = { provider: brain.provider, model: brain.model, current: this.settings.get() }

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
        promptRules: await promptRulesFor(this.store),
        environment: this.environment(),
        ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
      })

      const controller = this.routineController ?? new AbortController()
      this.routineController = controller
      const context = this.toolContext(controller.signal, 'routine')
      const loop = new AgentLoop({ provider: resolved.provider, model: resolved.model, tools: this.tools })
      const text = await loop.run(system, history, context, {
        signal: controller.signal,
        // Its steps show on its card.
        onEvent: async (event) => {
          if (event.type === 'tool_started') this.routineStep(toolStepLabel(event.call.name))
        },
      })

      if (this.routineWaiting) return { text: WAITING_FOR_USER, waiting: true }
      const summary = text.trim()
      return {
        text: summary === '' ? 'The routine finished without a summary.' : summary,
        waiting: false,
      }
    } catch (error) {
      return { text: friendlyError(error), waiting: false, failed: true }
    }
  }

  // ---- running a turn ---------------------------------------------------------------------

  private async begin(
    line: ChatLine,
    text: string,
    images: string[],
    user: { text: string; meta: string } | null,
    leaseId?: string,
  ): Promise<void> {
    // Quitting: no new turn starts (his messages wait in their rows, undelivered, for the next start).
    if (this.disposing) return
    line.running = true
    // A message the person sent starts a fresh action budget. A helper's result does not.
    if (user !== null) {
      this.budget?.reset()
      line.goal = user.text
      if (parseMeta(user.meta)['via'] === undefined) line.lastUserAt = this.now()
    }
    const controller = new AbortController()
    line.controller = controller

    let error: string | undefined
    let lease: string | null = null
    try {
      const userRow = user !== null ? await this.addUserItem(line.chat, user.text, user.meta) : null
      lease = this.devices?.leases?.begin({ kind: 'turn', chatId: line.chat, messageId: userRow?.id ?? '', prompt: user?.text ?? text, ...(leaseId === undefined ? {} : { id: leaseId }) }) ?? null
      // The lease is stored before anyone hears the turn started, so a brain that dies right after can be taken over.
      await this.devices?.leases?.settled?.()
      this.emitFor(line.chat, { type: 'run_started' })
      // His own message (not another agent's, not a card answer) carries where he is right now.
      const presence = userRow !== null && parseMeta(userRow.meta)['via'] === undefined ? await this.presenceNote(line.chat, userRow.meta) : ''
      const prompt = await this.withContextNotes(line, text, presence)
      error = await this.drive(line, prompt, images, controller.signal)
    } finally {
      if (lease !== null && !this.disposing) this.devices?.leases?.end(lease, error === undefined ? 'done' : 'failed')
      if (line.controller === controller) line.controller = null
      line.turn = null
      line.paused = false
      line.pauseWhenSafe = false
      line.inflight.clear()
      line.running = false
      // The turn is over: its tabs close after a few idle minutes, unless the next turn browses again first.
      runEnded(browserOwnerOf('main', line.chat), MAIN_IDLE_MS)
      this.emitFor(line.chat, error === undefined ? { type: 'run_finished' } : { type: 'run_finished', error })
      // Messages that landed in the last instant of the run, or while it was being stopped, still get an answer.
      // The app is quitting: what is still waiting stays undelivered in its rows, and the next start delivers it.
      const leftover = this.disposing ? [] : line.steer.splice(0)
      // Anything handed over but not yet marked (the run ended mid-step) is marked now: it is in the transcript.
      void this.delivered(line)
      if (leftover.length > 0) {
        void this.markDelivered(leftover)
        void this.begin(
          line,
          leftover.map((entry) => entry.text).join('\n\n'),
          leftover.flatMap((entry) => entry.images),
          null,
        )
      }
    }
  }

  /** Run a chat again after it was cut off (runtime/turns.ts), under the lease it had. Never waits for the run. */
  async resumeTurn(chat: string, leaseId: string, note: string): Promise<void> {
    const line = this.line(chat)
    if (line.running) {
      this.pushSteer(line, { text: note, images: [], at: this.now() })
      this.emitFor(chat, { type: 'chat_changed' })
      return
    }
    void this.begin(line, note, [], null, leaseId)
  }

  /**
   * How a tool another brain runs on this node reaches the person here (devices/device-tools.ts, s11): its question
   * and approval cards show in the same chat on this node and wait for an answer; a notification shows here.
   */
  deviceContext(chat: string, signal: AbortSignal): Pick<ToolContext, 'ask' | 'approve' | 'notify'> {
    const context = this.toolContext(signal, 'main', chat)
    return { ask: context.ask, approve: context.approve, notify: context.notify }
  }

  /** meta.origin for a message: the device it came from (the node server says), else this node itself. */
  private originMeta(origin: JsonObject | undefined): JsonObject {
    const value = origin ?? (this.devices?.selfOrigin?.() as JsonObject | null | undefined) ?? null
    return value === null ? {} : { origin: value }
  }

  /** The prompt's line about where the newest message came from, when Devices is on. */
  private async deviceLine(chat: string): Promise<{ deviceLine?: string }> {
    const make = this.devices?.originLine
    if (make === undefined) return {}
    try {
      const line = await make(chat)
      return line === '' ? {} : { deviceLine: line }
    } catch {
      return {}
    }
  }

  private async continueAfterCard(prompt: string, chat: string): Promise<void> {
    const line = this.line(chat)
    if (line.running) {
      // His answer to a card the run is no longer waiting on: read now, like a message.
      this.pushSteer(line, { text: prompt, images: [], at: this.now(), urgent: true })
      this.emitFor(chat, { type: 'chat_changed' })
      return
    }
    await this.begin(line, prompt, [], null)
  }

  private async drive(
    line: ChatLine,
    first: string,
    images: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let text = first
    let pendingImages = images
    let error: string | undefined

    for (;;) {
      error = await this.runTurn(line, text, pendingImages, signal)
      if (signal.aborted) break
      const queued = line.steer.splice(0)
      if (queued.length === 0) break
      await this.markDelivered(queued)
      const paused = line.paused
      line.paused = false
      // The task is named again: if the paused session could not be resumed, the new one still knows what it was.
      const resume = paused ? `${PAUSED_NOTE} The task: "${clip(line.goal, 400)}".\n\n` : ''
      text = resume + queued.map((entry) => entry.text).join('\n\n')
      pendingImages = queued.flatMap((entry) => entry.images)
    }
    return error
  }

  /**
   * What the chat's agent should know before this turn: separate runs that finished alongside since its last
   * turn, and for a branched chat with no transcript of its own, the conversation it was branched from.
   */
  private async withContextNotes(line: ChatLine, text: string, presence = ''): Promise<string> {
    // Only the kinds read below: a chat's activity steps are nearly all of its bytes (seconds to read on every message).
    const rows = await listWhere(this.store, 'chat_item', { chat: line.chat, kinds: ['user', 'agent', 'report', 'notice', 'helper'] })
    const notes: string[] = []

    const carry = await this.carriedSummary(rows)
    if (carry !== '') notes.push(`[The user started fresh in this chat. Where things stood before (for you to keep in mind; do not repeat it back):]\n${carry}\n[End of where things stood.]`)

    const handoff = rows.find((row) => row.kind === 'notice' && parseMeta(row.meta)['handoff'] === true)
    if (handoff !== undefined) {
      const history = handoffText(rows.filter((row) => row.createdAt <= handoff.createdAt))
      if (history !== '') notes.push(`[This chat was branched from an earlier conversation. Here it is up to the branch point, so you have its context:]\n${history}\n[End of the earlier conversation.]`)
      await this.patchMeta(handoff.id, { handoff: false })
    }

    for (const row of rows) {
      if (row.kind !== 'helper') continue
      const meta = parseMeta(row.meta)
      if (meta['side'] !== true || meta['told'] === true) continue
      if (meta['state'] !== 'done' && meta['state'] !== 'failed') continue
      const asked = rows.find((other) => other.id === meta['ask'])?.text ?? ''
      const result = typeof meta['result'] === 'string' ? meta['result'] : ''
      notes.push(
        `[Done alongside while you were busy (the user already saw its summary; do not redo it): they asked "${clip(asked, 300)}". ${meta['state'] === 'done' ? 'Result' : 'It failed'}: ${clip(result, 1500)}]`,
      )
      await this.patchMeta(row.id, { told: true })
    }
    // Last, right before his words: where he is as he sends them.
    if (presence !== '') notes.push(presence)
    return notes.length === 0 ? text : `${notes.join('\n\n')}\n\n${text}`
  }

  /**
   * After New chat in the main thread: the summary the memory service wrote onto the divider (memory/service.ts
   * compressChat), handed over once, on the first turn after it. The summary may still be on its way: it is waited
   * for a little, and if it never comes the last messages before the divider stand in for it.
   */
  private async carriedSummary(rows: ChatItem[]): Promise<string> {
    const divider = rows.filter((row) => row.kind === 'notice' && parseMeta(row.meta)['divider'] === true).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (divider === undefined) return ''
    let meta = parseMeta(divider.meta)
    if (meta['compress'] === undefined || meta['carried'] === true) return ''
    for (let waited = 0; meta['compress'] === 'pending' && waited < CARRY_WAIT_MS; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      meta = parseMeta((await this.store.get('chat_item', divider.id))?.meta ?? '{}')
    }
    let carry = typeof meta['carry'] === 'string' ? meta['carry'].trim() : ''
    if (carry === '') {
      carry = rows
        .filter((row) => row.createdAt < divider.createdAt && (row.kind === 'user' || row.kind === 'agent') && row.text.trim() !== '')
        .slice(-10)
        .map((row) => `${row.kind === 'user' ? 'User' : 'You'}: ${clip(row.text.trim(), 600)}`)
        .join('\n')
    }
    await this.patchMeta(divider.id, { carried: true })
    return carry
  }

  /** The main thread's AI as a provider call (the memory pass, the classifier), or why there is none. */
  private resolveModel():
    | { ok: true; provider: LlmProvider; model: string; current: Settings }
    | { ok: false; message: string } {
    const brain = mainBrain(this.brainDeps())
    if (!isBrain(brain)) return { ok: false, message: brain.message }
    if (brain.kind === 'plan') return { ok: false, message: 'The main agent runs on a plan; this needs an API key account.' }
    return { ok: true, provider: brain.provider, model: brain.model, current: this.settings.get() }
  }

  /** The same/different call for a message sent while busy: one short, tool-free request. Null when none can run. */
  private classifier(): Classifier | null {
    if (this.classifierOverride !== undefined) return this.classifierOverride
    const brain = mainBrain(this.brainDeps())
    // On a plan, starting the engine for a one-word answer takes longer than his message may wait: decided locally.
    if (isBrain(brain) && brain.kind === 'plan') return null
    const resolved = this.resolveModel()
    if (!resolved.ok) return null
    return async (question, signal) => {
      const completion = await resolved.provider.complete(CLASSIFIER_SYSTEM, [userMsg(classifierPrompt(question))], [], resolved.model, 400, signal)
      return parseVerdict(msgText(completion.message))
    }
  }

  /** A few recent lines of a chat, oldest first, for the classifier. */
  private async recentLines(chat: string): Promise<string[]> {
    const newest = await listWhere(this.store, 'chat_item', { chat, kinds: ['user', 'agent'], newestFirst: true, limit: 40 })
    const rows = [...newest].reverse().filter((row) => (row.kind === 'user' || row.kind === 'agent') && row.text.trim() !== '')
    return rows.slice(-7, -1).map((row) => `${row.kind === 'user' ? 'User' : 'Agent'}: ${row.text}`)
  }

  private async runTurn(
    line: ChatLine,
    text: string,
    images: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const chat = line.chat
    const brain = await pickBrain(this.brainDeps(), chat)
    if (!isBrain(brain)) {
      await this.notice(brain.message, chat)
      return undefined
    }
    if (brain.kind === 'plan') return this.runCliTurn(line, text, images, signal, brain)
    const { provider, model } = brain
    const current = this.settingsFor(chat)

    const memories = await this.store.list('memory')
    const goals = await this.store.list('goal')
    const tasks = await this.store.list('task')
    const history = await this.loadHistory(chat)
    const first = userMsg(text, images)
    history.push(first)
    await this.appendTurn(first, chat, signal)

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
      helperModels: await this.helperModels(chat),
      liveHelpers: this.helpers?.live() ?? [],
      ...this.profilePrompt(),
      ...(await this.projectPrompt(chat)),
      ...(await this.deviceLine(chat)),
      promptRules: await promptRulesFor(this.store),
      environment: this.environment(),
      ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
    })
    const context = this.toolContext(signal, 'main', chat)
    const loop = new AgentLoop({ provider, model, tools: this.tools, interruptible: (call) => isInterruptible(call.name, call.input) })

    try {
      await loop.run(system, history, context, {
        onEvent: (event) => this.render(event, chat),
        onAppend: (message) => this.appendTurn(message, chat, signal),
        onAmend: (message) => this.amendTurn(line, message, signal),
        incoming: () => this.takeSteer(line),
        delivered: () => this.delivered(line),
        hasIncoming: () => this.urgentWaiting(line),
        bell: line.bell,
        notePrefix: '',
        signal,
      })
      if (signal.aborted) await this.notice('Stopped', chat)
      return undefined
    } catch (error) {
      if (signal.aborted) {
        await this.notice('Stopped', chat)
        return undefined
      }
      const message = friendlyError(error)
      await this.notice(message, chat)
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

  /**
   * What the prompt says about projects: in a project chat, the project it belongs to (its description, folder and
   * the profile its helpers use); in the main thread, the projects there are.
   */
  private async projectPrompt(chat: string): Promise<{ project?: ProjectContext | null; projectNames?: string[] }> {
    try {
      const projects = await this.store.list('project')
      const project = chat === MAIN_CHAT ? undefined : projects.find((each) => each.chats.includes(chat))
      if (project === undefined) return chat === MAIN_CHAT ? { projectNames: projects.filter((each) => !each.hidden).map((each) => each.name) } : {}
      const profiles = this.profilePrompt().profiles ?? []
      const profile = profiles.find((each) => each.id === project.profile) ?? profiles.find((each) => each.general)
      return {
        project: { id: project.id, name: project.name, description: project.description, path: project.path, profile: profile?.name ?? 'General' },
      }
    } catch {
      return {}
    }
  }

  /** This computer's settings, with the placing computer's commands-and-files choice for a chat placed here. */
  private settingsFor(chat: string): Settings {
    const own = this.settings.get()
    const shell = chat === MAIN_CHAT ? undefined : this.devices?.shellFor?.(chat)
    return shell === undefined ? own : { ...own, shell }
  }

  private async cliSystem(text: string, role: 'main' | 'routine', routineName: string | undefined, chat: string, cli: CliId): Promise<string> {
    const current = role === 'main' ? this.settingsFor(chat) : this.settings.get()
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
      helperModel: cli === 'codex' ? 'Codex' : 'Claude',
      helperModels: await this.helperModels(chat),
      liveHelpers: this.helpers?.live() ?? [],
      ...this.profilePrompt(),
      ...(role === 'main' ? await this.projectPrompt(chat) : {}),
      ...(role === 'main' ? await this.deviceLine(chat) : {}),
      canDelegate: this.helpers !== undefined,
      promptRules: await promptRulesFor(this.store),
      environment: this.environment(),
      ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
    })
  }

  private async runCliTurn(line: ChatLine, text: string, images: string[], signal: AbortSignal, brain: Brain & { kind: 'plan' }): Promise<string | undefined> {
    const chat = line.chat
    if (this.cli === undefined) {
      await this.notice('This build cannot run on a plan. Add an API key account in Settings to start.', chat)
      return undefined
    }
    // The turn has its own controller: Stop ends the whole run, a joined message only pauses this turn.
    const turn = new AbortController()
    const onStop = (): void => turn.abort()
    if (signal.aborted) turn.abort()
    else signal.addEventListener('abort', onStop, { once: true })
    line.turn = turn
    line.inflight.clear()
    line.pauseWhenSafe = false
    this.emitFor(chat, { type: 'thinking', step: 1 })
    // A message of his that arrived while this turn was being set up: handled now that there is a turn to reach.
    queueMicrotask(() => this.interruptPlan(line))
    let result: { text: string; error?: string }
    // A project chat works in its project's folder (the engine's working folder, with the access the person chose).
    const folder = chat === MAIN_CHAT ? '' : projectFolderOf(await this.store.list('project').catch(() => []), chat)
    try {
      result = await this.cli.turn({
        cli: brain.cli,
        thread: threadFor(chat),
        // His message rides with the result of the app tool in flight (a read is cut off for it; a change finishes).
        tools: withNoteTools(this.tools, {
          take: () => (turn.signal.aborted ? [] : this.takeForPlan(line)),
          bell: line.bell,
          interruptible: (name, input) => isInterruptible(name, input),
          onCut: () => void this.render({ type: 'interrupted', what: 'tool' }, chat),
        }),
        system: await this.cliSystem(text, 'main', undefined, chat, brain.cli),
        prompt: text,
        images,
        ...(brain.model === '' ? {} : { model: brain.model }),
        ...(folder === '' ? {} : { folder }),
        context: this.toolContext(turn.signal, 'main', chat),
        signal: turn.signal,
        onEvent: async (event) => {
          // The engine's own tools (its shell, file reads and edits): tracked so a changing one is never cut halfway.
          if (event.type === 'tool_started') this.planTool(line, event.call.id, event.call.name, event.call.input, true, false)
          await this.render(event, chat)
          if (event.type === 'tool_finished') this.planTool(line, event.call.id, event.call.name, event.call.input, false, false)
        },
        onCall: async (call) => {
          this.planTool(line, call.id, call.name, call.input, true, true)
          await this.startActivity({ t: 'call', id: call.id, name: call.name, input: call.input }, chat)
        },
        onResult: async (call, output, isError) => {
          await this.finishActivity({ t: 'call', id: call.id, name: call.name, input: call.input }, output, isError, chat)
          this.planTool(line, call.id, call.name, call.input, false, true)
        },
      })
    } finally {
      signal.removeEventListener('abort', onStop)
      if (line.turn === turn) line.turn = null
      line.inflight.clear()
      line.pauseWhenSafe = false
    }
    if (signal.aborted) {
      await this.notice('Stopped', chat)
      return undefined
    }
    // Paused for a joined message: the drive loop resumes the same session with it next.
    if (turn.signal.aborted) return undefined
    if (result.error !== undefined) {
      await this.notice(result.error, chat)
      return result.error
    }
    return undefined
  }

  private async runCliRoutine(trigger: TriggerRow, brain: Brain & { kind: 'plan' }): Promise<RoutineRunResult> {
    if (this.cli === undefined) return { text: 'This build cannot run routines on a plan.', waiting: false }
    const controller = this.routineController ?? new AbortController()
    this.routineController = controller
    const result = await this.cli.turn({
      cli: brain.cli,
      thread: 'routine',
      tools: this.tools,
      system: await this.cliSystem(trigger.prompt, 'routine', trigger.name, MAIN_CHAT, brain.cli),
      prompt: trigger.prompt,
      ...(brain.model === '' ? {} : { model: brain.model }),
      context: this.toolContext(controller.signal, 'routine'),
      signal: controller.signal,
      // Its steps show on its card (the engine's own tools and ours).
      onEvent: async (event) => {
        if (event.type === 'tool_started') this.routineStep(toolStepLabel(event.call.name))
      },
      onCall: async (call) => this.routineStep(toolStepLabel(call.name)),
      onResult: async () => undefined,
    })
    if (this.routineWaiting) return { text: WAITING_FOR_USER, waiting: true }
    if (result.error !== undefined) return { text: result.error, waiting: false, failed: true }
    const summary = result.text.trim()
    return { text: summary === '' ? 'The routine finished without a summary.' : summary, waiting: false }
  }

  /**
   * One plain model call with no tools, on whatever the person runs (their API key or their plan). Used to file a
   * chat into memory and for the end-of-day pass. Throws with a plain message when it cannot answer.
   */
  async oneShot(system: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const brain = mainBrain(this.brainDeps())
    if (!isBrain(brain)) throw new Error(brain.message)
    if (brain.kind === 'plan') {
      if (this.cli === undefined) throw new Error('This build cannot run on a plan.')
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      signal?.addEventListener('abort', abort)
      const timer = setTimeout(abort, 300_000)
      try {
        const result = await this.cli.turn({
          cli: brain.cli,
          thread: 'routine',
          tools: [],
          system,
          prompt,
          ...(brain.model === '' ? {} : { model: brain.model }),
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
    try {
      const completion = await brain.provider.complete(system, [userMsg(prompt)], [], brain.model, 8192)
      return msgText(completion.message)
    } catch (error) {
      throw new Error(friendlyError(error))
    }
  }

  /** The chosen plan's own sign-in, then the same tiny check. */
  /** The engine an account runs on: the account's own plan, else the old single choice. */
  private cliOf(accountId?: string): CliId {
    const account = accountId === undefined ? null : accountById(this.settings.get(), accountId)
    if (account !== null && account.kind !== 'api') return account.kind
    return this.settings.get().cli === 'codex' ? 'codex' : 'claude'
  }

  async planModels(accountId?: string): Promise<Array<{ id: string; label: string; line: string }>> {
    if (this.cli === undefined) return []
    return this.cli.models(this.cliOf(accountId))
  }

  async cliLogin(accountId?: string): Promise<{ ok: boolean; message: string }> {
    if (this.cli === undefined) return { ok: false, message: 'This build cannot run on a plan.' }
    const signedIn = await this.cli.login(this.cliOf(accountId), (url) => this.openUrl(url))
    if (!signedIn.ok) return signedIn
    return this.checkCli(accountId)
  }

  /** One tiny real turn, so onboarding and Settings can say whether the person's plan works here. */
  async checkCli(accountId?: string): Promise<{ ok: boolean; message: string }> {
    if (this.cli === undefined) return { ok: false, message: 'This build cannot run on a plan.' }
    const cli = this.cliOf(accountId)
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

  private async render(event: AgentEvent, chat: string = MAIN_CHAT): Promise<void> {
    switch (event.type) {
      case 'thinking':
        this.emitFor(chat, { type: 'thinking', step: event.step })
        return
      case 'said':
        await this.store.upsert('chat_item', { kind: 'agent', text: event.text, meta: JSON.stringify(chatTag(chat)) })
        this.emitFor(chat, { type: 'chat_changed' })
        return
      case 'tool_started':
        await this.startActivity(event.call, chat)
        return
      case 'tool_finished':
        await this.finishActivity(event.call, event.result, event.isError, chat)
        return
      case 'interrupted':
        // A small line of its own, so he sees his message was read at once.
        await this.store.upsert('chat_item', {
          kind: 'activity',
          text: event.what === 'model' ? 'Stopped thinking to read your new message' : 'Cut a read short to read your new message',
          meta: JSON.stringify({ tool: 'interrupted', status: 'done', line: true, summary: 'Read your new message at once', ...chatTag(chat) }),
        })
        this.emitFor(chat, { type: 'chat_changed' })
        return
    }
  }

  private async startActivity(call: ToolCallBlock, chat: string = MAIN_CHAT): Promise<void> {
    const summary = describeCall(call)
    // What it is running, so the row shows the command while it works.
    const run = runStarted(call)
    const row = await this.store.upsert('chat_item', {
      kind: 'activity',
      text: summary,
      meta: JSON.stringify({ tool: call.name, status: 'running', summary, ...(run === null ? {} : { run }), ...chatTag(chat) }),
    })
    this.activities.set(call.id, { id: row.id, text: summary, started: Date.now() })
    this.emitFor(chat, { type: 'chat_changed' })
  }

  private async finishActivity(call: ToolCallBlock, result: string, isError: boolean, chat: string = MAIN_CHAT): Promise<void> {
    const activity = this.activities.get(call.id)
    this.activities.delete(call.id)
    // An error line can quote the command or its output, so it is redacted like the run record.
    const summary = isError ? clip(redactSecrets(result.split('\n')[0] ?? result), MAX_RESULT_CHARS) : describeCall(call)
    const meta: JsonObject = { tool: call.name, status: isError ? 'error' : 'done', summary, ...chatTag(chat) }
    const run = await finishRun(call, result, isError, activity?.started ?? Date.now())
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
    this.emitFor(chat, { type: 'chat_changed' })
  }

  private async notice(text: string, chat: string = MAIN_CHAT): Promise<void> {
    // Quitting: a turn cut off now is resumed at the next start; no "Stopped" or error line for it.
    if (this.disposing) return
    await this.store.upsert('chat_item', { kind: 'notice', text, meta: JSON.stringify(chatTag(chat)) })
    this.emitFor(chat, { type: 'chat_changed' })
  }

  private async addUserItem(chat: string, text: string, meta: string): Promise<ChatItem> {
    const row = await this.store.upsert('chat_item', { kind: 'user', text, meta })
    this.emitFor(chat, { type: 'chat_changed' })
    return row
  }

  /** Merge fields into a row's meta. An empty string removes the field. */
  private async patchMeta(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = await this.store.get('chat_item', id)
    if (row === null) return
    const meta = parseMeta(row.meta)
    for (const [key, value] of Object.entries(patch)) {
      if (value === '') delete meta[key]
      else meta[key] = value
    }
    await this.store.upsert('chat_item', { id: row.id, kind: row.kind, text: row.text, meta: JSON.stringify(meta) })
  }

  private async appendTurn(message: Msg, chat: string = MAIN_CHAT, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return
    const row = await this.store.upsert('turn', { thread: threadFor(chat), json: JSON.stringify(msgToJson(message)) })
    this.line(chat).lastTurnId = row.id
  }

  /** The last transcript message gained a note (it rode with the tool results): store it with them. */
  private async amendTurn(line: ChatLine, message: Msg, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return
    if (line.lastTurnId === '') {
      await this.appendTurn(message, line.chat, signal)
      return
    }
    await this.store.upsert('turn', { id: line.lastTurnId, thread: threadFor(line.chat), json: JSON.stringify(msgToJson(message)) })
  }

  /** A plan turn takes every waiting note with an app tool's result; they are marked delivered at once. */
  private takeForPlan(line: ChatLine): string[] {
    const entries = line.steer.splice(0)
    if (entries.length === 0) return []
    line.pauseWhenSafe = false
    void this.markDelivered(entries)
    return entries.map((entry) => entry.text)
  }

  private async loadHistory(chat: string = MAIN_CHAT): Promise<Msg[]> {
    const thread = threadFor(chat)
    // New Chat takes everything before the newest divider out of context. Nothing is deleted: the agent can still
    // find it with chats_search. Each chat has its own dividers. Only this thread's turns since then are read.
    const since = latestDividerAt(await listWhere(this.store, 'chat_item', { kind: 'notice', chat }))
    const rows = await listWhere(this.store, 'turn', { thread, since })
    const messages: Msg[] = []
    for (const row of rows) {
      if (row.thread !== thread) continue
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

  /**
   * A tool run for an agent on another device (docs/devices-protocol.md s11): its questions and approvals show here
   * in the main chat and the answer goes back; its browser work gets a tab of its own.
   */
  deviceToolContext(signal: AbortSignal): ToolContext {
    return { ...this.toolContext(signal, 'main', MAIN_CHAT), agentLabel: 'another device', owner: 'device' }
  }

  private toolContext(signal: AbortSignal, role: 'main' | 'routine' = 'main', chat: string = MAIN_CHAT): ToolContext {
    return {
      agentLabel: role === 'routine' ? 'routine' : 'main',
      // Each chat drives its own browser tab, as each helper does.
      owner: browserOwnerOf(role, chat),
      ...(role === 'main' && chat !== MAIN_CHAT ? { chat } : {}),
      activity: async (text, meta) => {
        if (role === 'routine') {
          this.routineStep(text)
          return ++this.activitySeq
        }
        const id = ++this.activitySeq
        const row = await this.store.upsert('chat_item', {
          kind: 'activity',
          text,
          meta: JSON.stringify({ ...(meta ?? {}), status: 'running', ...chatTag(chat) }),
        })
        this.activityIds.set(id, row.id)
        this.emitFor(chat, { type: 'chat_changed' })
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
          meta: JSON.stringify({ ...(meta ?? {}), status: 'done', ...chatTag(chat) }),
        })
        this.emitFor(chat, { type: 'chat_changed' })
      },
      ask: (question, options, card) =>
        role === 'routine' ? this.askInRoutine(question, options) : this.ask(question, options, signal, chat, card),
      approve: (summary, details, scope) =>
        role === 'routine' ? this.approveInRoutine(summary, details) : this.approve(summary, details, signal, scope, chat),
      notify: async (title, body) => this.sendNotification(title, body, false),
      signal,
      ...this.placedShell(role, chat),
    }
  }

  private placedShell(role: 'main' | 'routine', chat: string): { shell?: 'always' | 'ask' | 'never' } {
    if (role !== 'main' || chat === MAIN_CHAT) return {}
    const shell = this.devices?.shellFor?.(chat)
    return shell === undefined ? {} : { shell }
  }

  private async ask(question: string, options: string[], signal: AbortSignal, chat: string = MAIN_CHAT, card?: JsonObject): Promise<string | null> {
    const line = this.line(chat)
    const row = await this.store.upsert('chat_item', {
      kind: 'question',
      text: question,
      // `card`: how the window draws it, when it is more than a question (a project to confirm, tools/projects.ts).
      meta: JSON.stringify({ options, answer: '', ...(card === undefined ? {} : { card }), ...chatTag(chat) }),
    })
    // Register the waiter before telling the UI: the person may answer the moment the card appears.
    const pending = new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (answer: string | null): void => {
        if (settled) return
        settled = true
        this.askWaiters.delete(row.id)
        line.waitingOn.delete(row.id)
        signal.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = (): void => finish(null)
      if (signal.aborted) {
        finish(null)
        return
      }
      this.askWaiters.set(row.id, finish)
      line.waitingOn.add(row.id)
      signal.addEventListener('abort', onAbort, { once: true })
    })

    this.waiting.set(row.id, chat)
    this.emitFor(chat, { type: 'chat_changed' })
    this.emitFor(chat, { type: 'needs_you', itemId: row.id })
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
    this.waiting.set(row.id, MAIN_CHAT)
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
    chat: string = MAIN_CHAT,
  ): Promise<boolean> {
    const line = this.line(chat)
    const row = await this.store.upsert('chat_item', {
      kind: 'approval',
      text: summary,
      meta: JSON.stringify({ summary, details: details ?? '', decision: '', ...(scope === undefined ? {} : { scope }), ...chatTag(chat) }),
    })
    // Register the waiter before telling the UI, so an instant decision finds it.
    const pending = new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (approved: boolean): void => {
        if (settled) return
        settled = true
        this.decisionWaiters.delete(row.id)
        line.waitingOn.delete(row.id)
        line.approving.delete(row.id)
        signal.removeEventListener('abort', onAbort)
        resolve(approved)
      }
      const onAbort = (): void => finish(false)
      if (signal.aborted) {
        finish(false)
        return
      }
      this.decisionWaiters.set(row.id, finish)
      line.waitingOn.add(row.id)
      line.approving.add(row.id)
      signal.addEventListener('abort', onAbort, { once: true })
    })

    this.waiting.set(row.id, chat)
    this.emitFor(chat, { type: 'chat_changed' })
    this.emitFor(chat, { type: 'needs_you', itemId: row.id })
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
    this.waiting.set(row.id, MAIN_CHAT)
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

/** What a resumed plan session reads first after it was paused for a joined message. */
const PAUSED_NOTE =
  '[You were paused mid-step so you could read the message below. Whatever you were doing in that last step may not have finished: check before you redo it.]'

/** Plain words for the chat when a provider call fails. Ported from friendlyError in AgentRuntime.kt. */
export function friendlyError(error: unknown): string {
  if (error instanceof ProviderException) {
    if (error.status === 401) return 'Your API key was rejected. Check it in Settings.'
    if (error.status === 429) {
      return 'The AI provider says we are sending too much right now (rate limit or out of credit). Try again shortly.'
    }
    // A provider that took too long says so (a helper's creator reads this as the reason it ended).
    if (error.status === 0 && /did not answer within/i.test(error.message)) return error.message
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
    case 'routine_update':
      return 'Changed a routine'
    case 'routine_delete':
      return 'Deleted a routine'
    case 'prompt_rules': {
      const action = stringField(input['action'])
      if (action === 'add') return 'Added a standing instruction'
      if (action === 'edit') return 'Changed a standing instruction'
      if (action === 'remove') return 'Removed a standing instruction'
      return 'Checked standing instructions'
    }
    case 'browser_close':
      return input['all'] === true ? 'Closed my browser tabs' : 'Closed a browser tab'
    case 'run_script':
      return input['background'] === true ? 'Started a script in the background' : 'Ran a script'
    case 'run_script_result':
      return 'Checked a background script'
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

/** What the store tells a listener (main/db.ts StoreChange), as far as the runner reads it. */
interface CardChange {
  entity: string
  row?: unknown
  id?: string
  deleted?: boolean
  reset?: boolean
}

/**
 * A question nobody has answered or an approval nobody has decided: the one rule for "waiting for you", the same as
 * the window's (renderer/lib/cards.ts isOpenCard), so the rail, Needs you, the tray and the phone always agree.
 */
export function isOpenCardRow(row: { kind: string; meta: string }): boolean {
  if (row.kind !== 'question' && row.kind !== 'approval') return false
  const meta = parseMeta(row.meta)
  if (row.kind === 'question') return !isSet(meta['answer'])
  return meta['decision'] !== 'approve' && meta['decision'] !== 'decline'
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A tool's name as a step line on a routine's card: "mcp__agent__web_fetch" reads "Using web fetch". */
export function toolStepLabel(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, '').replace(/[_-]+/g, ' ').trim()
  return bare === '' ? 'Working' : `Using ${bare.charAt(0).toLowerCase()}${bare.slice(1)}`
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}
