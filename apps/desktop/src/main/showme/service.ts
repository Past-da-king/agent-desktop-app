/**
 * "Show me how" as the app runs it (10 Nov 2026): one walk at a time, started from the quick chat bar ("how do I
 * ...") or by an agent (the screen_guide tool), on the window that was in front when he asked.
 *
 *   - noteForeground(): called the moment the quick chat shortcut fires, BEFORE the bar takes the focus, so the walk
 *     knows which window he was on.
 *   - ask(question): the bar. Looks up the matching skill, starts the walk and answers at once; the bar closes and
 *     the ring appears on his window.
 *   - guide(request): an agent. Runs the walk to its end and answers with what he did.
 *
 * The walk itself is ./walk.ts; this file is who it runs for: the window, the skill, the model, the keys, the log.
 * Nothing of the screen is kept: the session log (the shape of browser/guide-log.ts, so a walk can become a skill
 * page) holds step names and outcomes only, in memory, for the last few walks.
 */
import type { ClipboardLike, GuideResult, GuideStep, StepLog, StepOutcome } from '../browser/guide'
import { GuideLog } from '../browser/guide-log'
import { SHOWME_IDLE, type ShowMeStart, type ShowMeState } from '../../shared/showme'
import type { GuideModel } from './guide-model'
import type { ShowStep } from './planner'
import type { ActiveWindow, ScreenReader } from './screen'
import { matchSkill, skillText, type SkillMatch, type SkillSource } from './skills'
import { Walk, formatWalk, type WalkKeys, type WalkOverlay, type WalkResult, type WalkStepLog, type WalkTimings } from './walk'

export interface ShowMeKeys {
  /** The shortcut that skips a step, as the setting holds it ('' = none). */
  skip: string
  /** The shortcut that says "I did it" ('' = none). */
  done: string
}

export interface ShowMeDeps {
  reader: ScreenReader
  /** The ring (./overlay-adapter.ts over main/overlay). Made once; hidden between walks. */
  overlay: WalkOverlay
  /** The small fast model for this walk, or why there is none. */
  model(): Promise<GuideModel | { message: string }>
  /** The memory pages and learned apps a route can come from. */
  sources(): Promise<SkillSource[]>
  clipboard?: ClipboardLike
  /** Holds one shortcut for as long as the walk runs; null when it cannot be held. */
  holdKey?: (accelerator: string, callback: () => void) => (() => void) | null
  keys?: () => ShowMeKeys
  /** "Ctrl+Alt+Right" from an accelerator, for the label. */
  formatKey?: (accelerator: string) => string
  onState?: (state: ShowMeState) => void
  log?: (message: string, detail?: Record<string, unknown>) => void
  now?: () => number
  timings?: Partial<WalkTimings>
  /** How long the window noted at the shortcut stays the one to walk on. */
  rememberMs?: number
}

export interface GuideRequest {
  question: string
  /** A route the agent already knows. Absent: planned from the matching skill and the screen. */
  steps?: ShowStep[]
  timeoutMs?: number
  owner?: string
}

const REMEMBER_MS = 2 * 60_000

export const NO_READER = 'Showing you on screen is not available on this computer yet. Your question was not sent anywhere.'
export const NO_WINDOW = 'There is no window to show you on. Click the window you mean, then ask again.'

export class ShowMeService {
  private readonly now: () => number
  private front: { window: ActiveWindow; at: number } | null = null
  private current: { walk: Walk; done: Promise<WalkResult> } | null = null
  private last: ShowMeState = { ...SHOWME_IDLE }
  readonly sessions = new GuideLog()

