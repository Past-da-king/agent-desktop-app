/**
 * Projects in the window: which project a chat belongs to, the ones the rail shows, a project chat id, and the
 * glyphs a project icon can use. Pure, so it is unit tested directly.
 */
import { MAIN_CHAT, type ChatItem, type ProjectRow } from '@agent/core'

import type { IconName } from '../ui/Icon'
import { parseMeta } from './meta'
import { senderLine, viaFromMeta, type SenderKind } from '../../shared/sender'

/** The project a chat belongs to; null for the main thread or a chat no project holds. */
export function projectOfChat(projects: ProjectRow[], chat: string): ProjectRow | null {
  return chat === MAIN_CHAT ? null : (projects.find((project) => project.chats.includes(chat)) ?? null)
}

/** How many projects the rail holds; the rest are one tap away in All projects. */
export const RAIL_PROJECTS = 5

/** A project the person put on the rail. */
export function onRail(project: ProjectRow): boolean {
  return typeof project.railAt === 'number' && !project.hidden
}

/**
 * The projects the rail shows: the ones the person put there, in the order they did, at most RAIL_PROJECTS. Until
 * they choose any, the oldest few, so the rail is never empty and nothing jumps around.
 */
export function railProjects(projects: ProjectRow[]): ProjectRow[] {
  const chosen = projects.filter(onRail).sort((a, b) => (a.railAt ?? 0) - (b.railAt ?? 0))
  if (chosen.length > 0) return chosen.slice(0, RAIL_PROJECTS)
  return projects
    .filter((project) => !project.hidden)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, RAIL_PROJECTS)
}

/** A project tile on the rail at full size, and the smaller size it drops to when the window is short. */
export const RAIL_TILE = 44
export const RAIL_TILE_SMALL = 32
/** A tile's padding above and below its icon at each size (projects.css .pj-app and .pj-rail.small .pj-app). */
export const RAIL_PAD = 14
export const RAIL_PAD_SMALL = 6

export interface RailRoom {
  /** Height the projects area has once the navigation, Settings and the account have taken theirs (px). */
  room: number
  /** Tiles per row. */
  cols: number
  /** Gap between rows (px). */
  gap: number
  /** One tile's height minus its icon and padding: the name under it and its gap when names show, else 0 (px). */
  extra: number
}

/** Room under the tiles of the rail's grid (its own top and bottom padding, projects.css .pj-rail). */
export const RAIL_BOX_PAD = 4

/**
 * The least height the projects area keeps, whatever else is on the rail (pinned apps above it): one row of small
 * tiles with their names, so at least the All tile and, when expanded, two projects always show. With no projects
 * it is the room of the + tile alone.
 */
export function railMinHeight(extra: number): number {
  return RAIL_PAD_SMALL + RAIL_TILE_SMALL + Math.max(0, extra) + RAIL_BOX_PAD
}

/** How the rail draws its projects: whether the tiles are small, and how many projects show before the All tile. */
export interface RailFit {
  small: boolean
  show: number
  /** Not even the All tile fits (the expanded rail still has its All link in the header). */
  none: boolean
}

function capacity(room: RailRoom, tile: number, pad: number): number {
  const row = room.extra + pad + tile + room.gap
  if (row <= 0) return 0
  return Math.max(0, Math.floor((room.room + room.gap) / row)) * Math.max(1, room.cols)
}

/**
 * The navigation always comes first; the projects take only the room that is left. Every project and the All tile
 * at full size if they fit; else the same at the smaller size; else fewer projects at the smaller size, the All tile
 * counting the rest. 
one when not even the All tile fits.
 */
export function fitRail(room: RailRoom, count: number): RailFit {
  const need = count + 1
  if (capacity(room, RAIL_TILE, RAIL_PAD) >= need) return { small: false, show: count, none: false }
  const small = capacity(room, RAIL_TILE_SMALL, RAIL_PAD_SMALL)
  if (small >= need) return { small: true, show: count, none: false }
  return { small: true, show: Math.max(0, Math.min(count, small - 1)), none: small === 0 }
}

/** Whether one more project can go on the rail. */
export function railHasRoom(projects: ProjectRow[]): boolean {
  return projects.filter(onRail).length < RAIL_PROJECTS
}

/** A fresh project chat id, the same shape the main process makes ("pc" + 16 letters and digits). */
export function newProjectChatId(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  return `pc${raw.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`
}

/** The glyphs offered for a project's icon (an emoji can be typed instead). */
export const PROJECT_GLYPHS: IconName[] = ['folder', 'building', 'code', 'term', 'globe', 'doc', 'mail', 'cal', 'chat', 'tasks', 'heart', 'bolt', 'shield', 'key', 'palette', 'monitor', 'phone', 'person', 'server', 'shot']

/** One emoji, or '' when the text is not one (letters, digits and long text are not icons). */
export function singleEmoji(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '' || /[A-Za-z0-9]/.test(trimmed)) return ''
  const chars = [...trimmed]
  return chars.length <= 4 && /\p{Extended_Pictographic}/u.test(trimmed) ? trimmed : ''
}

/** Who sent a message row that is not the person's (shared/sender.ts): a project, the main agent, a call, a helper. */
export interface Via {
  from: SenderKind
  name: string
  chat: string
  title: string
  /** The line drawn above it: "From your call", "From Hina, the main agent". */
  line: string
}

/** The sender of a row, or null when the person wrote it himself. */
export function viaOf(item: ChatItem): Via | null {
  const via = viaFromMeta(parseMeta(item.meta))
  if (via === null) return null
  return { from: via.from, name: via.name, chat: via.chat, title: via.title ?? '', line: senderLine(via) }
}

/** The icon beside who sent it. */
export function viaIcon(via: Via): IconName {
  if (via.from === 'call') return 'phone'
  if (via.from === 'main') return 'person'
  if (via.from === 'routine') return 'clock'
  if (via.from === 'worker' || via.from === 'system') return 'bolt'
  if (via.from === 'helper') return 'tasks'
  return 'folder'
}
