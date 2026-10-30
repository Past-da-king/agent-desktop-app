/**
 * The helper cards: every helper and project agent working right now, from any chat, with its one live line, whose it
 * is and where it sits (a project agent's card first, the helpers of its project chat indented under it). Pure, so
 * the window's side panel (renderer/shell/HelpersPanel.tsx) and the feed a linked device hears
 * (main/devices/helper-feed.ts) are built by the same code and cannot drift apart.
 */
import { EARLIER_CHATS_PROJECT, MAIN_CHAT, type ChatItem, type HelperCardInfo, type HelperCardOwner, type HelperState, type ProjectIcon, type ProjectRow } from '@agent/core'

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

/** What a card says while the queue holds it. */
export const QUEUED_LINE = 'Queued: waiting for a free slot'

/**
 * A helper the low-memory guard or the queue is holding has not started: it is not working, whatever its row's state
 * says while it waits. Null for anything that is actually running or has ended.
 */
export function helperHold(helper: { state: HelperState; queued: boolean; summary: string }): { kind: 'paused' | 'queued'; line: string } | null {
  if (helper.state !== 'working' || !helper.queued) return null
  const summary = helper.summary.trim()
  if (summary.startsWith('Paused:')) return { kind: 'paused', line: summary }
  return { kind: 'queued', line: summary.startsWith('Queued:') ? summary : QUEUED_LINE }
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
  /** When the person last wrote in each chat, and when its agent last replied (helpers' replies not counted). */
  talk: Map<string, Talk>
}

interface Talk {
  user: number
  agent: number
  /** The person's first message in it, which names the chat ('' for none). */
  title: string
  titleAt: number
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
  const talk = new Map<string, Talk>()
  for (const item of items) {
    // Each row's kind is read once: this walk runs over every row of a big install on each change.
    const kind = item.kind
    if (kind !== 'activity' && kind !== 'agent' && kind !== 'user') continue
    const helper = metaText(metaOf(item), 'helper')
    if (kind !== 'activity' && helper === '') {
      const chat = chatOfRow(item)
      const said = talk.get(chat) ?? { user: 0, agent: 0, title: '', titleAt: Number.POSITIVE_INFINITY }
      if (kind === 'user') {
        said.user = Math.max(said.user, item.createdAt)
        if (item.createdAt < said.titleAt && item.text.trim() !== '') {
          said.title = item.text
          said.titleAt = item.createdAt
        }
      } else said.agent = Math.max(said.agent, item.createdAt)
      talk.set(chat, said)
    }
    if (kind === 'user') continue
    if (helper === '') add(lines, chatOfRow(item), item)
    else if (kind === 'activity') add(steps, helper, item)
  }
  // A stable sort keeps the list's own order for rows created at the same moment, as filter-then-sort did.
  for (const list of steps.values()) list.sort(byTime)
  for (const list of lines.values()) list.sort(byTime)
  const index = { length: items.length, steps, lines, talk }
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
  /** A project chat that is not working and whose agent spoke last: done, and its turn is the person's. */
  waiting: boolean
  /**
   * When its group last moved (a project chat's newest line, its row starting or ending, a helper under it starting
   * or finishing). A card closed with its X stays away until this passes the stamp it was closed at.
   */
  activityAt: number
  /** A project chat's name: the person's first message in it, one line ('' when there is none). */
  chatTitle: string
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
  // Held: the reason, never an old step of an earlier run.
  const held = helperHold(helper)
  if (held !== null) return held.line
  const steps = helper.activity
  const running = [...steps].reverse().find((step) => metaText(metaOf(step), 'status') === 'running')
  const step = running ?? steps[steps.length - 1]
  const text = step === undefined ? '' : stepText(step)
  if (text.trim() !== '') return text
  if (helper.summary.trim() !== '') return helper.summary
  return 'Starting'
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

export interface CardOptions {
  /** Whether a chat has a turn running now (the runner's state): its rows alone cannot always tell. */
  running?: (chat: string) => boolean
  /** The clock, for the waiting cards' day (WAITING_CARD_MS); without it a waiting card stays until closed. */
  now?: number
}

/**
 * The project chats closed in the side panel with a card's X, each with the activity stamp it was closed at
 * (`ProjectRow.panelHidden`, so it survives a restart and reaches every device). Chats a project no longer holds
 * are ignored.
 */
export function closedChats(projects: ProjectRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const project of projects) {
    for (const [chat, at] of Object.entries(project.panelHidden ?? {})) {
      if (typeof at === 'number' && Number.isFinite(at) && project.chats.includes(chat)) out.set(chat, Math.max(at, out.get(chat) ?? 0))
    }
  }
  return out
}

/** What a project's `panelHidden` becomes when the card of `chat` is closed at activity stamp `at`. */
export function closePatch(project: ProjectRow, chat: string, at: number): Record<string, number> {
  const kept: Record<string, number> = {}
  for (const [each, stamp] of Object.entries(project.panelHidden ?? {})) {
    if (typeof stamp === 'number' && Number.isFinite(stamp) && project.chats.includes(each)) kept[each] = stamp
  }
  return { ...kept, [chat]: Math.max(at, kept[chat] ?? 0) }
}

