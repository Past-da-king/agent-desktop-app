import { describe, expect, it } from 'vitest'

import { FocusGuard, guardDebugger, keyToEvents, takesKeyboard, type FocusProbe } from '../src/main/browser/focus-keeper'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface World {
  /** He is in the app (the operating system's foreground). */
  app: boolean
  /** The app's own page (the chat box) holds the keyboard. */
  host: boolean
  restored: number
  saved: number
  forgotten: number
  notes: string[]
}

function world(over: Partial<World> = {}): { w: World; probe: FocusProbe } {
  const w: World = { app: true, host: true, restored: 0, saved: 0, forgotten: 0, notes: [], ...over }
  const probe: FocusProbe = {
    appFocused: () => w.app,
    hostHasKeyboard: async () => w.host,
    saveActive: async () => {
      w.saved += 1
    },
    restoreHost: async () => {
      w.restored += 1
      w.host = true
    },
    forgetActive: async () => {
      w.forgotten += 1
    },
    note: (what) => {
      w.notes.push(what)
    },
  }
  return { w, probe }
}

const FAST = { tickMs: 1, settleMs: 25 }

describe('focus guard', () => {
  it('gives the chat box its keyboard back as soon as a page takes it, while the command still runs', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    let givenBackBeforeReturn = false
    await guard.around(async () => {
      w.host = false // Chromium moves the keyboard to the page on a press
      await wait(15)
      givenBackBeforeReturn = w.host
    }, 'Input.dispatchMouseEvent')
    expect(givenBackBeforeReturn).toBe(true)
    expect(w.restored).toBe(1)
    expect(guard.fired).toBe(1)
    expect(w.notes).toEqual(['keyboard given back to the chat'])
  })

  it('catches a take that Chromium reports a moment after the command returned, but not one long after', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    await guard.around(async () => undefined)
    await wait(8)
    w.host = false
    await wait(12)
    expect(w.restored).toBe(1)
    await wait(40) // settled: the guard has stopped
    w.host = false
    await wait(20)
    expect(w.restored).toBe(1)
  })

  it('does nothing when he is in another app: it can never bring the app forward', async () => {
    const { w, probe } = world({ app: false, host: false })
    const guard = new FocusGuard(probe, FAST)
    await guard.around(async () => {
      await wait(10)
    })
    await wait(40)
    expect(w.restored).toBe(0)
    expect(w.saved).toBe(0)
  })

  it('does not take the keyboard for the chat when he did not have it there', async () => {
    const { w, probe } = world({ host: false })
    const guard = new FocusGuard(probe, FAST)
    await guard.around(async () => {
      await wait(10)
    })
    await wait(40)
    expect(w.restored).toBe(0)
  })

  it('leaves the keyboard alone when it never moved, and forgets the saved element when done', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    await guard.around(async () => {
      await wait(10)
    })
    await wait(60)
    expect(w.restored).toBe(0)
    expect(w.saved).toBe(1)
    expect(w.forgotten).toBe(1)
  })

  it('one watcher for commands that overlap or follow each other (a press, then its release)', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    await Promise.all([guard.around(async () => wait(10)), guard.around(async () => wait(15))])
    await guard.around(async () => wait(5))
    await wait(60)
    expect(w.saved).toBe(1)
    expect(w.forgotten).toBe(1)
  })

  it('never stops the action when the page cannot be asked', async () => {
    const { w, probe } = world()
    probe.hostHasKeyboard = async () => {
      throw new Error('the window went away')
    }
    const guard = new FocusGuard(probe, FAST)
    await expect(guard.around(async () => 'done')).resolves.toBe('done')
    await wait(40)
    expect(w.restored).toBe(0)
  })
})

describe('guardDebugger', () => {
  it('sends only the commands that can move the keyboard through the guard, every caller alike', async () => {
    const seen: string[] = []
    const dbg = {
      sendCommand: async (method: string, params?: unknown, sessionId?: string): Promise<unknown> => {
        seen.push(`${method}|${JSON.stringify(params)}|${sessionId ?? ''}`)
        return { ok: true }
      },
    }
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    guardDebugger(dbg, guard)
    guardDebugger(dbg, guard) // once only
    await dbg.sendCommand('Runtime.evaluate', { expression: '1' })
    await wait(30)
    expect(w.saved).toBe(0)
    const answer = await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed' }, 'sess')
    expect(answer).toEqual({ ok: true })
    expect(seen).toEqual(['Runtime.evaluate|{"expression":"1"}|', 'Input.dispatchMouseEvent|{"type":"mousePressed"}|sess'])
    expect(w.saved).toBe(1)
    await wait(60)
  })

  it('knows the commands that take the keyboard', () => {
    for (const m of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.dispatchTouchEvent', 'Input.synthesizeTapGesture', 'Input.insertText', 'Page.bringToFront', 'Target.activateTarget']) {
      expect(takesKeyboard(m)).toBe(true)
    }
    for (const m of ['Runtime.evaluate', 'Page.captureScreenshot', 'Emulation.setFocusEmulationEnabled', 'DOM.setFileInputFiles']) expect(takesKeyboard(m)).toBe(false)
  })
})

