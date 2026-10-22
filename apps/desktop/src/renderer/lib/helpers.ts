import { type ChatItem } from '@agent/core'

import { helperState, helperView, type HelperView } from '../../shared/helper-cards'
import { metaOf, metaText } from './meta'

// The card model lives in shared/helper-cards.ts: the side panel and the feed linked devices hear use the same code.
export {
  helperActivities,
  helperCards,
  helperIdOf,
  helperLine,
  helperOwner,
  helperView,
  type HelperCard,
  type HelperOwner,
  type HelperView,
} from '../../shared/helper-cards'

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isHelper(item: ChatItem): boolean {
  return item.kind === 'helper'
}

export function isHelperActivity(item: ChatItem): boolean {
  return item.kind === 'activity' && metaText(metaOf(item), 'helper') !== ''
}

/**
 * A helper stays in the thread while it works. Once it has finished, its result arrives as a main
 * agent reply, and the card folds away then. A stopped helper has no reply to wait for.
 */
export function helperVisible(item: ChatItem, items: ChatItem[]): boolean {
  if (!isHelper(item)) return false
  const meta = metaOf(item)
  const state = helperState(metaText(meta, 'state'))
  if (state === 'working') return true
  if (state === 'stopped') return false
  const endedAt = metaNumber(meta, 'endedAt') ?? item.createdAt
  return newestAgentAt(items) < endedAt
}

const newestAgentCache = new WeakMap<readonly ChatItem[], number>()

/** When the newest agent reply in a list was made (-Infinity for none), read once per list rather than per helper. */
function newestAgentAt(items: readonly ChatItem[]): number {
  const hit = newestAgentCache.get(items)
  if (hit !== undefined) return hit
  let newest = Number.NEGATIVE_INFINITY
  for (const item of items) if (item.kind === 'agent' && item.createdAt > newest) newest = item.createdAt
  newestAgentCache.set(items, newest)
  return newest
}

/** Helpers the thread or Home should show, oldest first. */
export function visibleHelpers(items: ChatItem[]): HelperView[] {
  return items
    .filter((item) => isHelper(item) && helperVisible(item, items))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((item) => helperView(item, items))
}

/** Helpers still doing a job right now (a queued helper included). */
export function workingHelpers(items: ChatItem[]): HelperView[] {
  return visibleHelpers(items).filter((helper) => helper.state === 'working')
}
