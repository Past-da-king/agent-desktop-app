/**
 * Guided click-through (26 Oct 2026): "my click is the feedback". For the rare step a site will only take from a
 * real person (a sign-in, consent, a site that blocks automation, or he asks "show me"), the agent highlights the ONE
 * thing to use next in the app's own browser, his own click or typing tells it the step is done, and the next one
 * lights up at once. Nothing is clicked for him.
 *
 * This is the loop, over a GuideHost (guide-host.ts gives the real one, over the tab's debugger and every frame of
 * it, cross-site frames included; tests give a fake or a Playwright page). Pure of Electron.
 */
import { guideClearScript, guideFindScript, guideShowScript, parseMatches, parseShow, PICK_ATTR, type GuideQuery, type ShowResult } from './guide-page'

export interface GuideTarget {
  name?: string
  role?: string
  nth?: number
  /** A number from browser_snapshot. */
  index?: number
  selector?: string
}

export interface GuideStep {
  target: GuideTarget
  /** A few words, e.g. "Click Create Pixel". */
  label: string
  /**
   * Clipboard fill: what goes in this field. It is put on his clipboard and the label says so; his paste ends the step.
   * A Vault value ({{vault:REF}}) or one marked sensitive is never shown, logged or saved, and the clipboard is cleared.
   */
  value?: string
  sensitive?: boolean
}

/** The system clipboard, as the guide uses it (Electron's in the app; a fake in tests). */
export interface ClipboardLike {
  read(): Promise<string> | string
  write(text: string): Promise<void> | void
  clear(): Promise<void> | void
}

export const CLIPBOARD_CLEAR_MS = 30_000

/**
 * One value on his clipboard for one step. A sensitive value is cleared the moment he has pasted it, or after
 * CLIPBOARD_CLEAR_MS, whichever is first, and only while the clipboard still holds it (something he copied since is
 * never wiped). After a plain value, what he had on it before goes back.
 */
export class ClipboardFill {
  private value: string | null = null
  private sensitive = false
  private previous = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly clipboard: ClipboardLike,
    private readonly clearMs: number = CLIPBOARD_CLEAR_MS,
  ) {}

  async put(value: string, sensitive: boolean): Promise<void> {
    await this.settle()
    let before = ''
    try {
      before = await this.clipboard.read()
    } catch {
      before = ''
    }
    this.previous = sensitive ? '' : before
    this.value = value
    this.sensitive = sensitive
    await this.clipboard.write(value)
    if (sensitive) {
      this.timer = setTimeout(() => void this.clearIfOurs(), this.clearMs)
      this.timer.unref?.()
    }
  }

  /** Is our value still on the clipboard? */
  async holdsOurs(): Promise<boolean> {
    if (this.value === null) return false
    try {
      return (await this.clipboard.read()) === this.value
    } catch {
      return false
    }
  }

  /** The step is over: 'cleared' (sensitive), 'restored' (his earlier clipboard back), 'kept', 'left' (he copied something since). */
  async settle(): Promise<'cleared' | 'restored' | 'kept' | 'left' | 'none'> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.value === null) return 'none'
    const ours = await this.holdsOurs()
    const sensitive = this.sensitive
    const previous = this.previous
    this.value = null
    this.previous = ''
    if (!ours) return 'left'
    if (sensitive) {
      await this.clipboard.clear()
      return 'cleared'
    }
    if (previous !== '') {
      await this.clipboard.write(previous)
      return 'restored'
    }
    return 'kept'
  }

  private async clearIfOurs(): Promise<void> {
    this.timer = null
    if (this.sensitive && (await this.holdsOurs())) await this.clipboard.clear()
  }
}

/** The label of a clipboard-fill step: what is on it for a plain value, only the field for a sensitive one. */
export function fillLabel(step: GuideStep, pasteKey = 'Ctrl+V'): string {
  const field = (step.target.name ?? '').trim() || step.label.replace(/^(type|enter|fill in|paste)\s+/i, '').trim() || 'This field'
  if (step.sensitive === true) return `${field}: on your clipboard, press ${pasteKey}`
  const value = (step.value ?? '').replace(/\s+/g, ' ')
  return `${field}: ${value.length > 40 ? `${value.slice(0, 39)}...` : value}, press ${pasteKey}`
}

