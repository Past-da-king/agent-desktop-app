import { MAIN_CHAT, type ChatItem, type HelperState, type ProjectIcon, type ProjectRow } from '@agent/core'

import { chatOf } from './chats'
import { metaOf, metaText } from './meta'
import { projectOfChat } from './projects'

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
  /** The model it runs on, when it was picked from a list of helper models ('' otherwise). */
  model: string
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
  const meta = metaOf(item)
  const id = metaText(meta, 'id')
  return id === '' ? item.id : id
}

export function isHelperActivity(item: ChatItem): boolean {
  return item.kind === 'activity' && metaText(metaOf(item), 'helper') !== ''
}

export function helperActivities(items: ChatItem[], id: string): ChatItem[] {
  return items
    .filter((item) => item.kind === 'activity' && metaText(metaOf(item), 'helper') === id)
    .sort((a, b) => a.createdAt - b.createdAt)
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
  return !items.some((other) => other.kind === 'agent' && other.createdAt >= endedAt)
}

export function helperView(item: ChatItem, items: ChatItem[]): HelperView {
  const meta = metaOf(item)
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
    // Shown only when it was chosen from a list (delegate writes modelName then); one model needs no label.
    model: metaText(meta, 'modelName') === '' ? '' : metaText(meta, 'model'),
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

/**
 * Whose a helper is, for its picture and its "under which project" line. A project agent row (written by
 * main/runtime/project-agents.ts, id `pa-<chat>`, in the MAIN chat) carries its project in `meta.project`; any other
 * helper belongs to the project holding its chat. A hidden project, or a chat no project holds any more, shows a
 * plain icon and no name.
 */
export type HelperOwner =
  | { kind: 'main' }
  | { kind: 'project'; id: string; name: string; icon: ProjectIcon }
  | { kind: 'plain' }

export interface HelperCard extends HelperView {
  row: ChatItem
  owner: HelperOwner
  /** The one line under its name: the step it is on, else its status line. */
  line: string
  /** 1 for a helper drawn under its project agent's card. */
  depth: 0 | 1
  /** For a project agent row: the project chat it stands for ('' otherwise). */
  projectChat: string
}

function projectMetaOf(meta: Record<string, unknown>): { id: string; name: string; icon: ProjectIcon } | null {
  const value = meta['project']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  const text = (key: string): string => (typeof p[key] === 'string' ? (p[key] as string) : '')
  if (text('id') === '') return null
  const image = text('image')
  return {
    id: text('id'),
    name: text('name'),
    icon: { glyph: text('glyph') || 'folder', color: (text('color') || 'iris') as ProjectIcon['color'], ...(image === '' ? {} : { image }) },
  }
}

export function helperOwner(item: ChatItem, projects: ProjectRow[]): HelperOwner {
  const fromMeta = projectMetaOf(metaOf(item))
  const project = fromMeta !== null ? (projects.find((each) => each.id === fromMeta.id) ?? null) : projectOfChat(projects, chatOf(item))
  if (project !== null) return project.hidden ? { kind: 'plain' } : { kind: 'project', id: project.id, name: project.name, icon: project.icon }
  if (fromMeta !== null) return { kind: 'project', ...fromMeta }
  return chatOf(item) === MAIN_CHAT ? { kind: 'main' } : { kind: 'plain' }
}

/** The one line a helper card shows: the step running now, else its newest step, else its status line. */
export function helperLine(helper: HelperView): string {
  const steps = helper.activity
  const running = [...steps].reverse().find((step) => metaText(metaOf(step), 'status') === 'running')
  const step = running ?? steps[steps.length - 1]
  const text = step === undefined ? '' : metaText(metaOf(step), 'summary') || step.text
  if (text.trim() !== '') return text
  if (helper.summary.trim() !== '') return helper.summary
  return helper.queued ? 'Waiting its turn' : 'Starting'
}

/**
 * Every helper working right now, from any chat (the main thread, any project, hidden ones too), for the side panel.
 * A project agent's card comes first and the helpers working in its project chat sit right under it; the rest are
 * oldest first. Nothing is cut: the panel scrolls.
 */
export function helperCards(items: ChatItem[], projects: ProjectRow[]): HelperCard[] {
  const working = items
    .filter((item) => isHelper(item))
    .map((item) => {
      const view = helperView(item, items)
      const projectChat = metaText(metaOf(item), 'projectChat')
      return { ...view, row: item, owner: helperOwner(item, projects), line: helperLine(view), depth: 0 as 0 | 1, projectChat }
    })
    .filter((card) => card.state === 'working')
    .sort((a, b) => Number(a.queued) - Number(b.queued) || a.startedAt - b.startedAt)
  const heads = new Set(working.filter((card) => card.projectChat !== '').map((card) => card.projectChat))
  const under = (card: HelperCard): string => (card.projectChat === '' && heads.has(chatOf(card.row)) ? chatOf(card.row) : '')
  const out: HelperCard[] = []
  for (const card of working) {
    if (under(card) !== '') continue
    out.push(card)
    if (card.projectChat === '') continue
    for (const child of working) if (under(child) === card.projectChat) out.push({ ...child, depth: 1 })
  }
  return out
}
