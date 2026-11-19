import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Cdp, type DebuggerLike } from '../src/main/browser/cdp'
import { shotResize } from '../src/main/browser/shot-size'

type Listener = (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void

/**
 * A page with two nested cross-origin frames, as the debugger sees it: the page holds the outer iframe element at
 * (50,50), that frame holds the inner one at (40,40) inside it, and a button sits at (20,20) in the inner frame.
 * Frames are attached only through Target.setAutoAttach (attachToTarget is refused to a page's own debugger).
 */
class NestedFrames implements DebuggerLike {
  attached = false
  readonly sent: Array<{ method: string; params: Record<string, unknown>; sessionId: string | undefined }> = []
  private listener: Listener | undefined
  readonly sessions = { mid: 'S-mid', inner: 'S-inner' }
  /** Attaching answers with no frames at all, as a page with nothing attachable does. */
  noFrames = false
  failSession: string | undefined

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  on(_event: 'message', listener: Listener): void {
    this.listener = listener
  }
  async sendCommand(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, sessionId })
    if (sessionId !== undefined && sessionId === this.failSession && method === 'Input.dispatchMouseEvent') throw new Error('Session with given id not found')
    const x = Number(params['x'])
    const y = Number(params['y'])
    switch (method) {
      case 'DOM.getNodeForLocation': {
        // In the page the outer iframe covers (50..650, 50..470); in that frame the inner one covers (40..540, 40..360).
        if (sessionId === undefined) return x >= 50 && x < 650 && y >= 50 && y < 470 ? { backendNodeId: 10 } : { backendNodeId: 1 }
        if (sessionId === this.sessions.mid) return x >= 40 && x < 540 && y >= 40 && y < 360 ? { backendNodeId: 20 } : { backendNodeId: 2 }
        return { backendNodeId: 30 }
      }
      case 'DOM.describeNode': {
        const id = params['backendNodeId']
        if (id === 10) return { node: { nodeName: 'IFRAME', frameId: 'F-mid' } }
        if (id === 20) return { node: { nodeName: 'IFRAME', frameId: 'F-inner' } }
        return { node: { nodeName: id === 30 ? 'BUTTON' : 'HTML' } }
      }
      case 'DOM.getBoxModel': {
        const o = params['backendNodeId'] === 10 ? 50 : 40
        return { model: { content: [o, o, o + 500, o, o + 500, o + 300, o, o + 300] } }
      }
      case 'Target.setAutoAttach': {
        if (this.noFrames) return {}
        // Chromium answers by attaching to each frame under that session, as events.
        if (sessionId === undefined) queueMicrotask(() => this.listener?.({}, 'Target.attachedToTarget', { sessionId: this.sessions.mid, targetInfo: { targetId: 'F-mid', type: 'iframe' } }))
        else if (sessionId === this.sessions.mid) queueMicrotask(() => this.listener?.({}, 'Target.attachedToTarget', { sessionId: this.sessions.inner, targetInfo: { targetId: 'F-inner', type: 'iframe' } }, sessionId))
        return {}
      }
      default:
        return {}
    }
  }
  mouse(): Array<{ type: unknown; x: number; y: number; sessionId: string | undefined }> {
    return this.sent.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => ({ type: c.params['type'], x: Number(c.params['x']), y: Number(c.params['y']), sessionId: c.sessionId }))
  }
}

function guest(dbg: NestedFrames): Cdp {
  const cdp = new Cdp(dbg)
  cdp.guest = true
  return cdp
}

