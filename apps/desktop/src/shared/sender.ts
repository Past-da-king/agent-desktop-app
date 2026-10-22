/**
 * Who really sent a message row (kind 'user'). A row with no `meta.via` is the person's own; any other sender writes
 * `meta.via` so every window draws it as not his (22 Oct 2026: a call's hand-off showed as if he typed it). The phone
 * reads the same field over the link (phone remote/Sender.kt mirrors this file).
 *
 *   main     the main agent writing into a project chat
 *   project  a project chat writing to the main thread (message_main)
 *   call     a voice call handing its work to a chat
 *   helper   a helper's message into a chat
 *   routine  a routine or a desk
 *   worker   a background worker
 *   system   the app itself
 */
export const SENDER_KINDS = ['main', 'project', 'call', 'helper', 'routine', 'worker', 'system'] as const
export type SenderKind = (typeof SENDER_KINDS)[number]

/** Who a message came from, as the receiving chat shows it. */
export interface ChatVia {
  from: SenderKind
  /** The main agent's name, the project's, the helper's or the routine's; for a call, the device it was on (or ''). */
  name: string
  /** The sending chat, when there is one. */
  chat: string
  /** The sending chat's title (a project chat). */
  title?: string
}

/** The sender of work a voice call hands to a chat. */
export function callVia(device = ''): ChatVia {
  return { from: 'call', name: device.trim(), chat: '' }
}

function isKind(value: unknown): value is SenderKind {
  return typeof value === 'string' && (SENDER_KINDS as readonly string[]).includes(value)
}

/** The sender recorded in a row's parsed meta, or null for the person. */
export function viaFromMeta(meta: Record<string, unknown>): ChatVia | null {
  const value = meta['via']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isKind(v['from'])) return null
  const name = typeof v['name'] === 'string' ? v['name'] : ''
  if (name === '' && v['from'] !== 'call' && v['from'] !== 'system') return null
  const title = typeof v['title'] === 'string' && v['title'] !== '' ? { title: v['title'] } : {}
  return { from: v['from'], name, chat: typeof v['chat'] === 'string' ? v['chat'] : '', ...title }
}

/** The line above a message that is not his: "From your call", "From Hina, the main agent", "From Agent Desktop App". */
export function senderLine(via: ChatVia): string {
  switch (via.from) {
    case 'main':
      return `From ${via.name}, the main agent`
    case 'project':
      return `From ${via.name}${via.title === undefined || via.title === '' ? '' : ` · ${via.title}`}`
    case 'call':
      return via.name === '' ? 'From your call' : `From your call on ${via.name}`
    case 'helper':
      return `From the helper ${via.name}`
    case 'routine':
      return `From the routine ${via.name}`
    case 'worker':
      return `From ${via.name}`
    case 'system':
      return via.name === '' ? 'From the app' : `From ${via.name}`
  }
}

/** The label a message from another sender carries for the model reading it. */
export function viaLabel(via: ChatVia): string {
  switch (via.from) {
    case 'main':
      return `[From ${via.name}, the main agent]`
    case 'project':
      return `[From project ${via.name}${via.title === undefined || via.title === '' ? '' : `, chat "${via.title}"`}]`
    case 'call':
      return '[From our voice call]'
    default:
      return `[${senderLine(via)}]`
  }
}