export type StepOutcome = 'clicked' | 'typed' | 'done' | 'skipped' | 'navigated' | 'timeout' | 'cancelled' | 'not_found'

export interface StepLog {
  n: number
  label: string
  outcome: StepOutcome
  /** role "name" of what was highlighted. */
  target: string
  role: string
  name: string
  /** The frame it was in ('' for the top page). */
  frame: string
  /** ms from the step's start until its ring was up. */
  foundMs: number
  /** ms the ring was up before he acted. */
  waitedMs: number
  /** ms from his action in the page until the guide had it (his click to the tool knowing). */
  returnMs: number | null
  /** Clipboard fill: he pasted, and what became of the clipboard after. */
  pasted?: boolean
  clipboard?: 'cleared' | 'restored' | 'kept' | 'left' | 'none'
  /** Epoch ms of his action (the page's clock). */
  at: number
  url: string
  value?: string
  secret?: boolean
  early?: boolean
  box?: { x: number; y: number; width: number; height: number }
  candidates?: string[]
  note?: string
}

export interface GuideResult {
  outcome: StepOutcome
  completed: number
  total: number
  steps: StepLog[]
  url: string
  title: string
  dialogs: string[]
  jsDialog: string
  text: string
  note: string
}

export interface GuideFrame {
  key: string
  url: string
  /** The top page. */
  top: boolean
}

export interface GuideHost {
  /** Every frame of the page now, the top one first (cross-site frames included). */
  frames(): Promise<GuideFrame[]>
  /** Runs a guide script in a frame's guide world and awaits its promise. Rejects when the frame's document goes. */
  evaluate(frame: string, code: string): Promise<unknown>
  /** Marks a snapshot number for the guide; false when that number is stale. */
  markIndex?(index: number, token: string): Promise<boolean>
  /** url, title, open dialogs and the start of the text of the top page. */
  page(): Promise<{ url: string; title: string; dialogs: string[]; text: string }>
  /** The top page started to go somewhere else (a link, a form, a redirect). */
  onNavigate(listener: () => void): () => void
  /** A native alert, confirm or prompt opened. */
  onJsDialog?(listener: (message: string) => void): () => void
  /** True while the page is loading. */
  loading(): boolean
  /** Waits for the new document to be ready, at most ms. */
  ready(ms: number): Promise<void>
  /** Called with each step as it starts and ends (the step log, the panel's line). */
  now?(): number
}

export interface GuideOptions {
  /** The whole guide's limit. Default 5 minutes. */
  timeoutMs?: number
  /** How long a target may take to appear: the first step, and steps after his action (a navigation, a dialog). */
  firstFindMs?: number
  nextFindMs?: number
  signal?: AbortSignal
  onStep?: (event: { kind: 'start' | 'shown' | 'end'; n: number; step: GuideStep; log?: StepLog }) => void
  /** Token prefix for the page's overlay, so a later guide's clear never ends this one by mistake. */
  token?: string
  /** Clipboard fill (steps with a value). Without it a value is only shown in the label. */
  clipboard?: ClipboardLike
  clipboardClearMs?: number
  /** What his paste key is called on this computer. */
  pasteKey?: string
}

export const GUIDE_TIMEOUT_MS = 5 * 60_000
const FIND_EVERY_MS = 120

