import { describe, expect, it } from 'vitest'

import { Cdp, parseKey, toView, type DebuggerLike } from '../src/main/browser/cdp'

class FakeDebugger implements DebuggerLike {
  attached = false
  attaches = 0
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  hang = false
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attaches++
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params })
    if (this.hang) return new Promise(() => undefined)
    return {}
  }
}

describe('trusted input over CDP', () => {
  it('attaches once and keeps the debugger, because detaching drops the emulation', async () => {
    const dbg = new FakeDebugger()
    const cdp = new Cdp(dbg)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.send('Page.enable')
    expect(dbg.attaches).toBe(1)
    expect(dbg.attached).toBe(true)
  })

  it('scales page coordinates into the scaled-down view for a mouse click', async () => {
    const dbg = new FakeDebugger()
    const cdp = new Cdp(dbg)
    await cdp.click({ x: 1150, y: 660 }, 0.25)
    const pressed = dbg.sent.find((c) => c.params['type'] === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 287.5, y: 165, button: 'left', clickCount: 1 })
    expect(dbg.sent.map((c) => c.params['type'])).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(toView({ x: 10, y: 10 }, 0)).toEqual({ x: 10, y: 10 })
  })

  it('taps with touch events on a touch view, where mouse events would hang', async () => {
    const dbg = new FakeDebugger()
    const cdp = new Cdp(dbg)
    cdp.touch = true
    await cdp.click({ x: 100, y: 200 }, 0.5)
    expect(dbg.sent.map((c) => c.method)).toEqual(['Input.dispatchTouchEvent', 'Input.dispatchTouchEvent'])
    expect(dbg.sent[0]?.params).toMatchObject({ type: 'touchStart', touchPoints: [{ x: 50, y: 100 }] })
  })

  it('drags along a path with many steps, not one jump', async () => {
    const dbg = new FakeDebugger()
    const cdp = new Cdp(dbg)
    await cdp.drag({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 8)
    const moves = dbg.sent.filter((c) => c.params['type'] === 'mouseMoved')
    expect(moves.length).toBe(9)
    expect(moves[moves.length - 1]?.params['x']).toBe(100)
  })

  it('knows named keys, letters and modifiers, and sends Enter with its text', async () => {
    expect(parseKey('Enter')?.spec.keyCode).toBe(13)
    expect(parseKey('ctrl+a')?.modifiers).toBe(2)
    expect(parseKey('ctrl+a')?.spec.text).toBeUndefined()
    expect(parseKey('Shift+Tab')?.modifiers).toBe(8)
    expect(parseKey('hyper+x')).toBeNull()
    const dbg = new FakeDebugger()
    const cdp = new Cdp(dbg)
    expect(await cdp.press('Enter')).toBe(true)
    expect(dbg.sent[0]?.params).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r' })
    expect(await cdp.press('NotAKey')).toBe(false)
  })

  it('gives up on a command that never answers instead of hanging the agent', async () => {
    const dbg = new FakeDebugger()
    dbg.hang = true
    const cdp = new Cdp(dbg, 30)
    await expect(cdp.send('Input.dispatchMouseEvent', {})).rejects.toThrow('timed out')
  })
})
