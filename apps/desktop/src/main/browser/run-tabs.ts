/**
 * Every agent run owns the tabs it opened, and they close when the run ends (24 Oct 2026: agents left tabs open
 * after their job, and every idle page holds memory and CPU on the person's computer).
 *
 * The runs (runtime/helpers.ts, runtime/runner.ts, the call, device tools) say when one ends with `runEnded`; every
 * browser (the desktop one, the headless node's) hears it through `onRunEnded` and asks `RunTabs` what to close.
 * The rules live here, apart from Electron, so they can be tested:
 * - a tab belongs to the agent that opened it ("main", "chat:<id>", "routine", "helper:<id>", "device:<id>", "voice"),
 *   and a tab a page opened (window.open) belongs to whoever owned the tab that opened it;
 * - when a run ends (done, stopped or failed) its tabs close, at once for a helper or routine, after a few idle
 *   minutes for the main agent and its chats (the next turn often looks at the same page);
 * - never closed: the person's own tabs (never owned by an agent), the tab he took over or is using, the tab on
 *   screen in the panel (it waits until it is no longer shown), a tab another live run drives (it passes to that run),
 *   and the shared site tab learned apps reuse (one WhatsApp Web tab): those are kept, and go idle.
 */

/** How long the main agent's (and a chat's) tabs wait after its turn before they close. */
export const MAIN_IDLE_MS = 3 * 60_000

/** How often a browser looks for tabs that are due to close (and shown tabs that are no longer shown). */
export const SWEEP_MS = 30_000

type RunEndListener = (owner: string, graceMs: number) => void

const listeners = new Set<RunEndListener>()

/** A browser listens for runs ending. Returns the way to stop listening. */
export function onRunEnded(listener: RunEndListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A run ended: the tabs it opened close after `graceMs` (0 = now), unless it uses the browser again first. */
export function runEnded(owner: string, graceMs = 0): void {
  if (owner.trim() === '') return
  for (const listener of listeners) {
    try {
      listener(owner, Math.max(0, graceMs))
    } catch {
      // A browser that cannot close a tab right now tries again on its next sweep.
    }
  }
}

/** The browser as the sweep sees it. */
export interface BrowserFacts {
  /** Tabs open now. */
  open: string[]
  /** The tab the person is using (took over, typed into, opened), or null. */
  personTab: string | null
  /** The tab on screen in the panel right now, or null when the panel is not showing. */
  shown: string | null
  /** Which tab each agent drives now (owner -> tab id). */
  driving: ReadonlyMap<string, string>
}

export interface SweepPlan {
  /** Close these tabs. */
  close: string[]
  /** Kept open but nobody's run needs them: let them go idle (background throttling). */
  idle: string[]
  /** Agents whose runs ended: forget which tab they drove and which profile they browsed in. */
  drop: string[]
}

export class RunTabs {
  /** Tab id -> the agent that opened it. A tab with no entry is the person's, or nobody's to close. */
  private readonly opener = new Map<string, string>()
  /** Agent -> when its tabs may close (its run ended). */
  private readonly ended = new Map<string, number>()
  /** Learned apps' shared site tabs: kept for the next run on that site. */
  private readonly site = new Set<string>()
  /** Tabs of an ended run kept only because they were on screen: closed once they are not. */
  private readonly lingering = new Set<string>()

  /** An agent opened this tab (or a page in its tab did). */
  opened(tab: string, owner: string): void {
    this.opener.set(tab, owner)
    this.lingering.delete(tab)
    this.ended.delete(owner)
  }

  /** The agent is browsing again: its run has not ended after all (the main agent's next turn). */
  used(owner: string): void {
    this.ended.delete(owner)
  }

  /** The person took the tab or typed an address in it: it is his now, and no run closes it. */
  givenToPerson(tab: string): void {
    this.opener.delete(tab)
    this.lingering.delete(tab)
  }

  /** A learned app's one tab per site: shared by every run on that site, never closed when one ends. */
  shared(tab: string): void {
    this.site.add(tab)
    this.lingering.delete(tab)
  }

  /** The tab closed. */
  forget(tab: string): void {
    this.opener.delete(tab)
    this.site.delete(tab)
    this.lingering.delete(tab)
  }

  ownerOf(tab: string): string | undefined {
    return this.opener.get(tab)
  }

  isShared(tab: string): boolean {
    return this.site.has(tab)
  }

  /** The tabs an agent owns among those open: the ones it opened and the one it drives. */
  tabsOf(owner: string, facts: Pick<BrowserFacts, 'open' | 'driving'>): string[] {
    const own = facts.open.filter((tab) => this.opener.get(tab) === owner)
    const driving = facts.driving.get(owner)
    if (driving !== undefined && facts.open.includes(driving) && !own.includes(driving)) own.push(driving)
    return own
  }

  /** The run ended: its tabs may close from `at` on. */
  end(owner: string, at: number): void {
    this.ended.set(owner, at)
  }

  /** Is anything waiting to be swept? */
  pending(): boolean {
    return this.ended.size > 0 || this.lingering.size > 0
  }

  /** What to close now: the tabs of runs that are due, and shown tabs of ended runs that are no longer shown. */
  sweep(now: number, facts: BrowserFacts): SweepPlan {
    const due = [...this.ended].filter(([, at]) => at <= now).map(([owner]) => owner)
    const dueSet = new Set(due)
    const candidates = new Set<string>(this.lingering)
    for (const owner of due) {
      this.ended.delete(owner)
      for (const tab of this.tabsOf(owner, facts)) candidates.add(tab)
    }
    // A tab another run still drives stays with that run (an agent moved onto a shared site tab, say).
    const liveDriver = new Map<string, string>()
    for (const [owner, tab] of facts.driving) if (!dueSet.has(owner)) liveDriver.set(tab, owner)

    const close: string[] = []
    const idle: string[] = []
    for (const tab of candidates) {
      if (!facts.open.includes(tab)) {
        this.forget(tab)
        continue
      }
      if (tab === facts.personTab) {
        this.givenToPerson(tab)
        continue
      }
      const driver = liveDriver.get(tab)
      if (driver !== undefined) {
        this.opener.set(tab, driver)
        this.lingering.delete(tab)
        continue
      }
      if (this.site.has(tab)) {
        this.opener.delete(tab)
        this.lingering.delete(tab)
        idle.push(tab)
        continue
      }
      if (tab === facts.shown) {
        if (!this.lingering.has(tab)) idle.push(tab)
        this.lingering.add(tab)
        continue
      }
      close.push(tab)
      this.forget(tab)
    }
    return { close, idle, drop: due }
  }
}