/** Runs the steps: highlight one, wait for him, next. Returns the moment it ends, with a log of every step. */
export async function runGuide(host: GuideHost, steps: GuideStep[], options: GuideOptions = {}): Promise<GuideResult> {
  const now = host.now ?? Date.now
  const deadline = now() + Math.max(1_000, options.timeoutMs ?? GUIDE_TIMEOUT_MS)
  const logs: StepLog[] = []
  const token = options.token ?? `g${Math.random().toString(36).slice(2, 8)}`
  let jsDialog = ''
  const offDialog = host.onJsDialog?.((message) => {
    jsDialog = message.slice(0, 200)
  })
  let final: StepOutcome = 'done'
  let note = ''
  const fill = options.clipboard === undefined ? null : new ClipboardFill(options.clipboard, options.clipboardClearMs)
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      const n = i + 1
      const started = now()
      options.onStep?.({ kind: 'start', n, step })
      const stepToken = `${token}-${n}`
      const findLimit = Math.min(deadline, started + (i === 0 ? (options.firstFindMs ?? 3_000) : (options.nextFindMs ?? 5_000)))
      const found = await findTarget(host, step.target, stepToken, findLimit, options.signal, now)
      if (options.signal?.aborted === true) {
        final = 'cancelled'
        logs.push(blank(n, step, 'cancelled', now() - started))
        break
      }
      if (!found.ok) {
        const log = blank(n, step, 'not_found', now() - started)
        log.note = found.reason
        if (found.candidates.length > 0) log.candidates = found.candidates
        logs.push(log)
        options.onStep?.({ kind: 'end', n, step, log })
        final = 'not_found'
        note = `Step ${n} (${step.label}): ${found.reason}`
        break
      }
      const fills = typeof step.value === 'string' && step.value !== ''
      const shown: GuideStep = fills ? { ...step, label: fillLabel(step, options.pasteKey) } : step
      if (fills && fill !== null) await fill.put(step.value!, step.sensitive === true)
      const shownAt = now()
      options.onStep?.({ kind: 'shown', n, step: shown })
      const outcome = await waitForHim(host, found, shown, n, steps.length, stepToken, deadline, options.signal, now, fills ? { paste: true, ...(step.sensitive === true ? { secret: true } : { expect: step.value! }) } : {})
      const clip = fills && fill !== null ? await fill.settle() : undefined
      const gotAt = now()
      const log: StepLog = {
        n,
        label: shown.label,
        outcome: outcome.outcome,
        target: outcome.show?.target ?? found.describe,
        role: outcome.show?.role ?? '',
        name: outcome.show?.name ?? '',
        frame: found.frame.top ? '' : found.frame.url,
        foundMs: shownAt - started,
        waitedMs: Math.max(0, (outcome.show?.at ?? gotAt) - shownAt),
        returnMs: outcome.show !== null && ['clicked', 'typed', 'done', 'skipped'].includes(outcome.outcome) ? Math.max(0, gotAt - outcome.show.at) : null,
        at: outcome.show?.at ?? gotAt,
        url: '',
        ...(outcome.show?.value === undefined || step.sensitive === true ? {} : { value: outcome.show.value }),
        ...(outcome.show?.secret === true || step.sensitive === true ? { secret: true } : {}),
        ...(outcome.show?.pasted === true ? { pasted: true } : {}),
        ...(clip === undefined ? {} : { clipboard: clip }),
        ...(outcome.show?.early === true ? { early: true } : {}),
        ...(outcome.show?.box === undefined ? {} : { box: outcome.show.box }),
      }
      // The ring goes the moment the step is over, whatever ended it.
      void host.evaluate(found.frame.key, guideClearScript(stepToken)).catch(() => undefined)
      if (outcome.outcome === 'clicked' || outcome.outcome === 'typed' || outcome.outcome === 'done' || outcome.outcome === 'navigated') {
        // A click that navigates: the next page's document first (bounded), so the result names where he is now.
        await settle(host, outcome.outcome === 'navigated')
      }
      log.url = await host.page().then((p) => p.url).catch(() => '')
      logs.push(log)
      options.onStep?.({ kind: 'end', n, step, log })
      if (outcome.outcome === 'timeout' || outcome.outcome === 'cancelled') {
        final = outcome.outcome
        break
      }
      final = outcome.outcome
      if (jsDialog !== '' && i < steps.length - 1) {
        // A native alert or confirm blocks the page: the next step cannot be found until it is answered.
        note = `The page opened a dialog saying "${jsDialog}". Deal with it before the next step.`
        break
      }
    }
  } finally {
    offDialog?.()
    // Whatever ended the guide, a sensitive value never stays on his clipboard.
    await fill?.settle().catch(() => 'none')
  }
  const page = await host.page().catch(() => ({ url: '', title: '', dialogs: [] as string[], text: '' }))
  const completed = logs.filter((log) => ['clicked', 'typed', 'done', 'skipped', 'navigated'].includes(log.outcome)).length
  if (final === 'timeout' && note === '') note = `He did not act on step ${logs.length} within the time limit.`
  return { outcome: final, completed, total: steps.length, steps: logs, url: page.url, title: page.title, dialogs: page.dialogs, jsDialog, text: page.text, note }
}