function endedAtOf(meta: Meta): number {
  return metaNumber(meta, 'endedAt') ?? 0
}

/**
 * A finished helper's card closed by the person (its X on the desktop, a swipe on the phone): `meta.cardClosedAt` on
 * its own row, so it reaches every device and lasts through a restart. A helper that works again shows again.
 */
export function cardClosed(item: ChatItem): boolean {
  const meta = metaOf(item)
  if (helperState(metaText(meta, 'state')) === 'working') return false
  const at = metaNumber(meta, 'cardClosedAt')
  return at !== null && at >= Math.max(metaNumber(meta, 'startedAt') ?? item.createdAt, endedAtOf(meta))
}

/**
 * How long a project chat that is done and waiting on the person keeps its card when nothing moves in it: a day.
 * After that it leaves by itself (the chat and its answer stay), so no card is left in the list for ever.
 */
export const WAITING_CARD_MS = 24 * 60 * 60 * 1000

/**
 * The cards for the chat on screen. In a project chat only that project's cards show (its chats' cards and the
 * helpers working in them); anywhere else (the main chat, another page) every card shows.
 */
export function cardsForChat<T extends { owner: HelperCardOwner; projectChat: string; parentChat: string; row: { meta: string } }>(cards: T[], projects: ProjectRow[], chat: string): T[] {
  if (chat === '' || chat === MAIN_CHAT) return cards
  const project = projectOfChat(projects, chat)
  if (project === null || project.id === EARLIER_CHATS_PROJECT) return cards.filter((card) => card.projectChat === chat || card.parentChat === chat || chatOfRow(card.row) === chat)
  return cards.filter((card) => (card.owner.kind === 'project' && card.owner.id === project.id) || project.chats.includes(card.projectChat) || project.chats.includes(card.parentChat))
}

function lastAgentLine(lines: ChatItem[]): ChatItem | undefined {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.kind === 'agent') return lines[i]
  return undefined
}

/**
 * The side panel's cards (also the collapsed strip, the title bar's list and the feed a linked device hears):
 *  - every project chat that is working, or done and waiting on the person (its agent spoke last), whether the
 *    main agent handed it the work (a `pa-<chat>` row) or the person talks to it in its own chat. It stays until the
 *    person closes it with its X (or a swipe on the phone), or a day passes with nothing new in it (WAITING_CARD_MS).
 *    A closed card comes back when its chat moves again.
 *  - under it, the helpers that chat started: the ones working, and the ones of its latest turn that finished
 *    (unless he closed that one: cardClosed);
 *  - every other helper while it works (a finished helper outside a shown chat leaves at once).
 * Working cards come first (running before queued, oldest first), then the waiting chats, newest first. Nothing is
 * cut: the panel scrolls.
 */