describe('a click into frames in other processes', () => {
  it('goes to the inner frame on its own session, with frame-local coordinates', async () => {
    const dbg = new NestedFrames()
    await guest(dbg).click({ x: 190, y: 130 }, 1)
    const mouse = dbg.mouse()
    expect(mouse.map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    // page (190,130) - outer iframe (50,50) = (140,80) - inner iframe (40,40) = (100,40) in the inner frame
    for (const m of mouse) expect(m).toMatchObject({ x: 100, y: 40, sessionId: dbg.sessions.inner })
  })

  it('hit-tests ignoring pointer-events, so the agent input guard cannot hide the frames', async () => {
    const dbg = new NestedFrames()
    await guest(dbg).click({ x: 190, y: 130 }, 1)
    expect(dbg.sent.find((c) => c.method === 'DOM.getNodeForLocation')?.params).toMatchObject({ ignorePointerEventsNone: true })
  })

  it('a point outside every frame goes to the page itself, as before', async () => {
    const dbg = new NestedFrames()
    await guest(dbg).click({ x: 20, y: 20 }, 1)
    expect(dbg.mouse().every((m) => m.sessionId === undefined && m.x === 20 && m.y === 20)).toBe(true)
  })

  it('a point in the outer frame only goes to the outer frame', async () => {
    const dbg = new NestedFrames()
    await guest(dbg).click({ x: 60, y: 60 }, 1)
    expect(dbg.mouse().every((m) => m.sessionId === dbg.sessions.mid && m.x === 10 && m.y === 10)).toBe(true)
  })

  it('converts with the draw scale: view pixels in, frame-local view pixels out', async () => {
    const dbg = new NestedFrames()
    // A view drawn at half size: page (190,130) is view (95,65), and frame-local (100,40) is (50,20) in view pixels.
    await guest(dbg).click({ x: 190, y: 130 }, 0.5)
    for (const m of dbg.mouse()) expect(m).toMatchObject({ x: 50, y: 20, sessionId: dbg.sessions.inner })
  })

  it('a drag stays on the frame it started in, and the wheel goes into the frame under the pointer', async () => {
    const dbg = new NestedFrames()
    await guest(dbg).drag({ x: 190, y: 130 }, { x: 290, y: 130 }, 1, 4)
    const mouse = dbg.mouse()
    expect(mouse.every((m) => m.sessionId === dbg.sessions.inner)).toBe(true)
    expect(mouse[mouse.length - 1]).toMatchObject({ type: 'mouseReleased', x: 200, y: 40 })
    const wheel = new NestedFrames()
    await guest(wheel).wheel({ x: 190, y: 130 }, 1, 300)
    expect(wheel.mouse()[0]).toMatchObject({ type: 'mouseWheel', x: 100, y: 40, sessionId: wheel.sessions.inner })
  })

  it('keys and typed text are not routed: they follow the focused frame on their own', async () => {
    const dbg = new NestedFrames()
    const cdp = guest(dbg)
    await cdp.click({ x: 190, y: 130 }, 1)
    dbg.sent.length = 0
    await cdp.press('PageDown')
    await cdp.insertText('hello')
    expect(dbg.sent.map((c) => [c.method, c.sessionId])).toEqual([
      ['Input.dispatchKeyEvent', undefined],
      ['Input.dispatchKeyEvent', undefined],
      ['Input.insertText', undefined],
    ])
  })

  it('looks the frames up once and reuses their sessions for the next click', async () => {
    const dbg = new NestedFrames()
    const cdp = guest(dbg)
    await cdp.click({ x: 190, y: 130 }, 1)
    await cdp.click({ x: 200, y: 140 }, 1)
    // One auto-attach on the page, one on the outer frame and one on the inner frame, not one per click.
    expect(dbg.sent.filter((c) => c.method === 'Target.setAutoAttach')).toHaveLength(3)
  })

  it('looks the frame up afresh when its session went away, and surfaces the error if it still fails', async () => {
    const dbg = new NestedFrames()
    const cdp = guest(dbg)
    await cdp.click({ x: 190, y: 130 }, 1)
    dbg.failSession = dbg.sessions.inner
    dbg.sent.length = 0
    await expect(cdp.click({ x: 190, y: 130 }, 1)).rejects.toThrow()
    expect(dbg.sent.filter((c) => c.method === 'Target.setAutoAttach').length).toBeGreaterThan(0)
  })

  it('does nothing different for a page that is not a guest, or with routing off', async () => {
    for (const set of [(c: Cdp) => { c.guest = false }, (c: Cdp) => { c.guest = true; c.frames = false }]) {
      const dbg = new NestedFrames()
      const cdp = new Cdp(dbg)
      set(cdp)
      await cdp.click({ x: 190, y: 130 }, 1)
      expect(dbg.sent.some((c) => c.method.startsWith('DOM.') || c.method === 'Target.setAutoAttach')).toBe(false)
      expect(dbg.mouse().every((m) => m.sessionId === undefined && m.x === 190 && m.y === 130)).toBe(true)
    }
  })

  it('a touch view is left to its touch events', async () => {
    const dbg = new NestedFrames()
    const cdp = guest(dbg)
    cdp.touch = true
    await cdp.click({ x: 190, y: 130 }, 1)
    expect(dbg.sent.some((c) => c.method.startsWith('DOM.'))).toBe(false)
  })

  it('falls back to the page when no frame can be attached, and does not hang the click', async () => {
    const dbg = new NestedFrames()
    dbg.noFrames = true
    await guest(dbg).click({ x: 190, y: 130 }, 1)
    expect(dbg.mouse().every((m) => m.sessionId === undefined && m.x === 190)).toBe(true)
  }, 10_000)

  it('ignores a point that is not a number', async () => {
    const dbg = new NestedFrames()
    const route = await guest(dbg).route({ x: Number.NaN, y: 3 }, 1)
    expect(route.sessionId).toBeUndefined()
    expect(dbg.sent).toHaveLength(0)
  })
})

describe('a screenshot is the size of the page, so a point read off it is a point of the page', () => {
  it('brings a 125% and a 150% display capture back to the page size', () => {
    expect(shotResize({ width: 1800, height: 1465 }, { width: 1440, height: 1172 })).toEqual({ width: 1440, height: 1172 })
    expect(shotResize({ width: 2160, height: 1350 }, { width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 })
  })
  it('leaves a picture that already is the page size alone', () => {
    expect(shotResize({ width: 1440, height: 900 }, { width: 1440, height: 900 })).toBeNull()
    expect(shotResize({ width: 1450, height: 905 }, { width: 1440, height: 900 })).toBeNull()
  })
  it('leaves a picture whose shape is not the page (a clipped or different capture) alone', () => {
    expect(shotResize({ width: 1800, height: 900 }, { width: 1440, height: 900 })).toBeNull()
    expect(shotResize({ width: 720, height: 450 }, { width: 1440, height: 900 })).toBeNull()
    expect(shotResize({ width: 0, height: 0 }, { width: 1440, height: 900 })).toBeNull()
    expect(shotResize({ width: 1800, height: 1125 }, { width: 0, height: 900 })).toBeNull()
  })
})

describe('the two-origin test page (test/fixtures/iframe-origins.mjs, used by the real-Electron probe)', () => {
  let origins: { outer: string; ports: number[]; close: () => void } | undefined
  beforeAll(async () => {
    // @ts-expect-error a plain module with no types
    const fixture = (await import('./fixtures/iframe-origins.mjs')) as { startOrigins: () => Promise<NonNullable<typeof origins>> }
    origins = await fixture.startOrigins()
  })
  afterAll(() => origins?.close())

  it('serves three nested pages on three different sites, and logs events sent from the inner one', async () => {
    const outer = await (await fetch(origins!.outer)).text()
    expect(outer).toContain('127.0.0.1')
    const mid = await (await fetch(`http://127.0.0.1:${origins!.ports[1]}/mid`)).text()
    expect(mid).toContain('127.0.0.2')
    const inner = await (await fetch(`http://127.0.0.2:${origins!.ports[2]}/inner`)).text()
    expect(inner).toContain('contenteditable')
    await fetch(`${origins!.outer}log?e=click&d=b|trusted|mouse`)
    const log = (await (await fetch(`${origins!.outer}log`)).json()) as Array<{ e: string; d: string }>
    expect(log.at(-1)).toMatchObject({ e: 'click', d: 'b|trusted|mouse' })
  })
})
