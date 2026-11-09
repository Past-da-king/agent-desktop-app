import { describe, expect, it } from 'vitest'

import type { RouteTarget } from '@agent/core'

import { Notifier, replyText, type NotificationHandle, type NotifierDeps } from '../src/main/notify'

class FakeNotification implements NotificationHandle {
  shown = false
  closed = false
  private clickListeners: Array<() => void> = []

  constructor(readonly options: { title: string; body: string }) {}

  on(event: 'click', listener: () => void): void {
    if (event === 'click') this.clickListeners.push(listener)
  }

  show(): void {
    this.shown = true
  }

  close(): void {
    this.closed = true
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

  it('says a chat finished with its reply, under the agent name, and opens that chat when clicked', () => {
    const { notifier, created, focused, routes } = setup()

    expect(notifier.replyFinished('main', 'Nova', 'The three files are pushed.')).toBe(true)
    expect(created[0]?.options).toEqual({ title: 'Nova', body: 'The three files are pushed.' })
    expect(created[0]?.shown).toBe(true)

    created[0]?.click()
    expect(focused).toHaveLength(1)
    // The first chat's own target: the window opens at the newest message there.
    expect(routes).toEqual([{ view: 'chat', id: '' }])
  })

  it('opens the chat a project reply came from, and falls back to a plain name with no agent name', () => {
    const { notifier, created, routes } = setup()

    notifier.replyFinished('pc123abc', '   ', 'The gallery is fixed.')
    expect(created[0]?.options.title).toBe('Your agent')

    created[0]?.click()
    expect(routes).toEqual([{ view: 'chat', id: 'pc123abc' }])
  })

  it('replaces that chat\'s earlier notification instead of stacking a second one', () => {
    const { notifier, created } = setup()

    notifier.replyFinished('main', 'Nova', 'First answer.')
    notifier.replyFinished('main', 'Nova', 'Second answer.')
    expect(created).toHaveLength(2)
    expect(created[0]?.closed).toBe(true)
    expect(created[1]?.closed).toBe(false)

    // Another chat keeps its own notification: one per chat, not one for every chat.
    notifier.replyFinished('pc123abc', 'Nova', 'Elsewhere.')
    expect(created[1]?.closed).toBe(false)
    expect(created[2]?.closed).toBe(false)
  })

  it('stays quiet about a finished reply while the window has the person\'s attention, or notifications are off', () => {
    const focused = setup({ isFocused: () => true })
    const off = setup({ enabled: () => false })

    expect(focused.notifier.replyFinished('main', 'Nova', 'Done.')).toBe(false)
    expect(off.notifier.replyFinished('main', 'Nova', 'Done.')).toBe(false)
    expect(focused.created).toEqual([])
    expect(off.created).toEqual([])
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

describe('replyText', () => {
  it('drops code and card blocks, so a program never reaches the shade', () => {
    expect(replyText('Fixed it.\n\n```js\nconst a = 1\n```\nThe test is green.')).toBe('Fixed it. The test is green.')
    expect(replyText('```openui-lang\nroot = Stack([p1])\np1 = Product(null, "M3")\n```')).toBe('')
    expect(replyText('')).toBe('')
    expect(replyText('   \n\n ')).toBe('')
  })

  it('drops a fence that never closed, so a cut-short reply still says its words', () => {
    expect(replyText('Here is the file.\n```js\nconst a = 1')).toBe('Here is the file.')
  })

  it('flattens markdown and clips a long reply', () => {
    expect(replyText('# Heading\n\n- one\n- two')).toBe('Heading one two')
    expect(replyText('See [the note](https://example.com/note) for it.')).toBe('See the note for it.')
    expect(replyText('It is `one line`.')).toBe('It is one line.')

    const long = replyText('x'.repeat(400))
    expect(long.length).toBeLessThanOrEqual(220)
    expect(long.endsWith('...')).toBe(true)
  })
})
