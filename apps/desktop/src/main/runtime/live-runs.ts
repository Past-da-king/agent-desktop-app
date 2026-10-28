/**
 * Every run going on in this app that is not a chat turn on screen: routine runs (catch-ups included), background
 * scripts, and anything else that can drive the browser. Nothing runs without being here (28 Oct 2026: a routine
 * re-started after an update drove TikTok for 20 minutes, its card already marked failed, and a background script
 * kept opening tabs; neither showed anywhere nor could be stopped but by killing processes by hand).
 *
 * What is here: shows in helpers_status, has a working card in the sidebar (its X stops it), is stopped by
 * helper_stop / helpers.stopAll by its id, and is named as the owner of the browser tabs it drives.
 */
export type LiveRunKind = 'routine' | 'script'

export interface LiveRun {
  /** Its card's id (a chat row): rt-<routine id> for a routine, scr-<id> for a background script. */
  id: string
  kind: LiveRunKind
  /** What the person reads: the routine's name, "Background script for <who>". */
  label: string
  /** The browser owner its tools run as ("routine", "helper:<id>", "main"...). */
  owner: string
  startedAt: number
  /** The step it is on, if it says. */
  line: string
  /** Ends it at once (its process and its tabs go with it). `by` says who, in plain words. */
  stop(by: string): void
}

type Listener = (run: LiveRun, live: boolean) => void

export class LiveRuns {
  private readonly runs = new Map<string, LiveRun>()
  private readonly listeners = new Set<Listener>()

  /** A run started. Returns its handle: say the step it is on, and say when it ended (always, in a finally). */
  start(run: Omit<LiveRun, 'line'> & { line?: string }): { step(line: string): void; end(): void } {
    const entry: LiveRun = { ...run, line: run.line ?? '' }
    this.runs.set(entry.id, entry)
    this.tell(entry, true)
    return {
      step: (line) => {
        if (this.runs.get(entry.id) === entry) entry.line = line
      },
      end: () => {
        if (this.runs.get(entry.id) !== entry) return
        this.runs.delete(entry.id)
        this.tell(entry, false)
      },
    }
  }

  get(id: string): LiveRun | undefined {
    return this.runs.get(id)
  }

  has(id: string): boolean {
    return this.runs.has(id)
  }

  list(): LiveRun[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  /** The runs that drive the browser as this owner. */
  byOwner(owner: string): LiveRun[] {
    return this.list().filter((run) => run.owner === owner)
  }

  /** Stops one run. False when nothing by that id is running. */
  stop(id: string, by = ''): boolean {
    const run = this.runs.get(id)
    if (run === undefined) return false
    try {
      run.stop(by)
    } catch {
      // Its handle ends it on its own way out; the stop was asked for either way.
    }
    return true
  }

  /** Stops every run here. Returns how many. */
  stopAll(by = ''): number {
    const all = this.list()
    for (const run of all) this.stop(run.id, by)
    return all.length
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private tell(run: LiveRun, live: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(run, live)
      } catch {
        // A listener that fails must not keep a run from starting or ending.
      }
    }
  }
}

/** The one registry of this process. */
export const liveRuns = new LiveRuns()

/** A browser owner that must have a live run behind it to drive the browser (a turn on screen always has one). */
export function needsLiveRun(owner: string): boolean {
  return owner === 'routine'
}
