/**
 * The walk ("show me how", 10 Nov 2026): on whatever window he is on, ring the next thing to use, wait for HIS click,
 * ring the next. Nothing is ever clicked or typed for him. This is the loop, over a ScreenReader (./screen.ts; the
 * native layer gives the real one, tests a fake), an overlay that draws a ring at a screen rectangle, and a small
 * fast model that is only asked when the route's own names do not find the element.
 *
 * Why it is fast: a step names its element, so finding it is a lookup, not a model call. While he is still on step N
 * the element of step N+1 is already looked up when it is on screen, so his click puts the next ring up at once; when
 * it only appears after his click (a menu opening) the lookup is polled for a moment. The model is asked for a step
 * only after that fails, a picture of the window only after that, and the route is planned again from the screen at
 * most a couple of times before the label says what could not be found.
 *
 * Every rectangle here is in physical screen pixels, as the reader gives them; the overlay adapter converts to DIPs.
 * Pure of Electron.
 */
import { ClipboardFill, type ClipboardLike } from '../browser/guide'
import { contains } from './coords'
import type { GuideModel } from './guide-model'
import { LOCATE_SYSTEM, PICK_SYSTEM, PLAN_SYSTEM, locatePrompt, parseBox, parsePick, parsePlan, pickPrompt, planPrompt, pngSize, type ShowStep } from './planner'
import type { ActiveWindow, InputEvent, Rect, ScreenReader, UiNode } from './screen'

/** What draws the ring. Rectangles in physical pixels; the app's adapter (./overlay-adapter.ts) turns them into DIPs. */
export interface WalkOverlay {
  show(spec: { rect: Rect; label: string; step: number; of: number; fill?: { field: string; value?: string; sensitive?: boolean }; onAct?: (outcome: 'done' | 'skipped') => void }): void
  move(rect: Rect): void
  hide(): void
}

export type WalkOutcome = 'clicked' | 'pasted' | 'typed' | 'done' | 'skipped' | 'cancelled' | 'timeout'
/** How a step's element was found: the reader's own lookup, a match on the element list, looked up ahead of his click, the model, a picture, or not at all. */
export type FoundHow = 'find' | 'match' | 'prefetch' | 'model' | 'vision' | 'none'

export interface WalkStepLog {
  n: number
  label: string
  name: string
  role: string
  outcome: WalkOutcome
  how: FoundHow
  /** ms from the step's start until its ring was up. */
  foundMs: number
  /** ms from his action on the step before until this ring was up (null for the first ring). */
  ringMs: number | null
  /** ms the ring was up before he acted. */
  waitedMs: number
  /** Model calls this step needed (0 when the route's name found it). */
  modelCalls: number
  /** Clipboard fill: what became of the clipboard after. Never the value. */
  clipboard?: 'cleared' | 'restored' | 'kept' | 'left' | 'none'
  secret?: boolean
  at: number
}

export interface WalkResult {
  outcome: 'done' | 'cancelled' | 'timeout' | 'no_plan' | 'no_window'
  completed: number
  total: number
  steps: WalkStepLog[]
  /** The steps as walked (after any re-plan), without values. */
  route: Array<Pick<ShowStep, 'label' | 'name' | 'role' | 'nth'>>
  replans: number
  modelCalls: number
  /** Where the route came from. */
  planned: 'given' | 'skill' | 'model'
  note: string
}

export interface WalkTimings {
  /** How long the first step's element may take to appear. */
  firstFindMs: number
  /** How long a later step's element may take to appear after his action (a menu, a page). */
  nextFindMs: number
  pollMs: number
  /**
   * The screen has stopped changing for this long and the element is still not on it: waiting longer will not bring
   * it, so the model is asked now instead of at the end of the full wait.
   */
  settleMs: number
  /** After a ring that was looked up ahead: when it is checked against the screen as it is now. */
  recheckMs: number
  /** The whole walk's limit. */
  timeoutMs: number
  maxReplans: number
}

export const WALK_TIMINGS: WalkTimings = { firstFindMs: 1_200, nextFindMs: 1_800, pollMs: 60, settleMs: 350, recheckMs: 250, timeoutMs: 10 * 60_000, maxReplans: 2 }

export interface WalkKeys {
  stop(): void
  skip(): void
  done(): void
}

