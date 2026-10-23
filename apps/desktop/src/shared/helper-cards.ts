/**
 * The helper cards: every helper and project agent working right now, from any chat, with its one live line, whose it
 * is and where it sits (a project agent's card first, the helpers of its project chat indented under it). Pure, so
 * the window's side panel (renderer/shell/HelpersPanel.tsx) and the feed a linked device hears
 * (main/devices/helper-feed.ts) are built by the same code and cannot drift apart.
 */
import { MAIN_CHAT, type ChatItem, type HelperCardInfo, type HelperCardOwner, type HelperState, type ProjectIcon, type ProjectRow } from '@agent/core'

type Meta = Record<string, unknown>

const metaCache = new WeakMap<object, Meta>()

/** A row's meta, parsed once per row object (unreadable meta is empty). */
function metaOf(item: { meta: string }): Meta {
  const hit = metaCache.get(item)
  if (hit !== undefined) return hit
  let parsed: Meta = {}
  try {
    const value: unknown = JSON.parse(item.meta)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Meta
  } catch {
    // Treated as empty.
  }
  metaCache.set(item, parsed)
  return parsed
}

function metaText(meta: Meta, key: string): string {
  const value = meta[key]
  return typeof value === 'string' ? value : ''
}

function metaNumber(meta: Meta, key: string): number | null {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The chat a row belongs to: `meta.chat`, or the main chat. */
function chatOfRow(item: { meta: string }): string {
  const value = metaOf(item)['chat']
  return typeof value === 'string' && value !== '' ? value : MAIN_CHAT
}

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
  /** The linked brain it runs on when that is not the one that started it (s12), '' when it runs where it started. */
  where: string
}

export function helperState(value: string): HelperState {
  if (value === 'done' || value === 'failed' || value === 'stopped') return value
  return 'working'
}

export function helperIdOf(item: ChatItem): string {
  const id = metaText(metaOf(item), 'id')
  return id === '' ? item.id : id
}

/**
 * One pass over a row list: every helper's steps by helper id, and every side chat's own lines (its agent's steps and
 * replies, not its helpers' steps) by chat id, each oldest first. Kept per list object, so the side panel, the thread
 * and the device feed read a 17,000-row list once per change instead of once per helper (a list is never changed in
 * place: a change makes a new list, src/renderer/lib/patch.ts).
 */
interface RowIndex {
  length: number
  steps: Map<string, ChatItem[]>
  lines: Map<string, ChatItem[]>
}

const indexCache = new WeakMap<readonly ChatItem[], RowIndex>()
const NONE: readonly ChatItem[] = Object.freeze([])

function byTime(a: ChatItem, b: ChatItem): number {
  return a.createdAt - b.createdAt
}

function rowIndex(items: readonly ChatItem[]): RowIndex {
  const hit = indexCache.get(items)
  if (hit !== undefined && hit.length === items.length) return hit
  const steps = new Map<string, ChatItem[]>()
  const lines = new Map<string, ChatItem[]>()
  const add = (map: Map<string, ChatItem[]>, key: string, item: ChatItem): void => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [item])
    else list.push(item)
  }
  for (const item of items) {
    if (item.kind !== 'activity' && item.kind !== 'agent') continue
    const helper = metaText(metaOf(item), 'helper')
    if (helper === '') add(lines, chatOfRow(item), item)
    else if (item.kind === 'activity') add(steps, helper, item)
  }
  // A stable sort keeps the list's own order for rows created at the same moment, as filter-then-sort did.
  for (const list of steps.values()) list.sort(byTime)
  for (const list of lines.values()) list.sort(byTime)
  const index = { length: items.length, steps, lines }
  indexCache.set(items, index)
  return index
}

export function helperActivities(items: ChatItem[], id: string): ChatItem[] {
  return [...(rowIndex(items).steps.get(id) ?? NONE)]
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
    where: metaText(meta, 'runOn') !== '' && metaText(meta, 'runOn') !== metaText(meta, 'placedBy') ? metaText(meta, 'runsOnName') : '',
  }
}

