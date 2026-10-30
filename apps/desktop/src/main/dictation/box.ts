/**
 * A dictation's words into a message box, confirmed. The main process never decides that the words landed: it asks
 * the window, the window puts them in the chat's draft, reads them back and answers. No answer (the window is
 * reloading, crashed, closed) means they did not land, and the recording is offered back by the message box.
 * No Electron here, so the rule is tested on its own.
 */
import type { DictationBoxText } from '@agent/core'

export type BoxResult = 'confirmed' | 'refused' | 'gone' | 'timeout'

export interface BoxTarget {
  isDestroyed(): boolean
  isCrashed?(): boolean
  send(channel: string, payload: DictationBoxText): void
  once(event: 'render-process-gone' | 'destroyed', listener: () => void): unknown
  removeListener(event: 'render-process-gone' | 'destroyed', listener: () => void): unknown
}

/** How long a window may take to confirm. It only writes to its own store, so this is plenty. */
export const BOX_LIMIT_MS = 4000

/** Where the words of a dictation go: the chat its microphone belongs to, the cursor in this app, or another app. */
export type DictationRoute = { to: 'box'; chat: string } | { to: 'here' } | { to: 'other-app' }

export function dictationRoute(input: { source: 'mic' | 'shortcut'; chat: string | null; ownWindow: boolean }): DictationRoute {
  if (input.source === 'mic' && input.chat !== null) return { to: 'box', chat: input.chat }
  return input.ownWindow ? { to: 'here' } : { to: 'other-app' }
}

export class BoxDelivery {
  private readonly waiting = new Map<string, (result: BoxResult) => void>()

  constructor(
    private readonly channel: string,
    private readonly limitMs = BOX_LIMIT_MS,
  ) {}

  deliver(target: BoxTarget, message: DictationBoxText): Promise<BoxResult> {
    if (target.isDestroyed() || target.isCrashed?.() === true) return Promise.resolve('gone')
    return new Promise((resolve) => {
      const onGone = (): void => finish('gone')
      const timer = setTimeout(() => finish('timeout'), this.limitMs)
      const finish = (result: BoxResult): void => {
        if (this.waiting.get(message.id) !== finish) return
        this.waiting.delete(message.id)
        clearTimeout(timer)
        try {
          target.removeListener('render-process-gone', onGone)
          target.removeListener('destroyed', onGone)
        } catch {
          // A destroyed target may refuse; nothing to undo.
        }
        resolve(result)
      }
      this.waiting.set(message.id, finish)
      target.once('render-process-gone', onGone)
      target.once('destroyed', onGone)
      try {
        target.send(this.channel, message)
      } catch {
        finish('gone')
      }
    })
  }

  /** The window's answer. False when nothing was waiting for it any more (an answer after the limit). */
  answer(id: string, ok: boolean): boolean {
    const waiting = this.waiting.get(id)
    if (waiting === undefined) return false
    waiting(ok ? 'confirmed' : 'refused')
    return true
  }
}