export interface WalkDeps {
  reader: ScreenReader
  overlay: WalkOverlay
  /** Null: no model can be asked. A route that was given still walks; nothing can be planned or picked. */
  model: GuideModel | null
  clipboard?: ClipboardLike
  clipboardClearMs?: number
  /** Holds the walk's keys (Esc, skip, I did it) while it runs; returns how to let them go. */
  holdKeys?: (keys: WalkKeys) => () => void
  /** What the first label is told about the keys: "Esc stops". */
  keyHint?: string
  now?: () => number
  onStep?: (event: { kind: 'start' | 'shown' | 'end'; n: number; total: number; step: ShowStep; log?: WalkStepLog }) => void
  timings?: Partial<WalkTimings>
}

export interface WalkInput {
  /** The window to walk on: the one that was in front when he asked. */
  window: ActiveWindow
  question: string
  /** A route that is already known (the screen_guide tool). Absent: it is planned from the skill and the screen. */
  steps?: ShowStep[]
  /** The matching skill page or learned app as text, '' for none. */
  skill?: string
  signal?: AbortSignal
}

interface Located {
  node: UiNode | null
  rect: Rect
  how: FoundHow
  hwnd: string
}

type Ended = { kind: WalkOutcome; at: number } | { kind: 'lost'; why: 'gone' | 'window' } | { kind: 'found'; located: Located }

const ROLE_KEYS: Array<[RegExp, string]> = [
  [/edit|textbox|text ?field|text ?area|searchbox|document|input/, 'textbox'],
  [/hyperlink|link/, 'link'],
  [/menu ?item/, 'menuitem'],
  [/tab ?item|tab/, 'tab'],
  [/check ?box/, 'checkbox'],
  [/combo ?box|drop ?down|listbox/, 'combobox'],
  [/radio/, 'radio'],
  [/list ?item|option/, 'listitem'],
  [/tree ?item/, 'treeitem'],
  [/button/, 'button'],
]

/** One word per kind of control, whatever the system calls it ("Edit", "SplitButton", "Hyperlink"). */
export function roleKey(role: string | undefined): string {
  const r = (role ?? '').toLowerCase()
  if (r === '') return ''
  for (const [pattern, key] of ROLE_KEYS) if (pattern.test(r)) return key
  return r
}

function plain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[….]+$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function usable(node: UiNode | null | undefined): node is UiNode {
  return node !== null && node !== undefined && !node.offscreen && node.bounds.width > 0 && node.bounds.height > 0
}

/**
 * The element a step names, from the element list, with no model: an exact name (of the right kind of control when
 * the step says one), else the one name that contains it. `sure` is false when several fit and the step gave no nth.
 */
