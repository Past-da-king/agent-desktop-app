/**
 * A tab, a sign-in window or the app window can end while one of its events, timers or promises is still on its
 * way. Electron then throws "Object has been destroyed" for any native call on it, and from an event listener that
 * is an uncaught exception: the crash dialog. These hold that a page that went away is skipped, never a crash.
 */
import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { alive, ifAlive, isDestroyedError, safeSend, uncaughtHandler, uncaughtPolicy, whileAlive } from '../src/main/alive'
import { attachVaultTo, debuggerLink, type LinkPage } from '../src/main/browser/vault-link'

function destroyedError(): TypeError {
  return new TypeError('Object has been destroyed')
}

/** A page like Electron's: once destroyed, every native property and method throws. */
class FakePage extends EventEmitter {
  private gone = false
  private readonly dbg = Object.assign(new EventEmitter(), {
    sendCommand: vi.fn(async () => ({})),
  })

  isDestroyed(): boolean {
    return this.gone
  }

  get debugger(): unknown {
    if (this.gone) throw destroyedError()
    return this.dbg
  }

  listeners(): number {
    return this.dbg.listenerCount('message')
  }

  /** What Electron does when a tab closes: marks it destroyed, then emits 'destroyed'. */
  destroy(): void {
    this.gone = true
    this.emit('destroyed')
  }
}

/** The fake as the Electron page type the link takes. */
function asPage(page: FakePage): LinkPage {
  return page as unknown as LinkPage
}

describe('the Vault on a page that closes', () => {
  it('stops serving the page when it closes, with no throw from its destroyed event', async () => {
    const page = new FakePage()
    const vault = {
      attach: async (link: ReturnType<typeof debuggerLink>) => {
        const off = link.onEvent(() => undefined)
        return () => off()
      },
    }
    await attachVaultTo(vault, asPage(page), { person: () => false, frames: true })
    expect(page.listeners()).toBe(1)
    expect(() => page.destroy()).not.toThrow()
  })

  it('stops at once when the page closed while the Vault was still attaching', async () => {
    const page = new FakePage()
    const stop = vi.fn()
    const vault = {
      attach: async () => {
        page.destroy()
        return stop
      },
    }
    await expect(attachVaultTo(vault, asPage(page), { person: () => false })).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('answers a command on a closed page with a rejection, not a throw', async () => {
    const page = new FakePage()
    const link = debuggerLink(asPage(page))
    page.destroy()
    let thrown: unknown = null
    let promise: Promise<unknown> | null = null
    try {
      promise = link.send('Runtime.enable')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeNull()
    await expect(promise).rejects.toThrow(/closed|destroyed/)
  })
})

describe('listeners on something that can end', () => {
  it('skip a target that has ended, and a destroyed object inside them is a skip', () => {
    const target = { gone: false, isDestroyed() { return this.gone } }
    const seen: number[] = []
    const listener = whileAlive(target, 'test', (n: number) => {
      if (n === 2) throw destroyedError()
      seen.push(n)
    })
    listener(1)
    expect(() => listener(2)).not.toThrow()
    target.gone = true
    listener(3)
    expect(seen).toEqual([1])
  })

  it('still throw a real error', () => {
    const listener = whileAlive({ isDestroyed: () => false }, 'test', () => {
      throw new Error('real fault')
    })
    expect(() => listener()).toThrow('real fault')
    expect(() => ifAlive('x', () => { throw new Error('real') })).toThrow('real')
    expect(ifAlive('x', () => { throw destroyedError() })).toBeUndefined()
  })

  it('treat a target whose own isDestroyed throws as gone', () => {
    expect(alive({ isDestroyed: () => { throw destroyedError() } })).toBe(false)
    expect(alive(null)).toBe(false)
    expect(alive({ isDestroyed: () => false })).toBe(true)
  })
})

describe('sending to a window', () => {
  it('sends to a live window and skips a closed one or a closed page', () => {
    const send = vi.fn()
    const win = { gone: false, isDestroyed() { return this.gone }, webContents: { gone: false, isDestroyed() { return this.gone }, send } }
    expect(safeSend(win, 'ch', 1)).toBe(true)
    expect(send).toHaveBeenCalledWith('ch', 1)
    win.webContents.gone = true
    expect(safeSend(win, 'ch', 2)).toBe(false)
    win.gone = true
    expect(safeSend(win, 'ch', 3)).toBe(false)
    expect(safeSend(null, 'ch')).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats a send that races the close as skipped', () => {
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw destroyedError() } } }
    expect(safeSend(win, 'ch')).toBe(false)
  })
})

describe('an uncaught exception', () => {
  it('from a closed page or window is logged with its stack and the app carries on', () => {
    const log = vi.fn()
    const dialog = vi.fn()
    const error = destroyedError()
    uncaughtHandler({ log, dialog })(error)
    expect(uncaughtPolicy(error)).toBe('log')
    expect(dialog).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[1]).toMatchObject({ message: 'Object has been destroyed', stack: error.stack })
  })

  it('of any other kind still shows the crash dialog', () => {
    const log = vi.fn()
    const dialog = vi.fn()
    uncaughtHandler({ log, dialog })(new Error('disk full'))
    expect(uncaughtPolicy(new Error('disk full'))).toBe('dialog')
    expect(dialog).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(isDestroyedError('Object has been destroyed')).toBe(true)
    expect(isDestroyedError(new Error('nope'))).toBe(false)
  })
})
