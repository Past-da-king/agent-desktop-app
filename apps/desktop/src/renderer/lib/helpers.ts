import type { ChatItem, HelperState } from '@agent/core'

import { metaText, parseMeta } from './meta'

export interface HelperView {
  id: string
  label: string
  brief: string
  state: HelperState
  summary: string
  queued: boolean
  startedAt: number
  endedAt: number | null
  result: string
  activity: ChatItem[]
}

function helperState(value: string): HelperState {
  if (value === 'done' || value === 'failed' || value === 'stopped') return value
  return 'working'
}

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isHelper(item: ChatItem): boolean {
  return item.kind === 'helper'
}

export function helperIdOf(item: ChatItem): string {
  const meta = parseMeta(item.meta)
  const id = metaText(meta, 'id')
  return id === '' ? item.id : id
}

export function isHelperActivity(item: ChatItem): boolean {
  return item.kind === 'activity' && metaText(parseMeta(item.meta), 'helper') !== ''
}

export function helperActivities(items: ChatItem[], id: string): ChatItem[] {
  return items
    .filter((item) => item.kind === 'activity' && metaText(parseMeta(item.meta), 'helper') === id)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * A helper stays in the thread while it works. Once it has finished, its result arrives as a main
 * agent reply, and the card folds away then. A stopped helper has no reply to wait for.
 */
export function helperVisible(item: ChatItem, items: ChatItem[]): boolean {
  if (!isHelper(item)) return false
  const meta = parseMeta(item.meta)
  const state = helperState(metaText(meta, 'state'))
  if (state === 'working') return true
  if (state === 'stopped') return false
  const endedAt = metaNumber(meta, 'endedAt') ?? item.createdAt
  return !items.some((other) => other.kind === 'agent' && other.createdAt >= endedAt)
}

export function helperView(item: ChatItem, items: ChatItem[]): HelperView {
  const meta = parseMeta(item.meta)
  return {
    id: helperIdOf(item),
    label: metaText(meta, 'label') || 'Helper',
    brief: item.text,
    state: helperState(metaText(meta, 'state')),
    summary: metaText(meta, 'summary'),
    queued: meta['queued'] === true,
    startedAt: metaNumber(meta, 'startedAt') ?? item.createdAt,
    endedAt: metaNumber(meta, 'endedAt'),
    result: metaText(meta, 'result'),
    activity: helperActivities(items, helperIdOf(item)),
  }
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
