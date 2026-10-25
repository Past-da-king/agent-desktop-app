/**
 * Hard deadlines for everything the browser waits on (25 Oct 2026). A page that is hidden, starved or frozen can
 * leave a script, a capture or a load unanswered for ever; a helper waiting on it then sits in one tool call for
 * minutes. Every await on a page goes through `withDeadline`, and every browser tool through `toolDeadline`, so a
 * tool always ends and says what happened. Pure, so it is tested without Electron.
 */

import type { Tool } from '@agent/core'

/** A page that did not answer in time. Callers tell it from other errors to say so truthfully. */
export class PageTimeout extends Error {
  readonly ms: number
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${seconds(ms)} s (the page may be busy, frozen or hidden).`)
    this.name = 'PageTimeout'
    this.ms = ms
  }
}

/** Resolves as `promise` does, or rejects with PageTimeout after `ms`. The timer never outlives the race. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, what = 'The page'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PageTimeout(what, ms)), Math.max(0, ms))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // The loser may still settle later; its rejection must not surface as unhandled.
    promise.catch(() => undefined)
  }
}

/** Like withDeadline, but answers `fallback` instead of rejecting (for steps that are only nice to have). */
export async function orFallback<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  try {
    return await withDeadline(promise, ms)
  } catch {
    return fallback
  }
}

/** Default script deadline for one page read (an outline, a click target, the page's text). */
export const PAGE_SCRIPT_MS = 20_000
/** browser_wait_for: its own limit, and the most it may ask for. */
export const WAIT_DEFAULT_S = 15
export const WAIT_MAX_S = 30

/**
 * The most any one browser tool may take before the tool itself answers, in ms. Generous (a slow site's adaptive
 * open tries a few views), but finite: no tool call ever outlives it.
 */
export function toolLimitMs(tool: string, input: Record<string, unknown> = {}): number {
  const asked = typeof input['seconds'] === 'number' && Number.isFinite(input['seconds']) ? Math.max(1, input['seconds']) : undefined
  switch (tool) {
    case 'browser_wait_for':
      return (Math.min(WAIT_MAX_S, asked ?? WAIT_DEFAULT_S) + 20) * 1000
    case 'browser_eval':
      return (Math.min(120, asked ?? 30) + 20) * 1000
    case 'browser_look':
    case 'browser_show_user':
      return 30_000
    case 'browser_open':
    case 'browser_view':
    case 'browser_fix':
      return 120_000
    case 'browser_upload':
    case 'browser_fetch':
      return 90_000
    default:
      return 60_000
  }
}

/**
 * Runs one browser tool with its hard limit. On the limit it answers in plain words instead of waiting on: the tool
 * ended, nothing more will come from that call, and the agent can try again or move on.
 */
export async function toolDeadline(tool: string, action: () => Promise<string>, ms: number = toolLimitMs(tool)): Promise<string> {
  try {
    return await withDeadline(action(), ms, tool)
  } catch (error) {
    if (error instanceof PageTimeout) {
      return `${tool} stopped after ${seconds(ms)} s: the page did not answer in time (it may be busy, frozen or hidden). Try again, or use browser_read to see where it is.`
    }
    const message = error instanceof Error ? error.message : String(error)
    return `The browser had a problem: ${message}`
  }
}

/** One short line of what a page showed, for answers that end without what was wanted. */
export function sawLine(seen: { url: string; title: string; text: string } | null): string {
  if (seen === null) return 'The page did not answer when read (it may be busy, frozen or hidden).'
  const excerpt = seen.text.replace(/\s+/g, ' ').trim().slice(0, 300)
  return [`URL: ${seen.url || '(none)'}`, `Title: ${seen.title || '(none)'}`, `Text: ${excerpt === '' ? '(no text)' : excerpt}`].join('\n')
}

/** browser_wait_for's answer, the same on every browser (desktop, headless node). */
export function waitAnswer(
  outcome: { found: boolean; reason?: string; timedOut?: boolean },
  what: { text: string; selector: string },
  seconds: number,
  seen: { url: string; title: string; text: string } | null,
): string {
  if (outcome.reason !== undefined && outcome.reason !== '') return outcome.reason
  const target = what.selector !== '' && what.text !== '' ? `"${what.text}" or ${what.selector}` : what.selector !== '' ? what.selector : `"${what.text}"`
  const head = outcome.found
    ? `It's there: ${target} found.`
    : outcome.timedOut === true
      ? `Not found: ${target}. The page did not answer within ${seconds} s (it may be busy, frozen or hidden); the wait ended at its limit.`
      : `Didn't appear in time: ${target} was not on the page after ${seconds} s.`
  return `${head}\n${sawLine(seen)}`
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10
}

/** Tools that wait on the person, not the page: they keep no time limit of their own. */
const WAITS_ON_PERSON = new Set(['browser_handoff', 'browser_upload'])

/**
 * Every browser tool ends: each gets its hard limit (toolLimitMs) on top of the driver's own deadlines, and on the
 * limit answers in plain words. Used by every browser tool set (tools/browser.ts, browser-pro.ts, browser-devtools.ts).
 */
export function guardBrowserTool(tool: Tool): Tool {
  if (WAITS_ON_PERSON.has(tool.spec.name)) return tool
  return {
    ...tool,
    run: (input, ctx) => toolDeadline(tool.spec.name, () => tool.run(input, ctx), toolLimitMs(tool.spec.name, input)),
  }
}