describe('focus guard bursts (clicks and keys the page must receive)', () => {
  it('grabs the keyboard for the page, never gives it back in the middle, and gives it back the moment the burst ends', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    const trace: string[] = []
    await guard.burst(
      () => {
        w.host = false
        trace.push('grab')
      },
      async () => {
        trace.push(`key1 lands in ${w.host ? 'the chat box' : 'the page'}`)
        await wait(20) // longer than the watcher tick: it must not give the keyboard back now
        trace.push(`key2 lands in ${w.host ? 'the chat box' : 'the page'}`)
      },
      'press Enter',
    )
    trace.push(`after: ${w.host ? 'chat box has it' : 'page has it'}`)
    expect(trace).toEqual(['grab', 'key1 lands in the page', 'key2 lands in the page', 'after: chat box has it'])
    expect(w.restored).toBe(1)
  })

  it('grabs for the page even when he is in another app (a key must never land in the chat box), and gives nothing back then', async () => {
    const { w, probe } = world({ app: false, host: false })
    const guard = new FocusGuard(probe, FAST)
    let grabbed = 0
    await guard.burst(
      () => {
        grabbed += 1
      },
      async () => undefined,
    )
    await wait(40)
    expect(grabbed).toBe(1)
    expect(w.restored).toBe(0)
  })

  it('overlapping bursts hold until the last one ends', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    const grab = (): void => {
      w.host = false
    }
    let during = 0
    await Promise.all([
      guard.burst(grab, async () => wait(10)),
      guard.burst(grab, async () => {
        await wait(25)
        during = w.restored
      }),
    ])
    expect(during).toBe(0)
    expect(w.restored).toBe(1)
  })
})

describe('his keys while a click of the agent holds the keyboard in the page', () => {
  const key = (k: string, type: 'keyDown' | 'keyUp' = 'keyDown') => ({ type, key: k, shift: false, control: false, alt: false, meta: false })

  it('keeps them from the page and types them into the chat box, in order, once it has the keyboard back', async () => {
    const { w, probe } = world()
    const typed: string[] = []
    probe.replay = async (keys) => {
      typed.push(...keys.map((k) => `${w.host ? 'chat' : 'page'}:${k.key}:${k.type}`))
    }
    const guard = new FocusGuard(probe, FAST)
    const swallowed: boolean[] = []
    await guard.burst(
      () => {
        w.host = false
      },
      async () => {
        swallowed.push(guard.swallow(key('h')), guard.swallow(key('h', 'keyUp')), guard.swallow(key('i')))
      },
      'click',
    )
    expect(swallowed).toEqual([true, true, true])
    expect(typed).toEqual(['chat:h:keyDown', 'chat:h:keyUp', 'chat:i:keyDown'])
  })

  it('lets the keys the agent sends itself through, and everything when no burst runs or he was not in the box', async () => {
    const { w, probe } = world()
    const guard = new FocusGuard(probe, FAST)
    expect(guard.swallow(key('a'))).toBe(false) // no burst
    await guard.burst(
      () => {
        w.host = false
      },
      async () => {
        expect(guard.swallow(key('Enter'))).toBe(false) // a key burst: the Enter is the agent's
      },
      'press Enter',
      { keys: true },
    )
    const other = world({ host: false })
    const g2 = new FocusGuard(other.probe, FAST)
    await g2.burst(
      () => undefined,
      async () => {
        expect(g2.swallow(key('a'))).toBe(false) // he was not typing in the app
      },
    )
  })

  it('turns a key into what the chat box needs: a printable key is a keyDown and a char, a named key only a keyDown', () => {
    expect(keyToEvents({ ...key('a') })).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: [] },
      { type: 'char', keyCode: 'a', modifiers: [] },
    ])
    expect(keyToEvents({ ...key(' ') })[0]).toEqual({ type: 'keyDown', keyCode: 'Space', modifiers: [] })
    expect(keyToEvents({ ...key('Backspace') })).toEqual([{ type: 'keyDown', keyCode: 'Backspace', modifiers: [] }])
    expect(keyToEvents({ ...key('a'), control: true })).toEqual([{ type: 'keyDown', keyCode: 'a', modifiers: ['control'] }])
    expect(keyToEvents({ ...key('A'), shift: true })[1]).toEqual({ type: 'char', keyCode: 'A', modifiers: ['shift'] })
    expect(keyToEvents({ ...key('ArrowLeft', 'keyUp') })).toEqual([{ type: 'keyUp', keyCode: 'Left', modifiers: [] }])
  })
})
