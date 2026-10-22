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
}

export function helperState(value: string): HelperState {
  if (value === 'done' || value === 'failed' || value === 'stopped') return value
  return 'working'
}

export function helperIdOf(item: ChatItem): string {
  const id = metaText(metaOf(item), 'id')
  return id === '' ? item.id : id
}

export function helperActivities(items: ChatItem[], id: string): ChatItem[] {
  return items
    .filter((item) => item.kind === 'activity' && metaText(metaOf(item), 'helper') === id)
    .sort((a, b) => a.createdAt - b.createdAt)
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

/**
 * Whose a helper is, for its picture and its "under which project" line. A project agent row (written by
 * main/runtime/project-agents.ts, id `pa-<chat>`, in the MAIN chat) carries its project in `meta.project`; any other
 * helper belongs to the project holding its chat. A hidden project, or a chat no project holds any more, shows a
 * plain icon and no name.
 */
export type HelperOwner = HelperCardOwner

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

export interface HelperCardOptions {
  /** Also keep helpers that finished at most this long ago (the device feed shows their done line). Default 0. */
  keepFinishedMs?: number
  now?: number
}

/**
 * Every helper working right now, from any chat (the main thread, any project, hidden ones too), for the side panel.
 * A project agent's card comes first and the helpers working in its project chat sit right under it; the rest are
 * oldest first. Nothing is cut: the panel scrolls. With `keepFinishedMs`, helpers that finished within it stay in
 * their place too (a stopped one never does).
 */
export function helperCards(items: ChatItem[], projects: ProjectRow[], options: HelperCardOptions = {}): HelperCard[] {
  const keep = options.keepFinishedMs ?? 0
  const now = options.now ?? Date.now()
  const shown = (card: HelperView): boolean =>
    card.state === 'working' || (keep > 0 && card.state !== 'stopped' && card.endedAt !== null && now - card.endedAt <= keep)
  const working = items
    .filter((item) => item.kind === 'helper')
    .map((item) => {
      const view = helperView(item, items)
      const projectChat = metaText(metaOf(item), 'projectChat')
      return { ...view, row: item, owner: helperOwner(item, projects), line: helperLine(view), depth: 0 as 0 | 1, projectChat }
    })
    .filter(shown)
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
 * helper's newest steps, or for a project agent's card the newest lines of its project chat (`chatSteps`).
 */
export function cardInfo(card: HelperCard, chatSteps: ChatItem[] = []): HelperCardInfo {
  const source = card.projectChat !== '' ? chatSteps : card.activity
  const steps = source.slice(-MAX_STEPS).map((step) => ({
    text: oneLine(stepText(step), 240),
    status: metaText(metaOf(step), 'status') || 'done',
    at: step.createdAt,
  }))
  const brief = card.projectChat !== '' ? metaText(metaOf(card.row), 'lastBrief') || card.brief : card.brief
  return {
    id: card.id,
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
