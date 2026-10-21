import { agent } from '../bridge'
import { useChats } from '../state/useChats'
import { useUi } from '../state/useUi'
import { chatOf } from './chats'
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
 * Start a fresh chat. The one you were in keeps going if it was working, keeps its context and stays in the rail;
 * nothing is deleted. Its conversation so far is filed into memory in the background (main/memory/service.ts),
 * and the new chat opens with a divider that says so. A chat with nothing in it yet is reused.
 */
export async function startNewChat(): Promise<void> {
  const ui = useUi.getState()
  const chats = useChats.getState()
  const previous = chats.open
  ui.navigate({ page: 'chat' })
  let used = true
  try {
    const rows = await agent.data.list('chat_item')
    used = rows.some((row) => chatOf(row) === previous && row.kind !== 'branch' && !isDivider(row))
  } catch {
    used = true
  }
  if (used) {
    const next = newChatId()
    chats.openChat(next)
    try {
      await agent.memory.newChat({ chat: next, from: previous })
    } catch {
      // An older main process without memory: the new chat simply starts empty.
    }
  }
  ui.focusComposer()
  ui.scrollChat()
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
