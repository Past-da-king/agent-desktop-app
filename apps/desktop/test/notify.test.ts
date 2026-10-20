import { describe, expect, it } from 'vitest'

import type { RouteTarget } from '@agent/core'

import { Notifier, type NotificationHandle, type NotifierDeps } from '../src/main/notify'

class FakeNotification implements NotificationHandle {
  shown = false
  private clickListeners: Array<() => void> = []

  constructor(readonly options: { title: string; body: string }) {}

  on(event: 'click', listener: () => void): void {
    if (event === 'click') this.clickListeners.push(listener)
  }

  show(): void {
    this.shown = true
  }

  click(): void {
    for (const listener of this.clickListeners) listener()
  }
}

function setup(overrides: Partial<NotifierDeps> = {}) {
  const created: FakeNotification[] = []
  const focused: number[] = []
  const routes: RouteTarget[] = []

  const notifier = new Notifier({
    supported: () => true,
    create: (options) => {
      const notification = new FakeNotification(options)
      created.push(notification)
      return notification
    },
    isFocused: () => false,
    enabled: () => true,
    focus: () => focused.push(Date.now()),
    route: (target) => routes.push(target),
    ...overrides,
  })

  return { notifier, created, focused, routes }
}

describe('Notifier', () => {
  it('shows a needs-you notification and routes to the card when clicked', () => {
    const { notifier, created, focused, routes } = setup()

    expect(notifier.needsYou('card-1', 'Your agent has a question', 'Which colour?')).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]?.options).toEqual({
      title: 'Your agent has a question',
      body: 'Which colour?',
    })
    expect(created[0]?.shown).toBe(true)

    created[0]?.click()
    expect(focused).toHaveLength(1)
    expect(routes).toEqual([{ view: 'chat', id: 'card-1' }])
  })

  it('shows a routine result and routes to the routine', () => {
    const { notifier, created, routes } = setup()

    expect(notifier.routineResult('routine-9', 'Morning brief', 'Two bills are due.')).toBe(true)
    expect(created[0]?.options.title).toBe('Routine finished: Morning brief')

    created[0]?.click()
    expect(routes).toEqual([{ view: 'routines', id: 'routine-9' }])
  })

  it('stays quiet while the window has the person\'s attention', () => {
    const { notifier, created } = setup({ isFocused: () => true })
    expect(notifier.needsYou('card-1', 'Question', 'Body')).toBe(false)
    expect(created).toEqual([])
  })

  it('stays quiet when notifications are turned off or unsupported', () => {
    const off = setup({ enabled: () => false })
    const unsupported = setup({ supported: () => false })
    expect(off.notifier.routineResult('r', 'Routine', 'Done')).toBe(false)
    expect(unsupported.notifier.routineResult('r', 'Routine', 'Done')).toBe(false)
    expect(off.created).toEqual([])
    expect(unsupported.created).toEqual([])
  })

  it('does not throw when the OS refuses to make a notification', () => {
    const { notifier } = setup({
      create: () => {
        throw new Error('no notification service')
      },
    })
    expect(notifier.needsYou('card-1', 'Question', 'Body')).toBe(false)
  })
})
