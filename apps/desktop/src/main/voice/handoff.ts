/**
 * A call on a linked phone hands work to the RIGHT agent on this computer (22 Oct 2026, Ayanda: "tell the Agent
 * Desktop App project to...", "ask the dictation helper..."). Two RPCs: `voice.callTargets` lists who is there to talk
 * to (the main agent, each project with its chats and what they are doing, the helpers at work) so the voice knows,
 * and `voice.callHandoff` puts the message in front of the one named: the main chat, a project chat (or a new chat in
 * that project), or a helper (steered, as helper_steer does). Names are matched the forgiving way project_open
 * matches them (packages/core find.ts); two close matches come back for the voice to ask which, never a guess.
 */
import {
  MAIN_CHAT,
  findMatches,
  pickMatch,
  projectFields,
  type CallHandoffInput,
  type CallHandoffResult,
  type CallTarget,
  type ChatItem,
  type FindField,
  type HelperCardsSnapshot,
  type ProjectRow,
  type RunState,
} from '@agent/core'

import { chatTitle, newProjectChatId } from '../runtime/chat-lines'

export interface CallHandoffDeps {
  store: {
    list(entity: 'project'): Promise<ProjectRow[]>
    list(entity: 'chat_item'): Promise<ChatItem[]>
    upsert(entity: 'project', row: Partial<ProjectRow> & { id: string }): Promise<unknown>
  }
  /** A message in a chat as if the person typed it there (runner.send, with the calling device as its origin). */
  send(text: string, chat: string, origin?: unknown): Promise<void>
  /** More for a helper at work, or sends a finished one back to work (helper_steer). */
  steer(id: string, message: string): Promise<string>
  /** The helper cards a linked device sees (helpers.cards). */
  cards(): Promise<HelperCardsSnapshot>
  state(chat: string): RunState
  agentName(): string
}

/** Words that name no one in particular: "tell the dictation helper", "ask the chat in ...". */
const NOISE = new Set(['helper', 'helpers', 'chat', 'chats', 'agent', 'agents', 'tell', 'ask', 'send', 'in', 'on', 'it', 'that', 'this', 'one', 'the', 'project'])
const MAIN_NAMES = new Set(['', 'main', 'main agent', 'main chat', 'the main agent', 'agent', 'my agent', 'your agent', 'you', 'yourself'])
/** Helpers worth talking to: at work, or finished in the last hour (a steer sends it back to work). */
const RECENT_MS = 60 * 60_000

function clean(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && !NOISE.has(word))
    .join(' ')
}

function chatOf(row: ChatItem): string {
  try {
    const meta = JSON.parse(row.meta) as Record<string, unknown>
    return typeof meta['chat'] === 'string' && meta['chat'] !== '' ? meta['chat'] : MAIN_CHAT
  } catch {
    return MAIN_CHAT
  }
}