interface Found {
  ok: true
  frame: GuideFrame
  query: GuideQuery
  mode: 'exact' | 'partial'
  pick: number
  describe: string
}

interface NotFound {
  ok: false
  reason: string
  candidates: string[]
}

/** The query a frame runs: a snapshot number becomes the mark it leaves on its element. */
function queryOf(target: GuideTarget, token: string): GuideQuery {
  if (target.index !== undefined) return { selector: `[${PICK_ATTR}="${token}"]` }
  if (target.selector !== undefined && target.selector.trim() !== '') return { selector: target.selector.trim() }
  return { name: target.name ?? '', ...(target.role === undefined ? {} : { role: target.role }) }
}

/**
 * Finds the target live in every frame (waiting briefly for it to appear), the way browser_act picks: exact names
 * before partial ones, nth across all frames in page order. Several with no nth is a miss with the candidates listed.
 */
export async function findTarget(host: GuideHost, target: GuideTarget, token: string, until: number, signal: AbortSignal | undefined, now: () => number = Date.now): Promise<Found | NotFound> {
  if (target.index === undefined && (target.selector ?? '').trim() === '' && (target.name ?? '').trim() === '') {
    return { ok: false, reason: 'Say which element: its name (and role), a CSS selector or its snapshot number.', candidates: [] }
  }
  if (target.index !== undefined) {
    const marked = host.markIndex === undefined ? false : await host.markIndex(target.index, token).catch(() => false)
    if (!marked) return { ok: false, reason: `Number ${target.index} is not on the page any more (it re-rendered). Use the name instead.`, candidates: [] }
  }
  const query = queryOf(target, token)
  const nth = target.nth !== undefined && target.nth > 0 ? Math.floor(target.nth) : 0
  let candidates: string[] = []
  for (;;) {
    if (signal?.aborted === true) return { ok: false, reason: 'Stopped.', candidates: [] }
    const frames = await host.frames().catch(() => [] as GuideFrame[])
    const per: Array<{ frame: GuideFrame; exact: number; partial: number; items: string[] }> = []
    for (const frame of frames) {
      try {
        const m = parseMatches(await host.evaluate(frame.key, guideFindScript(query)))
        if (m.bad !== undefined) return { ok: false, reason: m.bad, candidates: [] }
        per.push({ frame, ...m })
      } catch {
        // A frame between documents: it is asked again on the next pass.
      }
    }
    const exactTotal = per.reduce((sum, f) => sum + f.exact, 0)
    const partialTotal = per.reduce((sum, f) => sum + f.partial, 0)
    const mode: 'exact' | 'partial' = exactTotal > 0 ? 'exact' : 'partial'
    const total = mode === 'exact' ? exactTotal : partialTotal
    candidates = per.flatMap((f) => f.items).slice(0, 8)
    if (total === 1 || (total > 1 && (nth > 0 || query.selector !== undefined))) {
      let want = Math.min(total, Math.max(1, nth || 1))
      for (const f of per) {
        const count = mode === 'exact' ? f.exact : f.partial
        if (want <= count) {
          const item = mode === 'exact' ? f.items[want - 1] : f.items[f.exact + want - 1]
          return { ok: true, frame: f.frame, query, mode, pick: want - 1, describe: item ?? '' }
        }
        want -= count
      }
    }
    if (total > 1) {
      return { ok: false, reason: `Several elements match "${target.name ?? target.selector ?? ''}". Add role or nth (1 = first).`, candidates }
    }
    if (now() >= until) {
      const what = target.index !== undefined ? `number ${target.index}` : target.selector !== undefined && target.selector !== '' ? `the selector ${target.selector}` : `"${target.name ?? ''}"${target.role === undefined ? '' : ` with role ${target.role}`}`
      return { ok: false, reason: `Nothing on the page is ${what}.`, candidates }
    }
    await sleep(FIND_EVERY_MS, signal)
  }
}

