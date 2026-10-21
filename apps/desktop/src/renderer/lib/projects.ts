/**
 * Projects in the window: which project a chat belongs to, the ones the rail shows, a project chat id, and the
 * glyphs a project icon can use. Pure, so it is unit tested directly.
 */
import { MAIN_CHAT, type ChatItem, type ProjectRow } from '@agent/core'

import type { IconName } from '../ui/Icon'
import { parseMeta } from './meta'

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

/** Rows a message from another chat carries (tools/projects.ts): who sent it. */
export interface Via {
  from: 'main' | 'project'
  name: string
  chat: string
  title: string
}

export function viaOf(item: ChatItem): Via | null {
  const value = parseMeta(item.meta)['via']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if ((v['from'] !== 'main' && v['from'] !== 'project') || typeof v['name'] !== 'string') return null
  return { from: v['from'], name: v['name'], chat: typeof v['chat'] === 'string' ? v['chat'] : '', title: typeof v['title'] === 'string' ? v['title'] : '' }
}