function short(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/** Everyone the call can talk to, main agent first. */
export async function callTargets(deps: CallHandoffDeps, now: number = Date.now()): Promise<CallTarget[]> {
  const [projects, rows, cards] = await Promise.all([deps.store.list('project'), deps.store.list('chat_item'), deps.cards().catch(() => null)])
  const byChat = new Map<string, ChatItem[]>()
  for (const row of rows) {
    const chat = chatOf(row)
    const list = byChat.get(chat)
    if (list === undefined) byChat.set(chat, [row])
    else list.push(row)
  }
  const sorted = (chat: string): ChatItem[] => (byChat.get(chat) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt)
  const lastLine = (chat: string): string => {
    const own = sorted(chat).filter((row) => (row.kind === 'agent' || row.kind === 'activity') && row.text.trim() !== '')
    return short(own[own.length - 1]?.text ?? '', 140)
  }
  const main = deps.state(MAIN_CHAT)
  const out: CallTarget[] = [
    { kind: 'main', id: MAIN_CHAT, name: deps.agentName().trim() || 'Your agent', glyph: '', running: main.running, doing: main.running ? lastLine(MAIN_CHAT) : '', chats: [] },
  ]
  for (const project of projects) {
    if (project.hidden) continue
    const chats = project.chats.map((chat) => {
      const running = deps.state(chat).running
      return { id: chat, title: chatTitle(sorted(chat)), running, doing: running ? lastLine(chat) : '' }
    })
    const busy = chats.find((chat) => chat.running)
    out.push({ kind: 'project', id: project.id, name: project.name, glyph: project.icon.glyph, running: busy !== undefined, doing: busy?.doing ?? '', chats })
  }
  for (const card of cards?.cards ?? []) {
    if (card.id.startsWith('pa-') || card.projectChat !== '') continue
    const live = card.state === 'working'
    if (!live && (card.endedAt === null || now - card.endedAt > RECENT_MS)) continue
    out.push({ kind: 'helper', id: card.id, name: card.label, glyph: '', running: live, doing: short(live ? card.line : card.done, 140), chats: [] })
  }
  return out
}

interface Hit {
  kind: 'project' | 'chat' | 'helper'
  id: string
  name: string
  project?: ProjectRow
}

/** Hands `message` to the one `target` names; asks back when two are close or none is. */
export async function callHandoff(deps: CallHandoffDeps, input: CallHandoffInput, origin?: unknown): Promise<CallHandoffResult> {
  const message = input.message.trim()
  if (message === '') return { ok: false, error: 'Pass the message.', ambiguous: [] }
  const said = input.target.trim()
  const kind = input.kind ?? ''
  const wanted = said.toLowerCase()
  const mainName = deps.agentName().trim() || 'Your agent'
  if (kind === 'main' || MAIN_NAMES.has(wanted) || wanted === mainName.toLowerCase()) {
    await deps.send(message, MAIN_CHAT, origin)
    return { ok: true, kind: 'main', id: MAIN_CHAT, name: mainName, chat: MAIN_CHAT, said: 'Sent to your main agent.', detail: '' }
  }

  const targets = await callTargets(deps)
  const projects = (await deps.store.list('project')).filter((p) => !p.hidden || p.id === said)
  const candidates: Array<{ item: Hit; fields: FindField[] }> = []
  if (kind === '' || kind === 'project') {
    for (const project of projects) {
      candidates.push({ item: { kind: 'project', id: project.id, name: project.name, project }, fields: projectFields(project) })
      // A project chat by its title ("the dictation chat in Agent Desktop App").
      for (const chat of targets.find((t) => t.kind === 'project' && t.id === project.id)?.chats ?? []) {
        if (chat.title === 'New chat') continue
        candidates.push({
          item: { kind: 'chat', id: chat.id, name: `"${chat.title}" in ${project.name}`, project },
          fields: [
            { text: chat.title, weight: 0.8, fuzzy: false },
            { text: project.name, weight: 0.5 },
          ],
        })
      }
    }
  }
  if (kind === '' || kind === 'helper') {
    for (const t of targets) if (t.kind === 'helper') candidates.push({ item: { kind: 'helper', id: t.id, name: t.name }, fields: [{ text: t.name, weight: 1 }] })
  }

  // An exact id or name first, then the forgiving matcher.
  const exact = candidates.find((c) => c.item.id === said) ?? candidates.find((c) => c.item.kind !== 'chat' && c.item.name.toLowerCase() === wanted)
  let hit: Hit | null = exact?.item ?? null
  if (hit === null) {
    const query = clean(said)
    const picked = pickMatch(findMatches(query === '' ? said : query, candidates))
    hit = picked.winner?.item ?? null
    // A project and its own chats are one answer: the project.
    const first = picked.close[0]?.item
    if (hit === null && first?.project !== undefined && picked.close.every((c) => c.item.project?.id === first.project?.id)) {
      hit = { kind: 'project', id: first.project.id, name: first.project.name, project: first.project }
    }
    if (hit === null) {
      const close = picked.close.map((c) => ({ kind: c.item.kind, id: c.item.id, name: c.item.name }))
      if (close.length > 1) return { ok: false, error: `"${said}" could be ${close.map((c) => c.name).join(' or ')}. Ask which one.`, ambiguous: close }
      return { ok: false, error: `No project, chat or helper called "${said}". Ask who it is for, or send it to the main agent (target main), which routes it itself.`, ambiguous: [] }
    }
  }

  if (hit.kind === 'helper') {
    const answer = await deps.steer(hit.id, `From the person, on a voice call: ${message}`)
    return { ok: true, kind: 'helper', id: hit.id, name: hit.name, chat: '', said: `Sent to the helper "${hit.name}".`, detail: short(answer, 200) }
  }
  const project = hit.project
  if (project === undefined) return { ok: false, error: 'That project is gone.', ambiguous: [] }
  let chat = hit.kind === 'chat' ? hit.id : ''
  if (chat === '' && input.newChat !== true) {
    const own = targets.find((t) => t.kind === 'project' && t.id === project.id)
    chat = own?.chats.find((c) => c.running)?.id ?? project.chats[project.chats.length - 1] ?? ''
  }
  const fresh = chat === '' || input.newChat === true
  if (fresh) {
    chat = newProjectChatId()
    await deps.store.upsert('project', { id: project.id, chats: [...project.chats, chat] })
  }
  await deps.send(message, chat, origin)
  return {
    ok: true,
    kind: hit.kind === 'chat' ? 'chat' : 'project',
    id: project.id,
    name: project.name,
    chat,
    said: fresh ? `Started a new chat in the ${project.name} project.` : hit.kind === 'chat' ? `Sent to the chat ${hit.name}.` : `Sent to the ${project.name} project.`,
    detail: '',
  }
}
