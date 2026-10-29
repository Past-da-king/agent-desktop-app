/**
 * "@Acme fix the follow-ups" (29 Oct 2026): a message that names one of his projects with '@' goes to that project's
 * current chat, as his own message there, instead of the chat it was typed in. The chat it was typed in keeps one line,
 * "Sent to Acme", that opens the project chat. Every client gets it the same way because it sits on the chat runner
 * the window and every linked device send through (main/ipc.ts chat.send); the picker only helps type the name.
 *
 * Which chat: one at work in that project, else the one he used last, else a new one (made the way project_chat_start
 * makes one). The list behind the picker is small and fingerprinted, so a phone on mobile data asks "still the same?"
 * and gets a few bytes back (chat.mentions).
 */
import { MAIN_CHAT, type Attachment, type ChatItem, type JsonObject, type ProjectRow, type RunState } from '@agent/core'

import { mentionProjects, mentionStamp, parseMention, type MentionNotice, type MentionProject, type MentionReply } from '../../shared/mentions'
import { chatOf, chatTag, newProjectChatId, newestOfChat } from './chat-lines'
import type { DataStore } from './data'

export interface MentionDeps {
  store: Pick<DataStore, 'list' | 'listWhere' | 'upsert'>
  state(chat: string): RunState
  /** Says a chat changed, so open windows redraw it (the notice row arrives as a data change anyway). */
  changed?(chat: string): void
  /** How often the reply watch looks at the project chat's run (ms); tests make it short. */
  pollMs?: number
  /** How long a reply may take before the watch gives up (ms). */
  replyWaitMs?: number
  now?(): number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function clipLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/**
 * Sends his words into a project chat, leaves "Sent to X" in the chat they came from, and once the project's agent has
 * answered puts that answer there too, as a card he can open or reply on (29 Oct 2026: a mention sent from the phone
 * must come back to the phone). The watch reads only that chat's run state and its newest rows, by index.
 */
export async function routeTo(
  deps: MentionDeps,
  args: { text: string; attachments: Attachment[]; from: string; project: ProjectRow; chat: string; fresh: boolean; send: (text: string, attachments: Attachment[], chat: string) => Promise<void> },
): Promise<MentionNotice> {
  const { project, chat, from } = args
  const now = deps.now ?? Date.now
  const notice: MentionNotice = { project: project.id, name: project.name, chat, fresh: args.fresh }
  const said = clipLine(args.text, 140)
  const meta: JsonObject = { ...chatTag(from), mention: { ...notice, said } as unknown as JsonObject }
  const sent = await deps.store.upsert('chat_item', { kind: 'notice', text: `Sent to ${project.name}`, meta: JSON.stringify(meta) } as Partial<ChatItem> as ChatItem)
  deps.changed?.(from)
  const since = Math.min(sent.createdAt, now()) - 1
  // His own words in the project's chat. The turn there can run for minutes: never waited on here.
  void (async () => {
    try {
      await args.send(args.text, args.attachments, chat)
    } catch {
      // The project chat says what went wrong itself.
    }
    await watchReply(deps, notice, project, from, since)
  })().catch(() => undefined)
  return notice
}

/** Waits for the project chat to finish answering, then copies its answer into the chat the message came from. */
async function watchReply(deps: MentionDeps, notice: MentionNotice, project: ProjectRow, from: string, since: number): Promise<void> {
  const poll = deps.pollMs ?? 1500
  const now = deps.now ?? Date.now
  const giveUp = now() + (deps.replyWaitMs ?? 3 * 60 * 60_000)
  const answers = async (): Promise<ChatItem[]> =>
    (await newestOfChat(deps.store as DataStore, notice.chat, ['agent'], 10)).filter((row) => chatOf(row) === notice.chat && row.createdAt > since && row.text.trim() !== '')
  let quietSince = 0
  while (now() < giveUp) {
    if (deps.state(notice.chat).running) {
      quietSince = 0
    } else {
      const found = await answers()
      // An answer and a quiet chat (a run that ended, or one on another computer that has written): settled once it
      // stays quiet for two looks, so a reply still streaming in is not cut short.
      if (found.length > 0) {
        if (quietSince === 0) quietSince = now()
        else {
          const last = found[0] as ChatItem
          const reply: MentionReply = { ...notice, fresh: false, glyph: project.icon.glyph, color: project.icon.color }
          await deps.store.upsert('chat_item', { kind: 'notice', text: last.text, meta: JSON.stringify({ ...chatTag(from), mentionReply: reply as unknown as JsonObject }) } as Partial<ChatItem> as ChatItem)
          deps.changed?.(from)
          return
        }
      }
    }
    await sleep(poll)
  }
}

/**
 * His reply on a project's card ("reply on that card"): it goes to that same project chat, and its answer comes back to
 * the chat the card is in. False when `chat` is no project's chat (then it is an ordinary send).
 */
export async function replyToProjectChat(
  deps: MentionDeps,
  text: string,
  attachments: Attachment[],
  chat: string,
  replyIn: string,
  send: (text: string, attachments: Attachment[], chat: string) => Promise<void>,
): Promise<boolean> {
  if (chat === replyIn || (text.trim() === '' && attachments.length === 0)) return false
  const project = (await deps.store.list('project')).find((row) => row.chats.includes(chat))
  if (project === undefined || project.chats.includes(replyIn)) return false
  await routeTo(deps, { text: text.trim(), attachments, from: replyIn, project, chat, fresh: false, send })
  return true
}

/** The picker's list, or only "same" when the caller already has this one. */
export async function mentionList(deps: Pick<MentionDeps, 'store'>, since?: string): Promise<{ stamp: string; projects?: MentionProject[]; same?: true }> {
  const projects = mentionProjects(await deps.store.list('project'))
  const stamp = mentionStamp(projects)
  return since === stamp ? { stamp, same: true } : { stamp, projects }
}

/** The project chat a mention goes to: at work, else the newest activity, else '' for a new one. */
export async function currentChatOf(deps: MentionDeps, project: ProjectRow): Promise<string> {
  const working = project.chats.find((chat) => deps.state(chat).running)
  if (working !== undefined) return working
  let best = ''
  let bestAt = -1
  for (const chat of project.chats) {
    const newest = await newestOfChat(deps.store as DataStore, chat, ['user', 'agent'], 5)
    const at = newest.find((row) => chatOf(row) === chat)?.createdAt ?? 0
    // Ties (two empty chats) go to the later one in the list: the newer chat.
    if (at >= bestAt) {
      best = chat
      bestAt = at
    }
  }
  return best
}

export interface RoutedMention extends MentionNotice {
  rest: string
}

/**
 * Sends the message to the project it names and leaves the notice in the chat it came from; null when it names no
 * project (or two), or is typed inside the very project it names: then it goes where it was typed, as before.
 */
export async function routeMention(
  deps: MentionDeps,
  text: string,
  attachments: Attachment[],
  from: string,
  send: (text: string, attachments: Attachment[], chat: string) => Promise<void>,
): Promise<RoutedMention | null> {
  if (!text.includes('@')) return null
  const rows = await deps.store.list('project')
  const parsed = parseMention(text, mentionProjects(rows))
  if (parsed === null) return null
  if (parsed.rest === '' && attachments.length === 0) return null
  const project = rows.find((row) => row.id === parsed.project.id)
  if (project === undefined || project.chats.includes(from)) return null
  let chat = await currentChatOf(deps, project)
  const fresh = chat === ''
  if (fresh) {
    chat = newProjectChatId()
    await deps.store.upsert('project', { id: project.id, chats: [...project.chats, chat] })
  }
  const notice = await routeTo(deps, { text: parsed.rest === '' ? text.trim() : parsed.rest, attachments, from, project, chat, fresh, send })
  return { ...notice, rest: parsed.rest }
}

/**
 * The chat runner the window and linked devices send through, with mentions routed first. Everything else passes
 * straight through to `runner` (a Proxy, as devices/offload-wire.ts wraps the same runner).
 */
export function withMentions<T extends object>(runner: T, deps: MentionDeps): T {
  // A caller with no chat side (a test of other IPC groups) keeps none.
  if (typeof runner !== 'object' || runner === null) return runner
  return new Proxy(runner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (prop !== 'send' || typeof value !== 'function') return value
      const send = value as (text: string, attachments?: Attachment[], chat?: string, origin?: unknown) => Promise<void>
      return async (text: string, attachments?: Attachment[], chat?: string, origin?: unknown): Promise<void> => {
        const from = chat ?? MAIN_CHAT
        const routed = typeof text === 'string' ? await routeMention(deps, text, attachments ?? [], from, (words, files, to) => send.call(target, words, files, to, origin)).catch(() => null) : null
        if (routed !== null) return
        // Called the way the caller called it: the runner's defaults stay its own.
        if (origin !== undefined) return send.call(target, text, attachments, chat, origin)
        if (chat !== undefined) return send.call(target, text, attachments, chat)
        return send.call(target, text, attachments)
      }
    },
  })
}
