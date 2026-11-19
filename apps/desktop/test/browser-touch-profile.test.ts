import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

import { emulationCommands, presetView, resolveView } from '../src/main/browser/emulation'
import { NO_TOUCH_SCRIPT, TouchProfileHost, touchProfileOf, type TouchLink } from '../src/main/browser/touch-profile'

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

class FakeLink implements TouchLink {
  readonly sent: Array<{ method: string; params: Record<string, unknown>; sessionId: string | undefined }> = []
  private listener: Listener | undefined
  private n = 0
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, sessionId })
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `id-${++this.n}` }
    return {}
  }
  onEvent(listener: Listener): () => void {
    this.listener = listener
    return () => (this.listener = undefined)
  }
  attachFrame(sessionId: string): void {
    this.listener?.('Target.attachedToTarget', { sessionId, targetInfo: { type: 'iframe', targetId: `t-${sessionId}` } })
  }
  detachFrame(sessionId: string): void {
    this.listener?.('Target.detachedFromTarget', { sessionId })
  }
  count(method: string, sessionId?: string): number {
    return this.sent.filter((c) => c.method === method && (sessionId === undefined || c.sessionId === sessionId)).length
  }
}

const engine = { chromeVersion: '140.0.0.0', platform: 'win32' } as never
const fit = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1 } as never

describe('the touch profile follows the view', () => {
  it('is desktop for desktop and fit, touch for tablet and phone', () => {
    expect(touchProfileOf(presetView('desktop'))).toBe('desktop')
    expect(touchProfileOf(presetView('fit'))).toBe('desktop')
    expect(touchProfileOf(presetView('tablet'))).toBe('touch')
    expect(touchProfileOf(presetView('phone'))).toBe('touch')
  })

  it('keeps an explicit touch override working in both directions', () => {
    expect(touchProfileOf(resolveView(presetView('desktop'), { touch: true }))).toBe('touch')
    expect(touchProfileOf(resolveView(presetView('phone'), { touch: false }))).toBe('desktop')
  })

  it('leaves the CDP touch commands of every mode as they were', () => {
    const touchOf = (mode: 'desktop' | 'tablet' | 'phone') =>
      emulationCommands(presetView(mode), engine, fit).filter((c) => c.method.startsWith('Emulation.set') && c.method.includes('Touch'))
    expect(touchOf('desktop')[0]?.params).toEqual({ enabled: false, maxTouchPoints: 1 })
    expect(touchOf('phone')[0]?.params).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(touchOf('tablet')[1]?.params).toEqual({ enabled: true, configuration: 'mobile' })
  })
})

/** The script, run against a stand-in for what a touchscreen PC gives a page. */
function pageOnTouchscreen(): vm.Context {
  const context = vm.createContext({})
  vm.runInContext(
    `
    class Navigator {}
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get() { return 10 }, configurable: true, enumerable: true })
    class Window {}
    class Document {}
    class Element {}
    class HTMLElement extends Element {}
    class SVGElement extends Element {}
    for (const t of [Window.prototype, Document.prototype, HTMLElement.prototype]) {
      for (const n of ['ontouchstart','ontouchend','ontouchmove','ontouchcancel']) Object.defineProperty(t, n, { get() { return null }, set() {}, configurable: true, enumerable: true })
    }
    var window = new Window(); var navigator = new Navigator(); var document = new Document(); var el = new HTMLElement();
    `,
    context,
  )
  return context
}

describe('the no-touch script', () => {
  it('is red without it and green with it: maxTouchPoints 0, no ontouchstart', () => {
    const before = pageOnTouchscreen()
    expect(vm.runInContext(`[navigator.maxTouchPoints, 'ontouchstart' in window]`, before)).toEqual([10, true])
    const after = pageOnTouchscreen()
    vm.runInContext(NO_TOUCH_SCRIPT, after)
    expect(vm.runInContext(`[navigator.maxTouchPoints, 'ontouchstart' in window, 'ontouchend' in document, 'ontouchmove' in el]`, after)).toEqual([0, false, false, false])
  })

  it('does not throw on a page missing those prototypes', () => {
    expect(() => vm.runInContext(NO_TOUCH_SCRIPT, vm.createContext({}))).not.toThrow()
  })
})

describe('TouchProfileHost', () => {
  it('puts the script in the page, then in each cross-site frame as it attaches, and in nested frames', async () => {
    const link = new FakeLink()
    const host = new TouchProfileHost(link)
    await host.apply('desktop')
    expect(link.count('Page.addScriptToEvaluateOnNewDocument')).toBe(1)
    expect(link.sent.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')?.params['runImmediately']).toBe(true)
    link.attachFrame('S1')
    link.attachFrame('S2')
    await host.apply('desktop')
    expect(link.count('Page.addScriptToEvaluateOnNewDocument', 'S1')).toBe(1)
    expect(link.count('Page.addScriptToEvaluateOnNewDocument', 'S2')).toBe(1)
    // The frame sessions auto-attach to their own frames, and the script is never added twice to one session.
    expect(link.count('Target.setAutoAttach', 'S1')).toBe(1)
    expect(link.count('Page.addScriptToEvaluateOnNewDocument')).toBe(3)
  })

  it('takes it out of the page and every frame when the view turns to touch, and adds nothing for new frames', async () => {
    const link = new FakeLink()
    const host = new TouchProfileHost(link)
    await host.apply('desktop')
    link.attachFrame('S1')
    await host.apply('desktop')
    await host.apply('touch')
    expect(link.count('Page.removeScriptToEvaluateOnNewDocument')).toBe(2)
    link.attachFrame('S3')
    await host.apply('touch')
    expect(link.count('Page.addScriptToEvaluateOnNewDocument', 'S3')).toBe(0)
  })

  it('applies again after touch goes back to desktop, and forgets a frame that went away', async () => {
    const link = new FakeLink()
    const host = new TouchProfileHost(link)
    await host.apply('touch')
    expect(link.count('Page.addScriptToEvaluateOnNewDocument')).toBe(0)
    link.attachFrame('S1')
    await host.apply('desktop')
    expect(link.count('Page.addScriptToEvaluateOnNewDocument')).toBe(2)
    link.detachFrame('S1')
    await host.apply('desktop')
    expect(link.count('Page.addScriptToEvaluateOnNewDocument')).toBe(2)
  })

  it('survives a refused command', async () => {
    const link = new FakeLink()
    link.send = async () => {
      throw new Error('Session with given id not found')
    }
    await expect(new TouchProfileHost(link).apply('desktop')).resolves.toBeUndefined()
  })
})
