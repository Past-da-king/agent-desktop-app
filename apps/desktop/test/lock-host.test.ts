import { describe, expect, it, vi } from 'vitest'

import { lockInjector, lockNotice, lockPresence } from '../src/main/agent-cursor/lock-host'

describe('lock host', () => {
  it('the notice goes ahead after the grace time and offers Not now', async () => {
    vi.useFakeTimers()
    const shown: string[] = []
    const closed = vi.fn()
    const notice = lockNotice((title, body) => { shown.push(title + ' | ' + body); return closed })
    const answer = notice.ask({ text: 'Hina needs to click Save', graceMs: 4000, owner: 'Hina' }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(4001)
    expect(await answer).toBe('go')
    expect(shown[0]).toContain('Not now')
    expect(closed).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('clicking the notice is Not now', async () => {
    let click: () => void = () => undefined
    const notice = lockNotice((_t, _b, onNotNow) => { click = onNotNow; return () => undefined })
    const answer = notice.ask({ text: 'x', graceMs: 60_000, owner: 'a' }, new AbortController().signal)
    click()
    expect(await answer).toBe('not_now')
  })

  it('presence is the helper idle time, and unknown counts as active', async () => {
    expect(await lockPresence({ call: async () => null, idleMs: async () => 12000 }).idleMs()).toBe(12000)
    expect(await lockPresence({ call: async () => null, idleMs: async () => { throw new Error('gone') } }).idleMs()).toBe(-1)
  })

  it('the injector sends the window, pid, idle and steps to the helper and reads the answer', async () => {
    const call = vi.fn(async () => ({ done: 2, of: 2, aborted: false, cursorRestored: true, foregroundRestored: false }))
    const out = await lockInjector({ call, idleMs: async () => 0 }).inject({ hwnd: '0x1', pid: 9, minIdleMs: 10000, steps: [{ do: 'click', x: 1, y: 2 }] }, new AbortController().signal)
    expect(call).toHaveBeenCalledWith('inject', { hwnd: '0x1', pid: 9, minIdleMs: 10000, steps: [{ do: 'click', x: 1, y: 2 }] }, 60000)
    expect(out).toEqual({ done: 2, of: 2, aborted: false, cursorRestored: true, foregroundRestored: false })
  })
})
