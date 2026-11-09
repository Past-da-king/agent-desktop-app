/**
 * Which of the window's chat rows the chat view listens to. A helper at work writes a row per step into the chat that
 * started it; those steps are drawn inside the helper's own card (the side panel), never in the conversation, so the
 * conversation must not be worked out again for each of them. The view takes two selections: the conversation's rows
 * (everything of the chat but helper steps) and, only when the chat shows a side run, the helper steps. Rows that did
 * not change keep their identity in the store (lib/patch.ts), so a shallow compare of a selection says whether the
 * view has anything new to draw. Pure, so the view and the test share one definition.
 */
import type { ChatItem } from '@agent/core'

import { chatOf } from './chats'
import { isHelperActivity } from './helpers'

/** The rows of one chat that the conversation is made of: all of them but the steps helpers took. */
export function threadRowsOf(all: readonly ChatItem[], chat: string): ChatItem[] {
  return all.filter((item) => chatOf(item) === chat && !isHelperActivity(item))
}

/** The steps helpers took in one chat (drawn inside a side run's block). */
export function helperStepRowsOf(all: readonly ChatItem[], chat: string): ChatItem[] {
  return all.filter((item) => chatOf(item) === chat && isHelperActivity(item))
}

/** Both selections back in the store's order (oldest first). */
export function mergeRows(thread: ChatItem[], steps: readonly ChatItem[]): ChatItem[] {
  if (steps.length === 0) return thread
  return [...thread, ...steps].sort((a, b) => a.createdAt - b.createdAt)
}

/** A selection worked out once per list: the store hands the same list back until a chat row changes. */
export function rowsSelector(pick: (all: readonly ChatItem[], chat: string) => ChatItem[]): (all: readonly ChatItem[], chat: string) => ChatItem[] {
  let lastAll: readonly ChatItem[] | null = null
  let lastChat = ''
  let lastOut: ChatItem[] = []
  return (all, chat) => {
    if (all === lastAll && chat === lastChat) return lastOut
    lastAll = all
    lastChat = chat
    lastOut = pick(all, chat)
    return lastOut
  }
}

/**
 * What a step shows as. A step still marked running while its chat is neither working nor waiting on the person was
 * cut off (the run died, the app closed): it is "interrupted", not spinning for ever. A step waiting on an approval
 * or a question keeps running, because the chat is waiting then.
 */
export function shownStepStatus(status: string, chatIdle: boolean): string {
  return status === 'running' && chatIdle ? 'interrupted' : status
}

/** A chat is idle when its run state is known, nothing runs in it or alongside it, and no card waits. */
export function chatIsIdle(run: { known: boolean; running: boolean; alongside: number; waiting: number }): boolean {
  return run.known && !run.running && run.alongside === 0 && run.waiting === 0
}