  constructor(private readonly deps: ShowMeDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * The quick chat shortcut fired: remember the window he is on before the bar takes its place. Never holds the bar
   * up: it answers within `maxMs` whether or not the reader did.
   */
  async noteForeground(maxMs = 150): Promise<void> {
    const read = (async (): Promise<void> => {
      try {
        const window = await this.deps.reader.activeWindow()
        if (window !== null) this.front = { window, at: this.now() }
      } catch {
        // Nothing to remember: a walk asks again when it starts.
      }
    })()
    await Promise.race([read, new Promise<void>((resolve) => setTimeout(resolve, maxMs).unref?.())])
  }

  state(): ShowMeState {
    return { ...this.last }
  }

  running(): boolean {
    return this.current !== null
  }

  stop(): void {
    this.current?.walk.stop()
  }

  private set(patch: Partial<ShowMeState>): void {
    this.last = { ...this.last, ...patch, at: this.now() }
    try {
      this.deps.onState?.({ ...this.last })
    } catch {
      // A listener's trouble is not the walk's.
    }
  }

  /**
   * The window to walk on. From the bar: the one noted at the shortcut while that is fresh (used once). Otherwise the
   * one in front now, which the reader never reports as one of the app's own windows.
   */
  private async window(fromBar: boolean): Promise<ActiveWindow | null> {
    const noted = this.front
    if (fromBar) this.front = null
    if (fromBar && noted !== null && this.now() - noted.at <= (this.deps.rememberMs ?? REMEMBER_MS)) return noted.window
    try {
      return await this.deps.reader.activeWindow()
    } catch {
      return null
    }
  }

  /** The skill page or learned app that fits this window and question, if any. */
  async skillFor(window: ActiveWindow, question: string): Promise<SkillMatch | null> {
    try {
      return matchSkill(await this.deps.sources(), window, question)
    } catch {
      return null
    }
  }

  /** The bar: start and answer at once. The walk goes on by itself; state() and onState say where it is. */
  async ask(question: string): Promise<ShowMeStart> {
    const asked = question.replace(/\s+/g, ' ').trim()
    if (asked === '') return { ok: false, message: 'Say what you want to be shown.' }
    const ready = await this.prepare(true)
    if (!ready.ok) {
      this.set({ ...SHOWME_IDLE, phase: 'ended', question: asked, message: ready.message })
      return ready
    }
    void this.run({ question: asked, owner: 'person' }, ready.window).catch((error) => {
      this.deps.log?.('Show me: the walk failed', { message: error instanceof Error ? error.message : String(error) })
    })
    return { ok: true, message: '' }
  }

  /** An agent: run the walk to its end. The answer is what he did, step by step; never a value. */
  async guide(request: GuideRequest, signal?: AbortSignal): Promise<string> {
    const ready = await this.prepare(false)
    if (!ready.ok) return ready.message
    const { result, session, skill } = await this.run(request, ready.window, signal)
    const lines = [formatWalk(result), `Window: ${ready.window.title || '(untitled)'} [${ready.window.process}]${ready.window.url === undefined ? '' : ` at ${ready.window.url}`}`, `session: ${session}`]
    if (skill !== null) lines.push(`Route from: ${skill.source.title}`)
    else if (result.outcome === 'done' && result.total > 1) lines.push('No skill page matched this window. To make the next walk here instant, save the route as a memory page of kind skill (name the program or site in the title, list the steps by the exact names on screen).')
    return lines.join('\n')
  }

  private async prepare(fromBar: boolean): Promise<{ ok: true; window: ActiveWindow; message: '' } | { ok: false; message: string }> {
    let available = false
    try {
      available = await this.deps.reader.available()
    } catch {
      available = false
    }
    if (!available) return { ok: false, message: NO_READER }
    const window = await this.window(fromBar)
    if (window === null) return { ok: false, message: NO_WINDOW }
    return { ok: true, window, message: '' }
  }

  private async run(request: GuideRequest, window: ActiveWindow, signal?: AbortSignal): Promise<{ result: WalkResult; session: string; skill: SkillMatch | null }> {
    // A new walk replaces the one before it.
    const before = this.current
    if (before !== null) {
      before.walk.stop()
      await before.done.catch(() => undefined)
    }
    const given = request.steps !== undefined && request.steps.length > 0
    this.set({ running: true, phase: given ? 'walking' : 'planning', question: request.question, step: 0, of: request.steps?.length ?? 0, label: '', message: '', failed: false })
    const [skill, model] = await Promise.all([given ? Promise.resolve(null) : this.skillFor(window, request.question), this.deps.model().catch((error): { message: string } => ({ message: error instanceof Error ? error.message : 'No model.' }))])
    const guideModel = 'complete' in model ? model : null
    const session = this.sessions.start({ owner: request.owner ?? 'agent', tabId: `screen:${window.hwnd}`, url: window.url ?? `app://${window.process}`, steps: (request.steps ?? []).map(asGuideStep) })
    const keys = this.deps.keys?.() ?? { skip: '', done: '' }
    const fmt = this.deps.formatKey ?? ((accelerator: string) => accelerator)
    const started = this.now()
    this.deps.log?.('Show me: walk started', { process: window.process, given, skill: skill?.source.title ?? '', why: skill?.why.join('; ') ?? '', model: guideModel?.name ?? '' })
    const walk = new Walk(
      {
        reader: this.deps.reader,
        overlay: this.deps.overlay,
        model: guideModel,
        ...(this.deps.clipboard === undefined ? {} : { clipboard: this.deps.clipboard }),
        holdKeys: (handlers) => this.holdKeys(handlers, keys),
        keyHint: `Esc stops${keys.skip === '' ? '' : `, ${fmt(keys.skip)} skips`}`,
        now: this.now,
        ...(this.deps.timings === undefined && request.timeoutMs === undefined ? {} : { timings: { ...(this.deps.timings ?? {}), ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) } }),
        onStep: (event) => {
          if (event.kind === 'start') this.sessions.stepStarted(session.id, event.n)
          if (event.kind === 'shown') this.set({ phase: 'walking', step: event.n, of: event.total, label: event.step.label })
          if (event.kind === 'end' && event.log !== undefined) this.sessions.stepEnded(session.id, asStepLog(event.log, window))
        },
      },
      { window, question: request.question, ...(given ? { steps: request.steps! } : {}), skill: skillText(skill), ...(signal === undefined ? {} : { signal }) },
    )
    const done = walk.run()
    const entry = { walk, done }
    this.current = entry
    let result: WalkResult
    try {
      result = await done
    } finally {
      if (this.current === entry) this.current = null
    }
    if (result.outcome === 'no_plan' && guideModel === null && 'message' in model) result = { ...result, note: model.message }
    // The route as walked is what a skill page would hold: names and labels, never a value.
    session.steps = result.route.map((step) => asGuideStep(step))
    session.total = result.total
    this.sessions.end(session.id, asGuideResult(result, window))
    this.deps.log?.('Show me: walk ended', { outcome: result.outcome, steps: result.total, done: result.completed, modelCalls: result.modelCalls, replans: result.replans, planned: result.planned, ms: this.now() - started, rings: result.steps.map((step) => step.ringMs ?? -1).join(',') })
    if (this.current === null) this.set({ running: false, phase: 'ended', message: endLine(result), failed: result.outcome === 'no_plan' })
    return { result, session: session.id, skill }
  }