/**
 * Whose a helper is, for its picture and its "under which project" line. A project agent row (written by
 * main/runtime/project-agents.ts, id `pa-<chat>`, in the MAIN chat) carries its project in `meta.project`; any other
 * helper belongs to the project holding its chat. A hidden project, or a chat no project holds any more, shows a
 * plain icon and no name.
 */
export type HelperOwner = HelperCardOwner

/**
 * What a card stands for, and so what a tap on it does. A project chat (a project's own agent, with its own context
 * and its own thread) and a helper (one job with a brief, steps and a result) are different things: a project chat's
 * card opens that chat in full; a helper's card opens the helper's own view.
 */
export type CardKind = 'project-chat' | 'helper'

export interface HelperCard extends HelperView {
  kind: CardKind
  /** For a helper working inside a project chat: that chat, so its view can open it ('' otherwise). */
  parentChat: string
  row: ChatItem
  owner: HelperOwner
  /** The one line under its name: the step it is on, else its status line. */
  line: string
  /** 1 for a helper drawn under its project agent's card. */
  depth: 0 | 1
  /** For a project agent row: the project chat it stands for ('' otherwise). */
  projectChat: string
  /**
   * Its steps, oldest first: a helper's own activity rows, or for a project agent's card the lines of its project
   * chat (the project agent's steps and replies, not its helpers' steps, which sit on their own cards).
   */
  steps: ChatItem[]
}

