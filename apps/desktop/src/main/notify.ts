/**
 * OS notifications, wrapped small and testable without Electron (M7).
 *
 * A notification is only shown when the person allowed them and the app window is not already in
 * front of them. Clicking one brings the window forward and routes to the item it is about: a
 * waiting card in the chat, or a routine's result.
 */
import type { RouteTarget } from '@agent/core'

export interface NotificationHandle {
  on(event: 'click', listener: () => void): void
  show(): void
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

export class Notifier {
  private readonly deps: NotifierDeps

  constructor(deps: NotifierDeps) {
    this.deps = deps
  }

  /** A question or approval card is waiting. */
  needsYou(itemId: string, title: string, body: string): boolean {
    return this.show(title, body, { view: 'chat', id: itemId })
  }

  /** A background routine finished with something to say. */
  routineResult(triggerId: string, name: string, result: string): boolean {
    return this.show(`Routine finished: ${name}`, result, { view: 'routines', id: triggerId })
  }

  private show(title: string, body: string, target: RouteTarget): boolean {
    if (!this.deps.enabled() || this.deps.isFocused() || !this.deps.supported()) return false
    try {
      const notification = this.deps.create({ title, body })
      notification.on('click', () => {
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
}