async function waitForHim(
  host: GuideHost,
  found: Found,
  step: GuideStep,
  n: number,
  total: number,
  token: string,
  deadline: number,
  signal: AbortSignal | undefined,
  now: () => number,
  extra: { paste?: boolean; expect?: string; secret?: boolean } = {},
): Promise<{ outcome: StepOutcome; show: ShowResult | null }> {
  const show = host
    .evaluate(found.frame.key, guideShowScript({ token, query: found.query, mode: found.mode, pick: found.pick, label: step.label, step: n, total, ...extra }))
    .then((value) => ({ kind: 'show' as const, show: parseShow(value) }))
    .catch(() => ({ kind: 'gone' as const }))
  const cleanups: Array<() => void> = []
  const navigated = new Promise<{ kind: 'nav' }>((resolve) => {
    cleanups.push(host.onNavigate(() => resolve({ kind: 'nav' })))
  })
  const timedOut = new Promise<{ kind: 'timeout' }>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, deadline - now()))
    cleanups.push(() => clearTimeout(timer))
  })
  const aborted = new Promise<{ kind: 'abort' }>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) resolve({ kind: 'abort' })
    const on = (): void => resolve({ kind: 'abort' })
    signal.addEventListener('abort', on, { once: true })
    cleanups.push(() => signal.removeEventListener('abort', on))
  })
  try {
    let first = await Promise.race([show, navigated, timedOut, aborted])
    if (first.kind === 'nav') {
      // His click on the target may be what navigated: its answer is a few ms behind the navigation's start.
      const late = await Promise.race([show, sleep(250).then(() => null)])
      if (late !== null && late.kind === 'show' && late.show.outcome !== 'lost' && late.show.outcome !== 'cancelled') first = late
    }
    switch (first.kind) {
      case 'show':
        if (first.show.outcome === 'lost') return { outcome: 'not_found', show: first.show }
        return { outcome: first.show.outcome, show: first.show }
      case 'gone':
      case 'nav':
        return { outcome: 'navigated', show: null }
      case 'timeout':
        return { outcome: 'timeout', show: null }
      case 'abort':
        return { outcome: 'cancelled', show: null }
    }
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
  return { outcome: 'cancelled', show: null }
}

async function settle(host: GuideHost, navigating: boolean): Promise<void> {
  // A click starts its navigation a moment after the click event; give it that moment, then wait for the document.
  await sleep(navigating ? 0 : 120)
  if (navigating || host.loading()) await host.ready(3_000).catch(() => undefined)
}