export function matchNode(step: Pick<ShowStep, 'name' | 'role' | 'nth'>, nodes: UiNode[]): { node: UiNode; sure: boolean } | null {
  const want = plain(step.name)
  if (want === '') return null
  const visible = nodes.filter(usable)
  const role = roleKey(step.role)
  const ofRole = role === '' ? visible : visible.filter((node) => roleKey(node.role) === role)
  for (const pool of ofRole.length > 0 && ofRole.length < visible.length ? [ofRole, visible] : [visible]) {
    const exact = pool.filter((node) => plain(node.name) === want)
    const hits = exact.length > 0 ? exact : want.length >= 3 ? pool.filter((node) => plain(node.name).includes(want) || (plain(node.name).length >= 4 && want.includes(plain(node.name)))) : []
    if (hits.length === 0) continue
    if (step.nth !== undefined && step.nth > 0) return { node: hits[Math.min(hits.length, step.nth) - 1]!, sure: true }
    // An enabled one before a disabled one of the same name.
    const first = hits.find((node) => node.enabled) ?? hits[0]!
    return { node: first, sure: hits.length === 1 }
  }
  return null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** The label of a step whose element could not be found: he can still do it and say so. */
export function missingLabel(step: Pick<ShowStep, 'name'>): string {
  const name = step.name.length > 40 ? `${step.name.slice(0, 37)}...` : step.name
  return `Cannot find "${name}". Do it yourself, then press I did it`
}

export const PLANNING_LABEL = 'Working out the steps'

export class Walk {
  private readonly reader: ScreenReader
  private readonly overlay: WalkOverlay
  private readonly model: GuideModel | null
  private readonly now: () => number
  private readonly t: WalkTimings
  private readonly abort = new AbortController()
  private readonly fill: ClipboardFill | null
  private win: ActiveWindow
  private steps: ShowStep[] = []
  private cache: { hwnd: string; nodes: UiNode[]; stale: boolean } | null = null
  private readonly ahead = new Map<number, Located>()
  private calls = 0
  private replans = 0
  private ended: 'cancelled' | 'timeout' | null = null
  /** The step being waited on: how an input event ends it. */
  private waiting: { step: ShowStep; located: Located; rect: Rect; typed: number; focused: boolean; resolve: (ended: Ended) => void } | null = null
  private foregroundWaiter: (() => void) | null = null
  /** The program the walk is in. Another program in front makes the ring wait, unless his own action opened it. */
  private homePid: number
  private lastActAt: number | null = null

  constructor(
    private readonly deps: WalkDeps,
    private readonly input: WalkInput,
  ) {
    this.reader = deps.reader
    this.overlay = deps.overlay
    this.model = deps.model
    this.now = deps.now ?? Date.now
    this.t = { ...WALK_TIMINGS, ...(deps.timings ?? {}) }
    this.fill = deps.clipboard === undefined ? null : new ClipboardFill(deps.clipboard, deps.clipboardClearMs)
    this.win = input.window
    this.homePid = input.window.pid
  }

  /** Ends the walk now (Esc, the bar's Stop, the run that started it ending). */
  stop(): void {
    this.end('cancelled')
  }

  private end(why: 'cancelled' | 'timeout'): void {
    if (this.ended !== null) return
    this.ended = why
    // The ring goes the moment he stops, before anything else unwinds.
    this.overlay.hide()
    this.abort.abort()
    this.waiting?.resolve({ kind: why, at: this.now() })
    this.foregroundWaiter?.()
  }

  async run(): Promise<WalkResult> {
    const logs: WalkStepLog[] = []
    let planned: WalkResult['planned'] = 'given'
    let note = ''
    const outer = this.input.signal
    const onOuter = (): void => this.end('cancelled')
    if (outer?.aborted === true) this.end('cancelled')
    outer?.addEventListener('abort', onOuter, { once: true })
    const timer = setTimeout(() => this.end('timeout'), this.t.timeoutMs)
    const offInput = this.reader.onInput((event) => this.onInput(event))
    const release = this.deps.holdKeys?.({ stop: () => this.end('cancelled'), skip: () => this.act('skipped'), done: () => this.act('done') })
    let lastAct: number | null = null
    let finished = false
    try {
      if (this.input.steps !== undefined && this.input.steps.length > 0) {
        this.steps = [...this.input.steps]
      } else {
        planned = (this.input.skill ?? '').trim() === '' ? 'model' : 'skill'
        // The one moment a walk makes him wait: he is told so on the window itself.
        if (this.model !== null && this.ended === null) this.overlay.show({ rect: { ...this.win.bounds }, label: PLANNING_LABEL, step: 1, of: 1 })
        const plan = await this.plan()
        this.overlay.hide()
        this.steps = plan.steps
        note = plan.note
        if (this.steps.length === 0 && this.ended === null) {
          return this.result('no_plan', logs, planned, note !== '' ? note : this.model === null ? 'There is no model to plan the steps with.' : 'No steps could be planned for that from this window.')
        }
      }
      let gone = 0
      for (let i = 0; i < this.steps.length && this.ended === null; ) {
        if (this.win.pid !== this.homePid) {
          // He is in another program: nothing of it is read or sent anywhere, and the ring waits for him to come back.
          this.overlay.hide()
          await this.untilForeground()
          continue
        }
        const step = this.steps[i]!
        const n = i + 1
        const started = this.now()
        const callsBefore = this.calls
        this.deps.onStep?.({ kind: 'start', n, total: this.steps.length, step })
        let located = this.takeAhead(i)
        if (located === null) located = await this.locate(step, lastAct === null ? this.t.firstFindMs : this.t.nextFindMs, false)
        if (this.ended !== null) break
        if (located === null && this.model !== null && this.replans < this.t.maxReplans) {
          // The screen is not what the route expected: plan what is left from what IS on screen.
          this.replans++
          const again = await this.plan({ done: this.steps.slice(0, i).map((each) => each.label), missing: step.name })
          if (this.ended !== null) break
          if (again.steps.length > 0) {
            this.steps = [...this.steps.slice(0, i), ...again.steps]
            this.ahead.clear()
            continue
          }
        }
        const missing = located === null
        if (located === null) located = { node: null, rect: { ...this.win.bounds }, how: 'none', hwnd: this.win.hwnd }
        const fills = !missing && typeof step.value === 'string' && step.value !== ''
        if (fills && this.fill !== null) await this.fill.put(step.value!, step.sensitive === true)
        if (this.ended !== null) break
        const label = missing ? missingLabel(step) : n === 1 && (this.deps.keyHint ?? '') !== '' && !fills ? `${step.label} (${this.deps.keyHint})` : step.label
        const shownAt = this.now()
        const ended = await this.waitForHim(step, located, { label, n, fills, missing, still: gone > 3 })
        const clip = fills && this.fill !== null ? await this.fill.settle() : undefined
        if (ended.kind === 'found') {
          // It was not there, and now it is (a slow page): the real ring takes the place of the apology.
          this.ahead.set(i, ended.located)
          continue
        }
        if (ended.kind === 'lost') {
          // It went away without him using it (the page re-drew, or he switched windows): find it again.
          this.ahead.delete(i)
          this.overlay.hide()
          // A thing that keeps vanishing is not chased for ever: after a few times its ring is drawn where it was last.
          if (ended.why === 'gone') gone++
          continue
        }
        gone = 0
        const acted = ended.at
        const log: WalkStepLog = {
          n,
          label: step.label,
          name: step.name,
          role: located.node?.role ?? step.role ?? '',
          outcome: ended.kind,
          how: located.how,
          foundMs: shownAt - started,
          ringMs: lastAct === null ? null : Math.max(0, shownAt - lastAct),
          waitedMs: Math.max(0, acted - shownAt),
          modelCalls: this.calls - callsBefore,
          ...(clip === undefined ? {} : { clipboard: clip }),
          ...(step.sensitive === true ? { secret: true } : {}),
          at: Date.now(),
        }
        logs.push(log)
        this.deps.onStep?.({ kind: 'end', n, total: this.steps.length, step, log })
        if (ended.kind === 'cancelled' || ended.kind === 'timeout') break
        lastAct = acted
        this.lastActAt = acted
        // The ring stays up only when the next one replaces it in the same breath.
        if (!this.ahead.has(i + 1)) this.overlay.hide()
        i++
        if (i >= this.steps.length) finished = true
      }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
      offInput()
      release?.()
      this.overlay.hide()
      this.abort.abort()
      // Whatever ended the walk, a sensitive value never stays on his clipboard.
      await this.fill?.settle().catch(() => 'none')
    }
    return this.result(this.ended ?? (finished ? 'done' : 'cancelled'), logs, planned, note)
  }

  private result(outcome: WalkResult['outcome'], logs: WalkStepLog[], planned: WalkResult['planned'], note: string): WalkResult {
    const completed = logs.filter((log) => log.outcome !== 'cancelled' && log.outcome !== 'timeout').length
    return {
      outcome,
      completed,
      total: this.steps.length,
      steps: logs,
      route: this.steps.map((step) => ({ label: step.label, name: step.name, ...(step.role === undefined ? {} : { role: step.role }), ...(step.nth === undefined ? {} : { nth: step.nth }) })),
      replans: this.replans,
      modelCalls: this.calls,
      planned,
      note,
    }
  }

  // ---- his input ------------------------------------------------------------------------------------------------

  private act(outcome: 'done' | 'skipped'): void {
    this.waiting?.resolve({ kind: outcome, at: this.now() })
  }

  private onInput(event: InputEvent): void {
    if (this.ended !== null) return
    if (event.kind === 'foreground') {
      if (event.window.hwnd === this.win.hwnd) {
        this.win = event.window
      } else {
        // A window his own action just opened (a dialog, another program) is where the walk goes on.
        if (event.window.pid !== this.homePid && this.lastActAt !== null && this.now() - this.lastActAt < 2_000) this.homePid = event.window.pid
        this.win = event.window
        this.cache = null
        // A ring drawn for another window does not sit on top of this one.
        const w = this.waiting
        if (w !== null && w.located.hwnd !== event.window.hwnd) w.resolve({ kind: 'lost', why: 'window' })
      }
      this.foregroundWaiter?.()
      return
    }
    if (this.cache !== null) this.cache.stale = true
    const w = this.waiting
    if (event.kind === 'key' && event.key === 'Escape' && !event.ctrl && !event.alt) {
      // The hook saw Esc (the held shortcut may not be there): it ends the walk either way.
      this.end('cancelled')
      return
    }
    if (w === null) return
    const fills = typeof w.step.value === 'string' && w.step.value !== '' && w.located.how !== 'none'
    const at = this.now()
    if (event.kind === 'click') {
      if (event.button !== 'left' || w.located.how === 'none') return
      const inside = contains(w.rect, event.x, event.y, w.located.how === 'vision' ? 14 : 6)
      if (fills) {
        // His click into the field is not the step; what he puts in it is. Typing it himself counts once he leaves.
        if (inside) w.focused = true
        else if (w.typed > 0) w.resolve({ kind: 'typed', at })
        return
      }
      // A click anywhere else is his own business: it neither advances nor is it stopped.
      if (inside) w.resolve({ kind: 'clicked', at })
      return
    }
    if (!fills) return
    if (event.kind === 'paste' || (event.kind === 'key' && event.ctrl && !event.alt && event.key.toLowerCase() === 'v')) {
      w.resolve({ kind: 'pasted', at })
      return
    }
    if (event.kind === 'key' && !event.ctrl && !event.alt) {
      if (event.key.length === 1) w.typed++
      else if ((event.key === 'Enter' || event.key === 'Tab') && w.typed > 0) w.resolve({ kind: 'typed', at })
    }
  }

  private waitForHim(step: ShowStep, located: Located, show: { label: string; n: number; fills: boolean; missing: boolean; still?: boolean }): Promise<Ended> {
    return new Promise<Ended>((resolve) => {
      let stopWatch: (() => void) | null = null
      let recheck: ReturnType<typeof setTimeout> | null = null
      let seek: ReturnType<typeof setInterval> | null = null
      let settled = false
      const finish = (ended: Ended): void => {
        if (settled) return
        settled = true
        if (recheck !== null) clearTimeout(recheck)
        if (seek !== null) clearInterval(seek)
        try {
          stopWatch?.()
        } catch {
          // The reader let go of it already.
        }
        if (this.waiting === entry) this.waiting = null
        // Noted the moment he acts, so a window his action opens in the same breath is known to be his doing.
        if (ended.kind !== 'lost' && ended.kind !== 'found' && ended.kind !== 'cancelled' && ended.kind !== 'timeout') this.lastActAt = ended.at
        resolve(ended)
      }
      const entry = { step, located, rect: { ...located.rect }, typed: 0, focused: false, resolve: finish }
      if (this.ended !== null) return finish({ kind: this.ended, at: this.now() })
      this.waiting = entry
      this.overlay.show({
        rect: entry.rect,
        label: show.label,
        step: show.n,
        of: this.steps.length,
        ...(show.fills ? { fill: { field: step.name, ...(step.sensitive === true ? { sensitive: true } : { value: step.value! }) } } : {}),
        onAct: (outcome) => finish({ kind: outcome, at: this.now() }),
      })
      this.deps.onStep?.({ kind: 'shown', n: show.n, total: this.steps.length, step })
      const follow = (node: UiNode): void => {
        try {
          stopWatch?.()
        } catch {
          // Already stopped.
        }
        stopWatch = this.reader.watch(located.hwnd, node, (rect) => {
          if (settled) return
          if (rect === null || !(rect.width > 0) || !(rect.height > 0)) return finish({ kind: 'lost', why: 'gone' })
          entry.rect = { ...rect }
          this.overlay.move(entry.rect)
        })
      }
      if (located.node !== null && show.still !== true) follow(located.node)
      // Not found yet is not never: a slow page may still bring it, and then the ring goes where it belongs.
      if (show.missing) {
        seek = setInterval(() => {
          void this.locateCheap(step, true).then((hit) => {
            if (!settled && hit !== null) finish({ kind: 'found', located: hit })
          })
        }, Math.max(150, this.t.pollMs * 4))
      }
      // A ring that was looked up before his last click is checked against the screen as it is now.
      if (located.how === 'prefetch') {
        recheck = setTimeout(() => {
          void this.locateCheap(step).then((now) => {
            if (settled) return
            if (now === null) return finish({ kind: 'lost', why: 'gone' })
            if (now.node !== null && (located.node === null || now.node.id !== located.node.id)) {
              entry.located = now
              entry.rect = { ...now.rect }
              this.overlay.move(entry.rect)
              follow(now.node)
            }
          })
        }, this.t.recheckMs)
      }
      // While he reads this ring, the next one is already looked up.
      void this.lookAhead(show.n)
    })
  }

  /** Waits until some window comes to the front (or the walk ends): he went elsewhere, the ring waits for him. */
  private untilForeground(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ended !== null) return resolve()
      this.foregroundWaiter = () => {
        this.foregroundWaiter = null
        resolve()
      }
    })
  }

  // ---- finding a step's element ---------------------------------------------------------------------------------

  private async tree(fresh: boolean): Promise<UiNode[]> {
    const hwnd = this.win.hwnd
    if (!fresh && this.cache !== null && this.cache.hwnd === hwnd && !this.cache.stale) return this.cache.nodes
    let nodes: UiNode[] = []
    try {
      nodes = await this.reader.tree(hwnd, { max: 400, interactiveOnly: true })
    } catch {
      nodes = []
    }
    this.cache = { hwnd, nodes, stale: false }
    return nodes
  }

  private takeAhead(index: number): Located | null {
    const located = this.ahead.get(index) ?? null
    this.ahead.delete(index)
    return located !== null && located.hwnd === this.win.hwnd ? located : null
  }

  /** The element of the step after this one, looked up now with no model, so his click needs no wait. */
  private async lookAhead(n: number): Promise<void> {
    const index = n
    const next = this.steps[index]
    if (next === undefined || this.ahead.has(index)) return
    const located = await this.locateCheap(next)
    // Only kept while he is still on the step before it.
    if (located !== null && this.ended === null && this.waiting !== null && this.waiting.step === this.steps[index - 1] && this.steps[index] === next) this.ahead.set(index, { ...located, how: 'prefetch' })
  }

  /** One pass with no model and no waiting: the reader's own lookup, then a sure match on the element list. */
  private async locateCheap(step: ShowStep, fresh = false): Promise<Located | null> {
    const hwnd = this.win.hwnd
    try {
      const node = await this.reader.find(hwnd, { name: step.name, ...(step.role === undefined ? {} : { role: step.role }), ...(step.nth === undefined ? {} : { nth: step.nth }) })
      if (usable(node)) return { node, rect: { ...node.bounds }, how: 'find', hwnd }
    } catch {
      // The reader could not look: the list is tried.
    }
    const match = matchNode(step, await this.tree(fresh))
    return match !== null && match.sure ? { node: match.node, rect: { ...match.node.bounds }, how: 'match', hwnd } : null
  }

  /**
   * Finds a step's element: the cheap pass, polled for `waitMs` (it may only appear after his last action), then the
   * small model on the element list, then a picture of the window. Null when none of it finds the thing.
   */
  private async locate(step: ShowStep, waitMs: number, cheapOnly: boolean): Promise<Located | null> {
    const signal = this.abort.signal
    const until = this.now() + waitMs
    let unsure: UiNode | null = null
    let shape = ''
    let shapeSince = this.now()
    for (;;) {
      if (signal.aborted) return null
      const hit = await this.locateCheap(step)
      if (hit !== null) return hit
      if (signal.aborted) return null
      const nodes = await this.tree(true)
      const match = matchNode(step, nodes)
      if (match !== null) {
        if (match.sure) return { node: match.node, rect: { ...match.node.bounds }, how: 'match', hwnd: this.win.hwnd }
        unsure = match.node
        // Several fit: the model says which (or the first, with no model).
        break
      }
      const at = this.now()
      if (at >= until) break
      // What is on screen, as one string: when it stops changing, what his action brought is all there.
      const seen = `${this.win.hwnd}\n${nodes.map((node) => `${node.id}:${node.name}`).join('\n')}`
      if (seen !== shape) {
        shape = seen
        shapeSince = at
      } else if (nodes.length > 0 && at - shapeSince >= this.t.settleMs) break
      await sleep(this.t.pollMs, signal)
    }
    if (signal.aborted) return null
    const hwnd = this.win.hwnd
    const model = cheapOnly || this.win.pid !== this.homePid ? null : this.model
    if (model !== null) {
      const nodes = await this.tree(false)
      if (nodes.some(usable)) {
        try {
          this.calls++
          const picked = parsePick(await model.complete(PICK_SYSTEM, pickPrompt(step, this.win, nodes), { maxTokens: 40, signal }), nodes)
          if (usable(picked)) return { node: picked, rect: { ...picked.bounds }, how: 'model', hwnd }
        } catch {
          // No answer: the next thing is tried.
        }
      }
      if (signal.aborted) return null
      if (unsure === null && model.vision) {
        try {
          const png = await this.reader.capture({ hwnd })
          const size = pngSize(png)
          if (size !== null) {
            this.calls++
            const box = parseBox(await model.complete(LOCATE_SYSTEM, locatePrompt(step, size), { image: png, maxTokens: 120, signal }), size)
            if (box !== null) {
              // The picture is of the window: its pixels are the window's, scaled if the capture was.
              const kx = this.win.bounds.width / size.width
              const ky = this.win.bounds.height / size.height
              return { node: null, rect: { x: this.win.bounds.x + box.x * kx, y: this.win.bounds.y + box.y * ky, width: box.width * kx, height: box.height * ky }, how: 'vision', hwnd }
            }
          }
        } catch {
          // No picture, or the model takes none.
        }
      }
    }
    if (unsure !== null) return { node: unsure, rect: { ...unsure.bounds }, how: 'match', hwnd }
    return null
  }

  // ---- the route ------------------------------------------------------------------------------------------------

  private async plan(again?: { done: string[]; missing: string }): Promise<{ steps: ShowStep[]; note: string }> {
    if (this.model === null) return { steps: [], note: '' }
    const nodes = await this.tree(true)
    if (this.abort.signal.aborted) return { steps: [], note: '' }
    try {
      this.calls++
      const reply = await this.model.complete(PLAN_SYSTEM, planPrompt({ question: this.input.question, window: this.win, nodes, skill: this.input.skill ?? '', ...(again === undefined ? {} : again) }), { maxTokens: 1_200, signal: this.abort.signal })
      return parsePlan(reply)
    } catch (error) {
      return { steps: [], note: this.abort.signal.aborted ? '' : `The model did not answer (${error instanceof Error ? error.message.slice(0, 120) : 'no reply'}).` }
    }
  }
}

