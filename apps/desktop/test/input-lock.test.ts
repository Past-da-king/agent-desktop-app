import { describe, expect, it, vi } from 'vitest'

import { InputLock, estimateMs, noticeText } from '../src/main/agent-cursor/input-lock'
import type { InjectResult, InputInjector, InputRequest, LockNotice } from '../src/main/agent-cursor/input-lock'

const good: InjectResult = { done: 1, of: 1, aborted: false, cursorRestored: true, foregroundRestored: true }

function rig(options: { idle?: (clock: { t: number }) => number; verdict?: 'go' | 'not_now'; result?: InjectResult | (() => InjectResult); waitMaxMs?: number } = {}) {
  const clock = { t: 1_000_000 }
  const calls: string[] = []
  const injector: InputInjector = {
    inject: vi.fn(async (request) => {
      calls.push('inject:' + String(request.minIdleMs))
      const r = options.result ?? good
      return typeof r === 'function' ? r() : r
    }),
  }
  const notice: LockNotice = {
    ask: vi.fn(async () => {
      calls.push('notice')
      return options.verdict ?? 'go'
    }),
  }
  const idleSeq = options.idle ?? (() => 60_000)
  const lock = new InputLock({
    settings: () => ({ inputLockIdleSeconds: 10 }),
    presence: { idleMs: async () => { calls.push('idle'); return idleSeq(clock) } },
    notice,
    injector,
    sleep: async (ms) => { clock.t += ms },
    now: () => clock.t,
    ...(options.waitMaxMs === undefined ? {} : { waitMaxMs: options.waitMaxMs }),
  })
  return { lock, injector, notice, calls, clock }
}

const ask = (over: Partial<InputRequest> = {}): InputRequest => ({
  hwnd: '0x10',
  pid: 4,
  what: 'click Save',
  windowTitle: 'Notepad',
  steps: [{ do: 'click', x: 10, y: 10 }],
  owner: 'Hina',
  ...over,
})

describe('input lock', () => {
  it('names what will happen, to which window and how long, and offers Not now', async () => {
    const r = rig()
    await r.lock.request(ask())
    const notice = (r.notice.ask as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { text: string }
    expect(notice.text).toContain('click Save')
    expect(notice.text).toContain('Notepad')
    expect(notice.text).toContain('second')
    expect(notice.text).toContain('Not now')
    expect(noticeText(ask(), estimateMs(ask().steps), 10)).toContain('10 seconds')
  })

  it('refuses while he is active and never sends', async () => {
    const r = rig({ idle: () => 500, waitMaxMs: 2000 })
    const out = await r.lock.request(ask())
    expect(out).toMatchObject({ ok: false, code: 'busy' })
    expect(r.injector.inject).not.toHaveBeenCalled()
  })

  it('waits for him to go idle, then sends with the idle he must keep', async () => {
    const r = rig({ idle: (c) => Math.max(0, c.t - 1_000_000) + 1_000 })
    const out = await r.lock.request(ask())
    expect(out.ok).toBe(true)
    expect(r.clock.t).toBeGreaterThan(1_000_000 + 8_000)
    expect(r.injector.inject).toHaveBeenCalledOnce()
    expect(r.calls).toContain('inject:10000')
    expect(r.calls.indexOf('notice')).toBeLessThan(r.calls.indexOf('inject:10000'))
  })

  it('does not wait or send when he says Not now', async () => {
    const r = rig({ verdict: 'not_now' })
    const out = await r.lock.request(ask())
    expect(out).toMatchObject({ ok: false, code: 'not_now' })
    expect(r.calls).not.toContain('idle')
    expect(r.injector.inject).not.toHaveBeenCalled()
  })

  it('never sends mid-typing: he types again just before the first event', async () => {
    let reads = 0
    const r = rig({ idle: () => (++reads <= 1 ? 60_000 : 300) })
    const out = await r.lock.request(ask())
    expect(out).toMatchObject({ ok: false, code: 'busy' })
    expect(r.injector.inject).not.toHaveBeenCalled()
  })

  it('aborts on his key, reports it, and stays off for a while', async () => {
    const r = rig({ result: { done: 0, of: 3, aborted: true, why: 'he touched the mouse or keyboard', cursorRestored: false, foregroundRestored: true } })
    const out = await r.lock.request(ask({ steps: [{ do: 'type', text: 'abc' }, { do: 'key', key: 'Enter' }, { do: 'click', x: 1, y: 1 }] }))
    expect(out).toMatchObject({ ok: false, code: 'aborted' })
    const next = await r.lock.request(ask())
    expect(next).toMatchObject({ ok: false, code: 'cooling_down' })
    expect(r.injector.inject).toHaveBeenCalledOnce()
    r.clock.t += 61_000
    expect((await r.lock.request(ask())).ok).toBe(false) // injector still answers aborted: proves it ran again after the cool-down
    expect(r.injector.inject).toHaveBeenCalledTimes(2)
  })

  it('says whether his pointer and window were put back', async () => {
    const restored = await rig().lock.request(ask())
    expect(restored).toMatchObject({ ok: true, restored: true })
    const not = await rig({ result: { ...good, foregroundRestored: false } }).lock.request(ask())
    expect(not).toMatchObject({ ok: true, restored: false })
  })

  it('runs one request at a time', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const injector: InputInjector = {
      inject: async (request) => {
        order.push('start ' + request.hwnd)
        if (request.hwnd === '0x1') await gate
        order.push('end ' + request.hwnd)
        return good
      },
    }
    const lock = new InputLock({ settings: () => ({ inputLockIdleSeconds: 10 }), presence: { idleMs: async () => 60_000 }, notice: { ask: async () => 'go' }, injector, sleep: async () => undefined })
    const a = lock.request(ask({ hwnd: '0x1' }))
    const b = lock.request(ask({ hwnd: '0x2' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['start 0x1'])
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['start 0x1', 'end 0x1', 'start 0x2', 'end 0x2'])
  })

  it('turns an injector failure into a refusal', async () => {
    const lock = new InputLock({ settings: () => ({ inputLockIdleSeconds: 10 }), presence: { idleMs: async () => 60_000 }, notice: { ask: async () => 'go' }, injector: { inject: async () => { throw new Error('Windows refused') } }, sleep: async () => undefined })
    expect(await lock.request(ask())).toMatchObject({ ok: false, code: 'unavailable', message: 'Windows refused' })
  })
})
