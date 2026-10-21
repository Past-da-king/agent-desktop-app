import { MAIN_CHAT, type ChatItem, type ProjectRow } from '@agent/core'

import { agent } from '../bridge'
import { useChats } from '../state/useChats'
import { useUi } from '../state/useUi'
import { chatOf } from './chats'
import { newProjectChatId, projectOfChat } from './projects'
import { isDivider } from './thread'
import { toast } from '../state/useToast'

/** A fresh chat id, the same shape the main process makes (c + 16 letters and digits). */
export function newChatId(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  return `c${raw.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`
}

/**
 * New chat. In the main thread it is not a new chat: the conversation is compressed into a summary in the
 * background and the agent carries on fresh with it (main/memory/service.ts compressChat), and the old stretch is
 * filed into memory. In a project chat it opens a new chat in that project (startProjectChat).
 */
export async function startNewChat(): Promise<void> {
  const ui = useUi.getState()
  const previous = useChats.getState().open
  let projects: ProjectRow[] = []
  try {
    projects = await agent.data.list('project')
  } catch {
    projects = []
  }
  const project = projectOfChat(projects, previous)
  if (project !== null) {
    await startProjectChat(project)
    return
  }
  openChat(MAIN_CHAT)
  try {
    await agent.memory.newChat({ chat: MAIN_CHAT, from: MAIN_CHAT })
  } catch {
    // An older main process without memory: the thread simply carries on.
  }
  ui.focusComposer()
  ui.scrollChat()
}

/**
 * A new chat in a project: its own agent with its own context. The project chat the person was in keeps going;
 * what it said so far is filed into memory in the background. A project chat with nothing in it yet is reused.
 */
export async function startProjectChat(project: ProjectRow): Promise<void> {
  const ui = useUi.getState()
  const previous = useChats.getState().open
  let rows: ChatItem[] = []
  try {
    rows = await agent.data.list('chat_item')
  } catch {
    rows = []
  }
  const empty = project.chats.find((chat) => !rows.some((row) => chatOf(row) === chat && row.kind !== 'branch' && !isDivider(row)))
  if (empty !== undefined) {
    openChat(empty)
    ui.focusComposer()
    return
  }
  const next = newProjectChatId()
  await agent.data.upsert('project', { id: project.id, chats: [...project.chats, next] })
  openChat(next)
  if (project.chats.includes(previous)) {
    try {
      await agent.memory.newChat({ chat: next, from: previous })
    } catch {
      // Filing is a bonus; the new chat simply starts empty.
    }
  }
  ui.focusComposer()
}

/** Open a chat from the rail. */
export function openChat(chat: string): void {
  useChats.getState().openChat(chat)
  useUi.getState().navigate({ page: 'chat' })
  useUi.getState().scrollChat()
}

/** A new chat with the history up to this message; the old chat stays as it was. Opens the new one. */
export async function branchFrom(itemId: string): Promise<void> {
  try {
    const chat = await agent.chat.branch(itemId)
    openChat(chat)
    useUi.getState().focusComposer()
    toast('Branched into a new chat. The old one is unchanged.')
  } catch (error) {
    toast(error instanceof Error && error.message !== '' ? `Could not branch: ${error.message}` : 'Could not branch from that message.')
  }
}