function blank(n: number, step: GuideStep, outcome: StepOutcome, foundMs: number): StepLog {
  return { n, label: step.label, outcome, target: '', role: '', name: '', frame: '', foundMs, waitedMs: 0, returnMs: null, at: Date.now(), url: '' }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** The tool's answer: one line per step with its timing, then where the page is now. */
export function formatGuide(result: GuideResult, session: string): string {
  const lines: string[] = []
  const head =
    result.outcome === 'not_found'
      ? `Stopped at step ${result.steps.length} of ${result.total}: the page was not what I expected.`
      : result.outcome === 'timeout'
        ? `Timed out at step ${result.steps.length} of ${result.total}.`
        : result.outcome === 'cancelled'
          ? `Cancelled at step ${result.steps.length} of ${result.total}.`
          : `${result.completed} of ${result.total} step${result.total === 1 ? '' : 's'} done by him (last: ${result.outcome}).`
  lines.push(`outcome: ${result.outcome}`, head, `session: ${session} (browser_guide_log shows the requests each step sent; browser_guide_save_app turns it into a learned app)`)
  for (const step of result.steps) {
    const timing = step.returnMs === null ? '' : `, his action reached me in ${step.returnMs} ms`
    const value = step.secret === true ? ' (typed: hidden)' : step.value !== undefined && step.value !== '' ? ` (typed "${step.value.slice(0, 60)}")` : ''
    const clip = step.pasted === true ? `, he pasted it${step.clipboard === 'cleared' ? ' and the clipboard was cleared' : step.clipboard === 'restored' ? ' and his own clipboard is back' : ''}` : step.clipboard === 'cleared' ? ', clipboard cleared' : ''
    const where = step.frame === '' ? '' : ` [in frame ${step.frame}]`
    lines.push(`${step.n}. ${step.label}: ${step.outcome}${step.target === '' ? '' : ` on ${step.target}`}${where}${value}${clip}, ring up after ${step.foundMs} ms, he took ${Math.round(step.waitedMs / 100) / 10} s${timing}${step.early === true ? ' (he clicked before the ring was drawn)' : ''}${step.url === '' ? '' : `; now at ${step.url}`}`)
    if (step.note !== undefined) lines.push(`   ${step.note}`)
    if (step.candidates !== undefined && step.candidates.length > 0) lines.push(`   On the page: ${step.candidates.join('; ')}`)
  }
  lines.push(`URL: ${result.url || '(none)'}`, `Title: ${result.title || '(untitled)'}`)
  if (result.dialogs.length > 0) lines.push(`Open dialog: ${result.dialogs.join(' | ')}`)
  if (result.jsDialog !== '') lines.push(`The page showed a dialog: "${result.jsDialog}"`)
  if (result.note !== '') lines.push(result.note)
  if (result.outcome !== 'done' && result.outcome !== 'clicked' && result.outcome !== 'typed' && result.text !== '') lines.push(`The page shows: ${result.text.replace(/\s+/g, ' ').slice(0, 300)}`)
  return lines.join('\n')
}

export type GuideEnd = '' | 'person' | 'closed' | 'run'

export interface GuideRun {
  tabId: string
  owner: string
  abort: AbortController
  endedBy: GuideEnd
}

/**
 * The guides running now, one per tab. Whatever ends the guide's reason to exist ends the guide: the run that started
 * it ending (run-tabs.ts runEnded), its tab closing, the person pressing Done in the browser, a newer guide on the tab.
 */
export class GuideRuns {
  private readonly runs = new Map<string, GuideRun>()

  start(tabId: string, owner: string): GuideRun {
    this.runs.get(tabId)?.abort.abort()
    const run: GuideRun = { tabId, owner, abort: new AbortController(), endedBy: '' }
    this.runs.set(tabId, run)
    return run
  }

  finish(run: GuideRun): void {
    if (this.runs.get(run.tabId) === run) this.runs.delete(run.tabId)
  }

  private end(run: GuideRun, why: GuideEnd): void {
    if (run.abort.signal.aborted) return
    run.endedBy = why
    run.abort.abort()
  }

  endOwner(owner: string): number {
    let ended = 0
    for (const run of this.runs.values()) if (run.owner === owner) {
      this.end(run, 'run')
      ended++
    }
    return ended
  }

  endTab(tabId: string, why: GuideEnd): void {
    const run = this.runs.get(tabId)
    if (run !== undefined) this.end(run, why)
  }

  endAll(why: GuideEnd): void {
    for (const run of this.runs.values()) this.end(run, why)
  }

  running(tabId?: string): boolean {
    return tabId === undefined ? this.runs.size > 0 : this.runs.has(tabId)
  }
}

/**
 * Where he sees the guide: in the panel when the panel is on screen showing this tab; otherwise (the panel hidden,
 * folded, parked, or showing another tab, or the tab is a background agent's) the page opens full size over the
 * window, as a handoff does, and goes back when the guide ends.
 */
export function guideShowsFullSize(view: { panelVisible: boolean; panelWidth: number; shownTab: string | null; expanded: boolean }, tabId: string): boolean {
  const inPanel = view.panelVisible && view.panelWidth > 0 && view.shownTab === tabId
  return !inPanel && !view.expanded
}