function projectMetaOf(meta: Meta): { id: string; name: string; icon: ProjectIcon } | null {
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

function projectOfChat(projects: ProjectRow[], chat: string): ProjectRow | null {
  return chat === MAIN_CHAT ? null : (projects.find((project) => project.chats.includes(chat)) ?? null)
}

export function helperOwner(item: ChatItem, projects: ProjectRow[]): HelperOwner {
  const fromMeta = projectMetaOf(metaOf(item))
  const project = fromMeta !== null ? (projects.find((each) => each.id === fromMeta.id) ?? null) : projectOfChat(projects, chatOfRow(item))
  if (project !== null) return project.hidden ? { kind: 'plain' } : { kind: 'project', id: project.id, name: project.name, icon: project.icon }
  if (fromMeta !== null) return { kind: 'project', ...fromMeta }
  return chatOfRow(item) === MAIN_CHAT ? { kind: 'main' } : { kind: 'plain' }
}

/** A project agent row: it stands for a project chat (`meta.projectChat`), it is not a helper run. */
export function projectChatOfRow(item: ChatItem): string {
  return metaText(metaOf(item), 'projectChat')
}

/**
 * The project chat a helper works in, for the "open its chat" link in the helper's view: the chat its row sits in
 * when a project holds that chat. '' for the main chat's helpers, quick chats, and project agent rows themselves.
 */
export function helperParentChat(item: ChatItem, projects: ProjectRow[]): string {
  if (projectChatOfRow(item) !== '') return ''
  const chat = chatOfRow(item)
  return projectOfChat(projects, chat) === null ? '' : chat
}

function stepText(step: ChatItem): string {
  return metaText(metaOf(step), 'summary') || step.text
}

/** The one line a helper card shows: the step running now, else its newest step, else its status line. */
export function helperLine(helper: HelperView): string {
  const steps = helper.activity
  const running = [...steps].reverse().find((step) => metaText(metaOf(step), 'status') === 'running')
  const step = running ?? steps[steps.length - 1]
  const text = step === undefined ? '' : stepText(step)
  if (text.trim() !== '') return text
  if (helper.summary.trim() !== '') return helper.summary
  return helper.queued ? 'Waiting its turn' : 'Starting'
}

/** A project chat's own lines (its agent's steps and replies; helpers' steps are on their own cards), oldest first. */
export function projectChatLines(items: ChatItem[], chat: string): ChatItem[] {
  return [...(rowIndex(items).lines.get(chat) ?? NONE)]
}

/**
 * A project agent card's line: while it works, the step its project chat is on (else its newest step or reply);
 * once idle, its last answer. Falls back to the row's own status line.
 */
export function projectLine(view: HelperView, lines: ChatItem[]): string {
  if (view.state !== 'working') return oneLine(view.result) || oneLine(view.summary) || 'Done'
  const running = [...lines].reverse().find((line) => line.kind === 'activity' && metaText(metaOf(line), 'status') === 'running')
  const newest = running ?? lines[lines.length - 1]
  const text = newest === undefined ? '' : oneLine(stepText(newest))
  return text !== '' ? text : view.summary.trim() !== '' ? view.summary : 'Starting'
}

/**
 * Every helper working right now, from any chat (the main thread, any project, hidden ones too), for the side panel.
 * A project agent's card comes first and the helpers working in its project chat sit right under it; the rest are
 * oldest first. Nothing is cut: the panel scrolls. Only working cards (queued ones included): a card that is done,
 * failed or stopped leaves at once, everywhere these cards show (the side panel, the collapsed strip, a linked
 * device). Its last answer stays in its own chat.
 */
export function helperCards(items: ChatItem[], projects: ProjectRow[]): HelperCard[] {
  const working = items
    // Only working rows are built: a finished helper never shows here, and most helper rows are finished ones.
    .filter((item) => item.kind === 'helper' && helperState(metaText(metaOf(item), 'state')) === 'working')
    .map((item): HelperCard => {
      const view = helperView(item, items)
      const projectChat = metaText(metaOf(item), 'projectChat')
      const lines = projectChat === '' ? view.activity : projectChatLines(items, projectChat)
      const line = projectChat === '' ? helperLine(view) : projectLine(view, lines)
      const kind: CardKind = projectChat === '' ? 'helper' : 'project-chat'
      return { ...view, kind, parentChat: helperParentChat(item, projects), row: item, owner: helperOwner(item, projects), line, depth: 0, projectChat, steps: lines }
    })
    .filter((card) => card.state === 'working')
    // Running cards first, then queued ones; oldest first within each.
    .sort((a, b) => Number(a.queued) - Number(b.queued) || a.startedAt - b.startedAt)
  const heads = new Set(working.filter((card) => card.projectChat !== '').map((card) => card.projectChat))
  const under = (card: HelperCard): string => (card.projectChat === '' && heads.has(chatOfRow(card.row)) ? chatOfRow(card.row) : '')
  const out: HelperCard[] = []
  for (const card of working) {
    if (under(card) !== '') continue
    out.push(card)
    if (card.projectChat === '') continue
    for (const child of working) if (under(child) === card.projectChat) out.push({ ...child, depth: 1 })
  }
  return out
}

const MAX_LINE = 160
const MAX_BRIEF = 600
const MAX_STEPS = 8

/** One line of plain text: the first line that says something, markdown marks off, clipped. */
export function oneLine(text: string, max = MAX_LINE): string {
  const first =
    text
      .split('\n')
      .map((line) => line.trim().replace(/^[-*#>\s]+/, '').replace(/\*\*|`/g, '').trim())
      .find((line) => line !== '') ?? ''
  const flat = first.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A card as a linked device gets it (HelperCardInfo, packages/core ipc.ts): plain data, no chat rows. `steps` are a
 * helper's newest steps, or for a project agent's card the newest lines of its project chat.
 */
export function cardInfo(card: HelperCard): HelperCardInfo {
  const steps = card.steps.slice(-MAX_STEPS).map((step) => ({
    text: oneLine(stepText(step), 240),
    status: metaText(metaOf(step), 'status') || 'done',
    at: step.createdAt,
  }))
  const brief = card.projectChat !== '' ? metaText(metaOf(card.row), 'lastBrief') || card.brief : card.brief
  return {
    id: card.id,
    kind: card.kind,
    parentChat: card.parentChat,
    row: card.row.id,
    chat: chatOfRow(card.row),
    label: card.label,
    state: card.state,
    queued: card.queued,
    line: oneLine(card.line),
    done: card.state === 'working' ? '' : oneLine(card.result) || oneLine(card.summary) || (card.state === 'done' ? 'Done' : 'Did not finish'),
    depth: card.depth,
    projectChat: card.projectChat,
    owner: card.owner,
    model: card.model,
    startedAt: card.startedAt,
    endedAt: card.endedAt,
    brief: brief.length > MAX_BRIEF ? `${brief.slice(0, MAX_BRIEF - 1)}…` : brief,
    result: card.state === 'working' ? '' : card.result.slice(0, 4000),
    steps,
  }
}