  private holdKeys(handlers: WalkKeys, keys: ShowMeKeys): () => void {
    const hold = this.deps.holdKey
    if (hold === undefined) return () => undefined
    const held = [hold('Escape', handlers.stop), keys.skip === '' ? null : hold(keys.skip, handlers.skip), keys.done === '' ? null : hold(keys.done, handlers.done)]
    return () => {
      for (const release of held) release?.()
    }
  }

  dispose(): void {
    this.stop()
    this.deps.overlay.hide()
  }
}

/** What the bar says when a walk is over. */
export function endLine(result: WalkResult): string {
  switch (result.outcome) {
    case 'done':
      return `Done: ${result.total} step${result.total === 1 ? '' : 's'}.`
    case 'cancelled':
      return result.completed === 0 ? 'Stopped.' : `Stopped after ${result.completed} of ${result.total} steps.`
    case 'timeout':
      return 'It timed out. Ask again to carry on.'
    case 'no_window':
      return NO_WINDOW
    case 'no_plan':
      return result.note !== '' ? result.note : 'I could not work out the steps for that on this window.'
  }
}

function asGuideStep(step: Pick<ShowStep, 'label' | 'name' | 'role' | 'nth'>): GuideStep {
  return { label: step.label, target: { name: step.name, ...(step.role === undefined ? {} : { role: step.role }), ...(step.nth === undefined ? {} : { nth: step.nth }) } }
}

function asOutcome(outcome: WalkStepLog['outcome']): StepOutcome {
  return outcome === 'pasted' ? 'typed' : outcome
}

function asStepLog(log: WalkStepLog, window: ActiveWindow): StepLog {
  return {
    n: log.n,
    label: log.label,
    outcome: asOutcome(log.outcome),
    target: `${log.role === '' ? '' : `${log.role} `}"${log.name}"`,
    role: log.role,
    name: log.name,
    frame: '',
    foundMs: log.foundMs,
    waitedMs: log.waitedMs,
    returnMs: null,
    at: log.at,
    url: window.url ?? '',
    ...(log.outcome === 'pasted' ? { pasted: true } : {}),
    ...(log.clipboard === undefined ? {} : { clipboard: log.clipboard }),
    ...(log.secret === true ? { secret: true } : {}),
    note: `found by ${log.how}${log.ringMs === null ? '' : `, ring up ${log.ringMs} ms after his last action`}`,
  }
}

function asGuideResult(result: WalkResult, window: ActiveWindow): GuideResult {
  const outcome: StepOutcome = result.outcome === 'done' ? 'done' : result.outcome === 'timeout' ? 'timeout' : result.outcome === 'cancelled' ? 'cancelled' : 'not_found'
  return { outcome, completed: result.completed, total: result.total, steps: result.steps.map((log) => asStepLog(log, window)), url: window.url ?? '', title: window.title, dialogs: [], jsDialog: '', text: '', note: result.note }
}
