import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { cdpAct, makeCdpRung } from '../src/main/agent-cursor/cdp-rung'
import { AgentDesktop, findDesktopSidecar } from '../src/main/agent-cursor/desktop'
import type { AgentSurface } from '../src/main/agent-desktop/agent-surface'

describe('cdp rung', () => {
  function fake(valueAfter: string) {
    const listeners: Record<string, Array<(e: { data?: unknown }) => void>> = {}
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    const socket = {
      addEventListener: (t: string, l: (e: { data?: unknown }) => void) => {
        ;(listeners[t] ??= []).push(l)
        if (t === 'open') queueMicrotask(() => l({}))
      },
      close: () => undefined,
      send: (data: string) => {
        const m = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> }
        sent.push({ method: m.method, params: m.params })
        const value = m.method === 'Runtime.evaluate' ? (String(m.params['expression']).includes('devicePixelRatio') ? 1 : valueAfter) : undefined
        queueMicrotask(() => listeners['message']?.forEach((l) => l({ data: JSON.stringify({ id: m.id, result: { result: { value } } }) })))
      },
    }
    return { socket, sent }
  }
  const target = { port: 9222, page: { x: 100, y: 200, width: 800, height: 600 }, title: 'Form' }
  const fetchJson = () => Promise.resolve([{ type: 'page', title: 'Form', webSocketDebuggerUrl: 'ws://x' }])

  it('clicks by debugger events at page coordinates, with focus emulation and no OS input', async () => {
    const f = fake('')
    const r = await cdpAct(target, { action: 'click', at: { x: 300, y: 400 } }, { fetchJson, socket: () => f.socket })
    expect(r.ok).toBe(true)
    const methods = f.sent.map((s) => s.method)
    expect(methods).toContain('Emulation.setFocusEmulationEnabled')
    const pressed = f.sent.find((s) => s.method === 'Input.dispatchMouseEvent' && s.params['type'] === 'mousePressed')
    expect(pressed?.params['x']).toBe(200)
    expect(pressed?.params['y']).toBe(200)
  })

  it('types with insertText and fails honestly when the field does not hold the text', async () => {
    const ok = await cdpAct(target, { action: 'type', text: 'hello', at: { x: 300, y: 400 } }, { fetchJson, socket: () => fake('say hello').socket })
    expect(ok.ok).toBe(true)
    const bad = await cdpAct(target, { action: 'type', text: 'hello', at: { x: 300, y: 400 } }, { fetchJson, socket: () => fake('').socket })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('ignored')
  })
})

describe('agent_desktop', () => {
  function surface(moved = false): AgentSurface {
    const ok = { ok: true, cursorMoved: moved, foregroundChanged: false }
    return {
      open: () => Promise.resolve(ok),
      launch: () => Promise.resolve({ ...ok, pid: 5 }),
      windows: () => Promise.resolve([{ hwnd: 9, title: 'Character Map', pid: 5, x: 0, y: 0, w: 400, h: 300 }]),
      capture: () => Promise.resolve(ok),
      click: () => Promise.resolve(ok),
      type: () => Promise.resolve(ok),
      close: () => Promise.resolve(ok),
    }
  }
  it('launches, lists and clicks without ever opening his desktop', async () => {
    const d = new AgentDesktop({ lookup: () => ({ dirs: [] }), dir: () => tmpdir(), surface: () => surface() })
    expect(await d.run({ op: 'launch', app: 'C:/x.exe' })).toContain('pid 5')
    expect(await d.run({ op: 'windows' })).toContain('Character Map')
    expect(await d.run({ op: 'click', window: 9, x: 1, y: 2 })).toContain('posted, not his mouse')
  })
  it('shouts when the guard says his cursor moved', async () => {
    const d = new AgentDesktop({ lookup: () => ({ dirs: [] }), dir: () => tmpdir(), surface: () => surface(true) })
    expect(await d.run({ op: 'click', window: 9, x: 1, y: 2 })).toContain('WARNING')
  })
  it('finds the helper in resources first', () => {
    expect(findDesktopSidecar({ resourcesPath: 'R', dirs: ['D'] }, (p) => p.includes('agent-desktop.exe'), {})).toContain('R')
  })
})

describe('cdp rung as a ladder step', () => {
  const win = { hwnd: '0x10', pid: 7, title: 'Form', process: 'chrome', className: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, width: 900, height: 700 }, minimised: false, integrity: 'normal' as const, needs: null }
  it('is skipped (null) when the window has no debugger port', async () => {
    const rung = makeCdpRung(() => Promise.resolve({ debugPort: undefined }))
    expect(await rung({ window: win, request: { action: 'click', x: 1, y: 1 } })).toBeNull()
  })
  it('is skipped for an action the page debugger does not do', async () => {
    const rung = makeCdpRung(() => Promise.resolve({ debugPort: 9222, page: { x: 0, y: 0, width: 5, height: 5 } }))
    expect(await rung({ window: win, request: { action: 'toggle' } })).toBeNull()
  })
})
