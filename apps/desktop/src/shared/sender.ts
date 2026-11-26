import { PROFILE_COLORS, type ProjectIcon } from '@agent/core'

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
export const SENDER_KINDS = ['main', 'project', 'call', 'helper', 'routine', 'worker', 'system', 'device', 'desk'] as const
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
  id?: string
  icon?: ProjectIcon
  /** App-recorded user message this handoff belongs to. */
  requestId?: string
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
  const rawIcon = v['icon']
  let icon: ProjectIcon | undefined
  if (typeof rawIcon === 'object' && rawIcon !== null && !Array.isArray(rawIcon)) {
    const i = rawIcon as Record<string, unknown>
    if (typeof i['glyph'] === 'string' && (PROFILE_COLORS as readonly unknown[]).includes(i['color'])) icon = { glyph: i['glyph'], color: i['color'] as ProjectIcon['color'] }
  }
  return { ...(typeof v['requestId'] === 'string' ? { requestId: v['requestId'] } : {}), ...(typeof v['id'] === 'string' ? { id: v['id'] } : {}), ...(icon === undefined ? {} : { icon }), from: v['from'], name, chat: typeof v['chat'] === 'string' ? v['chat'] : '', ...title }
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
    case 'device':
    case 'desk':
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

/** Read-time recovery only for anchored app-generated envelopes. Never guess from message prose. */
export function legacyVia(text: string): ChatVia | null {
  const project = /^\[From project ([^\]\n]+)\]/.exec(text)
  if (project) return { from: 'project', name: project[1]!.split(', chat "')[0]!, chat: '' }
  const helper = /^\[Helper #([^ "\]\n]+)(?: "([^"\n]+)")?[^\]\n]*\]/.exec(text)
  if (helper) return { from: 'helper', id: helper[1]!, name: helper[2] || helper[1]!, chat: '' }
  if (/^\[Helpers finished:/.test(text)) return { from: 'helper', name: 'Helper results', chat: '' }
  const main = /^\[From ([^\]\n]+), the main agent\]/.exec(text)
  if (main) return { from: 'main', name: main[1]!, chat: 'main' }
  return null
}

/** Hide only the redundant app envelope in a sender card. Stored and model text remain intact. */
export function senderBody(text: string): string {
  return legacyVia(text) === null ? text : text.slice(text.indexOf(']') + 1).trimStart()
}

/** One definition for whether a stored user row is actually the person's own words. */
export function senderOfRow(row: { kind: string; text: string; meta: string }): ChatVia | null {
  if (row.kind !== 'user') return null
  let meta: Record<string, unknown> = {}
  try { meta = JSON.parse(row.meta) as Record<string, unknown> } catch { /* Old malformed meta still permits envelope recovery. */ }
  const sender = viaFromMeta(meta ?? {})
  if (sender !== null) return sender
  return meta?.['own'] === true ? null : legacyVia(row.text)
}

export function isOwnMessage(row: { kind: string; text: string; meta: string }): boolean {
  return row.kind === 'user' && senderOfRow(row) === null
}

/** Trusted tool context, not message content, determines who sent an agent action. */
export function toolVia(ctx: { owner?: string; agentLabel: string; chat?: string }): ChatVia {
  const owner = ctx.owner ?? 'main'
  return { from: owner.startsWith('helper:') ? 'helper' : owner === 'routine' ? 'routine' : 'main', id: owner.replace(/^helper:/, ''), name: ctx.agentLabel || 'Agent', chat: ctx.chat ?? 'main' }
}

// ---- Live voice hand-offs ------------------------------------------------------------------------------------------
//
// The phone's Live voice assistant (Gemini Live, tool hand_to_agent) hands a job to the agent in ITS OWN words. That is
// not what he typed and not what he said. A Live session is a call (same as a voice call, but it can see), so its
// hand-offs fold into the call block and never draw as a user bubble; the agent is told what it is.
//
// Wire contract (docs: apps/desktop docs live-voice-handoff.md): a phone send (`chat.send` options, `chat.sendOnce`
// input, `voice.callHandoff` input) may carry `origin: "live_voice"`, `spoken: "<his words>"` and `session: "<id>"`,
// at the top level or inside `meta` / `metadata`, or as one object `live: { spoken, session }`.

export const LIVE_ORIGIN = 'live_voice'

/** A hand-off from a Live session: his own words (when known) and the session (its call block) it belongs to. */
export interface LiveHandoff {
  spoken: string
  session: string
}

const MAX_SPOKEN = 2000

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return null
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** The Live hand-off a send, or a call hand-off, carries; null for anything else (his own message). */
export function liveFromInput(raw: unknown): LiveHandoff | null {
  const top = asObject(raw)
  if (top === null) return null
  const explicit = asObject(top['live'])
  const places = [explicit, top, asObject(top['meta']), asObject(top['metadata'])]
  for (const place of places) {
    if (place === null) continue
    const origin = place['origin']
    const named = origin === LIVE_ORIGIN || (typeof origin === 'object' && origin !== null && (origin as Record<string, unknown>)['kind'] === LIVE_ORIGIN)
    if (!named && place !== explicit) continue
    return { spoken: text(place['spoken'], MAX_SPOKEN), session: text(place['session'] ?? place['sessionId'] ?? place['callId'], 80) }
  }
  return null
}

/** The Live hand-off a stored row's meta records (`meta.live`), or null. */
export function liveFromMeta(meta: Record<string, unknown>): LiveHandoff | null {
  const live = asObject(meta['live'])
  if (live === null) return null
  return { spoken: text(live['spoken'], MAX_SPOKEN), session: text(live['session'], 80) }
}

/** What the agent reads in front of a Live hand-off, so it answers him and not the assistant. */
export function liveLabel(live: LiveHandoff): string {
  const said = live.spoken === '' ? 'His exact words were not kept.' : `He actually said: "${live.spoken.replace(/\s+/g, ' ')}"`
  return `[Hand-off from his Live voice assistant. The request below is the assistant's own paraphrase, not his words. ${said} Your answer is read to him aloud by the assistant, so reply to him in plain spoken words.]\n`
}