export function helperCards(items: ChatItem[], projects: ProjectRow[], options: CardOptions = {}): HelperCard[] {
  const index = rowIndex(items)
  const closed = closedChats(projects)
  // A hidden project shows nothing of itself: its chats get no card of their own (their helpers still show).
  const projectOf = new Map<string, ProjectRow>()
  for (const project of projects) {
    if (project.id === EARLIER_CHATS_PROJECT || project.hidden) continue
    for (const chat of project.chats) projectOf.set(chat, project)
  }
  // Only the rows that can make a card are read: project agent rows, working helpers and helpers in project chats.
  const agentRows = new Map<string, ChatItem>()
  const helperRows: ChatItem[] = []
  for (const item of items) {
    if (item.kind !== 'helper') continue
    const projectChat = metaText(metaOf(item), 'projectChat')
    if (projectChat === '') {
      helperRows.push(item)
      continue
    }
    const before = agentRows.get(projectChat)
    if (before === undefined || before.createdAt < item.createdAt) agentRows.set(projectChat, item)
  }
  const helpersIn = new Map<string, ChatItem[]>()
  const loose: ChatItem[] = []
  for (const item of helperRows) {
    const chat = chatOfRow(item)
    if (chat !== MAIN_CHAT && (projectOf.has(chat) || agentRows.has(chat))) {
      const list = helpersIn.get(chat)
      if (list === undefined) helpersIn.set(chat, [item])
      else list.push(item)
    } else if (helperState(metaText(metaOf(item), 'state')) === 'working') loose.push(item)
  }

  const helperCard = (item: ChatItem, depth: 0 | 1): HelperCard => {
    const view = helperView(item, items)
    const line = view.state === 'working' ? helperLine(view) : oneLine(view.result) || oneLine(view.summary) || (view.state === 'done' ? 'Done' : view.state === 'failed' ? 'Did not finish' : 'Stopped')
    return {
      ...view,
      kind: 'helper',
      parentChat: helperParentChat(item, projects),
      row: item,
      owner: helperOwner(item, projects),
      line,
      depth,
      projectChat: '',
      steps: view.activity,
      waiting: false,
      chatTitle: '',
      activityAt: Math.max(view.startedAt, view.endedAt ?? 0),
    }
  }
  const byStart = (a: HelperCard, b: HelperCard): number => Number(a.queued) - Number(b.queued) || a.startedAt - b.startedAt

  const groups: Array<{ head: HelperCard; children: HelperCard[] }> = []
  const chats = new Set<string>([...projectOf.keys(), ...agentRows.keys()])
  for (const chat of chats) {
    const said = index.talk.get(chat) ?? { user: 0, agent: 0, title: '', titleAt: 0 }
    const agentRow = agentRows.get(chat)
    const agentMeta = agentRow === undefined ? {} : metaOf(agentRow)
    const inChat = helpersIn.get(chat) ?? []
    const helperWorking = inChat.some((row) => helperState(metaText(metaOf(row), 'state')) === 'working')
    const running = options.running?.(chat) === true || (agentRow !== undefined && helperState(metaText(agentMeta, 'state')) === 'working') || helperWorking
    const waiting = !running && said.agent > 0 && said.agent >= said.user
    if (!running && !waiting) continue
    // The helpers this chat started: the working ones, and the ones of its latest turn that finished (the turn began
    // with the person's newest message, or when the main agent last handed the chat work).
    const turnAt = Math.max(said.user, agentRow === undefined ? 0 : (metaNumber(agentMeta, 'startedAt') ?? agentRow.createdAt))
    const children = inChat
      .filter((row) => {
        const meta = metaOf(row)
        if (helperState(metaText(meta, 'state')) === 'working') return true
        if (cardClosed(row)) return false
        return turnAt > 0 && (metaNumber(meta, 'startedAt') ?? row.createdAt) >= turnAt
      })
      .map((row) => helperCard(row, 1))
      .sort((a, b) => Number(b.state === 'working') - Number(a.state === 'working') || byStart(a, b))
    const lines = projectChatLines(items, chat)
    const newestLine = lines.length === 0 ? 0 : lines[lines.length - 1]!.createdAt
    const activityAt = Math.max(
      newestLine,
      said.user,
      said.agent,
      agentRow === undefined ? 0 : Math.max(metaNumber(agentMeta, 'startedAt') ?? agentRow.createdAt, endedAtOf(agentMeta)),
      ...children.map((child) => child.activityAt),
    )
    if ((closed.get(chat) ?? -1) >= activityAt) continue
    if (waiting && options.now !== undefined && options.now - activityAt > WAITING_CARD_MS) continue
    const project = projectOf.get(chat)
    const answer = lastAgentLine(lines)
    // While it works with nothing of its own to say yet, its line says its helpers are on it rather than Starting.
    const helpersWorking = children.filter((child) => child.state === 'working').length
    const row: ChatItem =
      agentRow ??
      ({
        id: `pa-${chat}`,
        kind: 'helper',
        text: '',
        createdAt: lines[0]?.createdAt ?? activityAt,
        meta: JSON.stringify({
          id: `pa-${chat}`,
          label: project?.name ?? 'Project chat',
          state: running ? 'working' : 'done',
          projectChat: chat,
          startedAt: lines[0]?.createdAt ?? activityAt,
          endedAt: running ? null : said.agent,
          result: answer?.text ?? '',
          ...(project === undefined ? {} : { project: { id: project.id, name: project.name, glyph: project.icon.glyph, color: project.icon.color, ...(project.icon.image ? { image: project.icon.image } : {}) } }),
        }),
      } as ChatItem)
    const base = helperView(row, items)
    // The row's own state can lag (a project agent row closes a moment after the reply): what the chat does wins.
    const view: HelperView = {
      ...base,
      state: running ? 'working' : base.state === 'working' ? 'done' : base.state,
      result: !running && answer !== undefined && answer.createdAt >= endedAtOf(agentMeta) ? answer.text : base.result,
    }
    const line = projectLine(view, lines)
    const head: HelperCard = {
      ...view,
      kind: 'project-chat',
      parentChat: '',
      row,
      owner: helperOwner(row, projects),
      line: line === 'Starting' && helpersWorking > 0 ? (helpersWorking === 1 ? '1 helper working' : `${helpersWorking} helpers working`) : line,
      depth: 0,
      projectChat: chat,
      steps: lines,
      waiting,
      chatTitle: oneLine(said.title, 60),
      activityAt,
    }
    groups.push({ head, children })
  }

  const working = groups.filter((group) => !group.head.waiting).map((group) => group.head)
  const standalone = loose.map((row) => helperCard(row, 0))
  const first = [...working, ...standalone].sort(byStart)
  const waitingHeads = groups
    .filter((group) => group.head.waiting)
    .map((group) => group.head)
    .sort((a, b) => b.activityAt - a.activityAt)
  const out: HelperCard[] = []
  const childrenOf = new Map(groups.map((group) => [group.head.projectChat, group.children]))
  for (const card of [...first, ...waitingHeads]) {
    out.push(card)
    if (card.kind === 'project-chat') out.push(...(childrenOf.get(card.projectChat) ?? []))
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
    waiting: card.waiting,
    activityAt: card.activityAt,
    title: card.chatTitle,
  }
}
