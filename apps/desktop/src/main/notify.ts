/**
 * OS notifications, wrapped small and testable without Electron (M7).
 *
 * A notification is only shown when the person allowed them and the app window is not already in
 * front of them. Clicking one brings the window forward and routes to the item it is about: a
 * waiting card in the chat, a chat's finished reply, or a routine's result.
 */
import { MAIN_CHAT, type RouteTarget } from '@agent/core'

export interface NotificationHandle {
  on(event: 'click', listener: () => void): void
  show(): void
  /** Takes it away again: a later notification for the same chat replaces the one before it. */
  close?(): void
}

export interface NotifierDeps {
  supported(): boolean
  create(options: { title: string; body: string }): NotificationHandle
  isFocused(): boolean
  /** The person's `settings.notifications` choice. */
  enabled(): boolean
  /** Bring the app window to the front. */
  focus(): void
  /** Tell the renderer to open a view. */
  route(target: RouteTarget): void
}

/** How much of a reply the shade shows: enough to know what it says, never a wall of text. */
export const REPLY_NOTIFICATION_CHARS = 220

/**
 * A model reply as a notification body: one flat line of the words it said. Code and card blocks are dropped
 * (the shade is no place for a program or an OpenUI tree), so a reply that was only a card or only code leaves
 * nothing, and nothing is what it returns.
 */
export function replyText(text: string, limit = REPLY_NOTIFICATION_CHARS): string {
  const withoutBlocks = text.replace(/```[\s\S]*?```/g, ' ')
  // A fence that never closed (a reply cut short) is dropped from where it starts.
  const fence = withoutBlocks.indexOf('```')
  const plain = fence === -1 ? withoutBlocks : withoutBlocks.slice(0, fence)
  const flat = plain
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*[#>*+-]+[ \t]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '') return ''
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`
}

export class Notifier {
  private readonly deps: NotifierDeps
  /** The notification showing for each chat, so a second reply in it replaces the first instead of stacking. */
  private readonly replies = new Map<string, NotificationHandle>()

  constructor(deps: NotifierDeps) {
    this.deps = deps
  }

  /** A question or approval card is waiting. */
  needsYou(itemId: string, title: string, body: string): boolean {
    return this.show(title, body, { view: 'chat', id: itemId })
  }

  /**
   * A chat's turn finished with something to say while the window was not in front of the person. One
   * notification per chat: a later reply closes the earlier one, so the shade holds the newest reply only.
   */
  replyFinished(chat: string, title: string, body: string): boolean {
    const name = title.trim() === '' ? 'Your agent' : title.trim()
    return this.show(name, body, { view: 'chat', id: chat === MAIN_CHAT ? '' : chat }, chat)
  }

  /** A background routine finished with something to say. */
  routineResult(triggerId: string, name: string, result: string): boolean {
    return this.show(`Routine finished: ${name}`, result, { view: 'routines', id: triggerId })
  }

  /** `replace`: the key of the notification this one stands in for (a chat), closed before this one shows. */
  private show(title: string, body: string, target: RouteTarget, replace?: string): boolean {
    if (!this.deps.enabled() || this.deps.isFocused() || !this.deps.supported()) return false
    if (replace !== undefined) this.drop(replace)
    try {
      const notification = this.deps.create({ title, body })
      if (replace !== undefined) this.replies.set(replace, notification)
      notification.on('click', () => {
        if (replace !== undefined && this.replies.get(replace) === notification) this.replies.delete(replace)
        this.deps.focus()
        this.deps.route(target)
      })
      notification.show()
      return true
    } catch {
      // A notification is a nicety; it must never take a run or the app down.
      return false
    }
  }

  /** Take away the notification showing for this chat, if any. */
  private drop(chat: string): void {
    const earlier = this.replies.get(chat)
    if (earlier === undefined) return
    this.replies.delete(chat)
    try {
      earlier.close?.()
    } catch {
      // Already gone from the shade: nothing to do.
    }
  }
}
