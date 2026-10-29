/**
 * When a mini-app's look check may take its screenshot (main/miniapps/check.ts): not at a fixed delay, but once the
 * app has drawn its first data. The app says so itself with agent.ready(); else the check waits until every request
 * it made through the bridge has been answered and the page has stopped changing; an app that asks for nothing is
 * shot once the page is still. Never longer than the limit; a timeout is reported, not hidden.
 */

/** What one check page is doing, as the bridge sees it. */
export class CheckWatch {
  /** Requests sent (call, store.*, ask) and not yet answered. */
  inflight = 0
  /** Requests answered so far. */
  answered = 0
  /** The app called agent.ready(). */
  ready = false
  /** When the bridge last saw a request or an answer (ms). */
  lastAt: number

  constructor(now: number) {
    this.lastAt = now
  }

  /** A message from the app. */
  sent(message: { op?: unknown; id?: unknown }, now: number): void {
    if (message.op === 'ready') this.ready = true
    if (typeof message.id === 'number' && message.id > 0) {
      this.inflight += 1
      this.lastAt = now
    }
  }

  /** The answer to one of its requests went back. */
  replied(now: number): void {
    if (this.inflight > 0) this.inflight -= 1
    this.answered += 1
    this.lastAt = now
  }
}

export interface WaitOptions {
  watch: CheckWatch
  /** When the page's DOM last changed (ms), read from the page. */
  lastMutation: () => Promise<number>
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** At least this long after load before a page with no requests counts as drawn (ms). */
  minMs?: number
  /** The page and the bridge must have been quiet this long (ms). */
  quietMs?: number
  /** Never wait longer than this (ms). */
  limitMs?: number
  /** How often to look (ms). */
  everyMs?: number
}

export type WaitOutcome = { how: 'ready' | 'data' | 'still' | 'timeout'; ms: number; inflight: number }

export const CHECK_WAIT = { minMs: 1200, quietMs: 500, limitMs: 15_000, everyMs: 100 } as const

/** Waits until the app has drawn its first data (see the top of this file). */
export async function waitForFirstData(options: WaitOptions): Promise<WaitOutcome> {
  const { watch, now, sleep } = options
  const minMs = options.minMs ?? CHECK_WAIT.minMs
  const quietMs = options.quietMs ?? CHECK_WAIT.quietMs
  const limitMs = options.limitMs ?? CHECK_WAIT.limitMs
  const everyMs = options.everyMs ?? CHECK_WAIT.everyMs
  const start = now()
  for (;;) {
    const at = now()
    const ms = at - start
    // Its own word first: a short beat for the frame it just drew to paint.
    if (watch.ready) {
      await sleep(Math.min(150, everyMs))
      return { how: 'ready', ms: now() - start, inflight: watch.inflight }
    }
    if (ms >= limitMs) return { how: 'timeout', ms, inflight: watch.inflight }
    if (watch.inflight === 0) {
      let mutated = start
      try {
        mutated = await options.lastMutation()
      } catch {
        // A page that cannot be read is judged by the bridge alone.
      }
      const quietSince = Math.max(watch.lastAt, mutated, start)
      const quiet = now() - quietSince >= quietMs
      if (watch.answered > 0 && quiet) return { how: 'data', ms: now() - start, inflight: 0 }
      if (watch.answered === 0 && ms >= minMs && quiet) return { how: 'still', ms: now() - start, inflight: 0 }
    }
    await sleep(everyMs)
  }
}

/** Put in the check page once it loads: remembers when its DOM last changed, in window.__checkMutatedAt (performance time origin + now). */
export const MUTATION_PROBE = `(function(){if(window.__checkMutatedAt!==undefined)return true;window.__checkMutatedAt=Date.now();new MutationObserver(function(){window.__checkMutatedAt=Date.now()}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});return true})()`