export function runWalk(deps: WalkDeps, input: WalkInput): Promise<WalkResult> {
  return new Walk(deps, input).run()
}

/** The tool's and the bar's account of a walk: one line per step with its timing. Never a value. */
export function formatWalk(result: WalkResult): string {
  const head =
    result.outcome === 'done'
      ? `He did all ${result.total} step${result.total === 1 ? '' : 's'} himself.`
      : result.outcome === 'cancelled'
        ? `Stopped at step ${Math.min(result.total, result.completed + 1)} of ${result.total}.`
        : result.outcome === 'timeout'
          ? `Timed out at step ${Math.min(result.total, result.completed + 1)} of ${result.total}.`
          : result.outcome === 'no_window'
            ? 'There was no window to guide on.'
            : 'No steps could be planned.'
  const lines = [`outcome: ${result.outcome}`, head, `route: ${result.planned}, model calls: ${result.modelCalls}, re-plans: ${result.replans}`]
  for (const step of result.steps) {
    const clip = step.clipboard === 'cleared' ? ', clipboard cleared' : step.clipboard === 'restored' ? ', his own clipboard is back' : ''
    lines.push(`${step.n}. ${step.label}: ${step.outcome} on ${step.role === '' ? '' : `${step.role} `}"${step.name}" (found by ${step.how}${step.ringMs === null ? '' : `, ring up ${step.ringMs} ms after his last action`}, he took ${Math.round(step.waitedMs / 100) / 10} s${clip})`)
  }
  const left = result.route.slice(result.steps.length)
  if (left.length > 0 && result.outcome !== 'done') lines.push(`Not reached: ${left.map((step) => step.label).join(' > ')}`)
  if (result.note !== '') lines.push(result.note)
  return lines.join('\n')
}
