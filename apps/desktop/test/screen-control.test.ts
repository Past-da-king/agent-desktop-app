import { describe, expect, it, vi } from 'vitest'

import { memoryTakers, ScreenControl } from '../src/main/agent-cursor/control'
import type { ScreenActAnswer } from '../src/main/agent-cursor/control'
import { InputLock } from '../src/main/agent-cursor/input-lock'
import { actText, screenControlTools } from '../src/main/tools/screen-control'
import { testContext, toolNamed } from './support'

const W = (over: Record<string, unknown> = {}) => ({ hwnd: '0x10', pid: 4, process: 'notepad', title: 'Untitled - Notepad', className: 'Notepad', bounds: { x: 100, y: 100, width: 800, height: 600 }, elevated: false, ...over })

function rig(handlers: Record<string, (args: Record<string, unknown>) => unknown>, extra: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = []
  const control = new ScreenControl({
    call: async (op, args = {}) => {
      calls.push({ op, args })
      const h = handlers[op]
      if (h === undefined) throw Object.assign(new Error('unknown op ' + op), { code: 'unknown' })
      return h(args)
    },
    savePicture: async () => '/tmp/p.png',
    ...extra,
  })
  return { control, calls }
}

const worked = (rung: string, fg: Record<string, unknown> = {}) => ({ ok: true, rung, evidence: 'state', action: 'type', tried: [{ rung, result: 'worked (state)' }], cursor: { before: { x: 5, y: 5 }, after: { x: 5, y: 5 } }, foreground: { before: '0xA', after: '0xA', taken: false, givenBack: false, times: 0, lostMs: 0, ...fg } })

describe('screen control', () => {
  it('lists windows with minimised ones, and flags administrator and raw-input programs', async () => {
    const { control, calls } = rig({ windows: () => [W(), W({ hwnd: '0x11', process: 'AnyDesk', className: 'ad', title: 'AnyDesk' }), W({ hwnd: '0x12', elevated: true, process: 'taskmgr' }), W({ hwnd: '0x13', minimized: true })] })
    const all = await control.windows()
    expect(calls[0]?.args).toEqual({ minimised: true })
    expect(all.map((w) => [w.hwnd, w.needs !== null, w.minimised, w.integrity])).toEqual([
      ['0x10', false, false, 'normal'],
      ['0x11', true, false, 'normal'],
      ['0x12', true, false, 'elevated'],
      ['0x13', false, true, 'normal'],
    ])
  })

  it('says needs the agent desktop at once for a remote viewer, and never calls act', async () => {
    const { control, calls } = rig({ windows: () => [W({ process: 'anydesk', title: 'AnyDesk' })] })
    const out = await control.act({ hwnd: '0x10', action: 'click', x: 5, y: 5 })
    expect(out).toMatchObject({ ok: false, code: 'needs_agent_desktop' })
    expect(out.message).toContain('agent desktop')
    expect(calls.some((c) => c.op === 'act')).toBe(false)
  })

  it('does the same for an administrator window', async () => {
    const { control } = rig({ windows: () => [W({ elevated: true })] })
    expect(await control.act({ hwnd: '0x10', action: 'type', text: 'x' })).toMatchObject({ ok: false, code: 'elevated' })
  })

  it('re-checks the handle against the window list before acting', async () => {
    const { control } = rig({ windows: () => [W()] })
    expect(await control.act({ hwnd: '0x99', action: 'click', name: 'Save' })).toMatchObject({ ok: false, code: 'no_window' })
  })

  it('sends the pid, the avoid list and the ONE raw-input list to the helper, and reports the rung', async () => {
    const takers = memoryTakers([['notepad', 'Notepad', 'uia:value']])
    const { control, calls } = rig({ windows: () => [W()], act: () => worked('msg:settext') }, { takers })
    const out = await control.act({ hwnd: '0x10', action: 'type', name: 'Text editor', text: 'hello' })
    const act = calls.find((c) => c.op === 'act')?.args ?? {}
    expect(act).toMatchObject({ hwnd: '0x10', pid: 4, action: 'type', avoid: ['uia:value'], name: 'Text editor', text: 'hello' })
    expect(Array.isArray(act['rawProcesses']) && (act['rawProcesses'] as string[]).includes('anydesk')).toBe(true)
    expect(out).toMatchObject({ ok: true, rung: 'msg:settext', his: { cursorMoved: false, foregroundChanged: false } })
    expect(actText(out)).toContain('rung: msg:settext')
  })

  it('remembers a rung that took his focus and skips it next time', async () => {
    const takers = memoryTakers()
    const { control } = rig({ windows: () => [W()], act: () => worked('uia:toggle', { taken: true, givenBack: true, lostMs: 12, tookOn: 'uia:toggle' }) }, { takers })
    const out = await control.act({ hwnd: '0x10', action: 'click', name: 'Bold' })
    expect(out.focus).toMatchObject({ taken: true, givenBack: true, lostMs: 12 })
    expect(out.note).toContain('given back')
    expect(takers.avoid('notepad', 'Notepad')).toEqual(['uia:toggle'])
  })

  it('answers that the program ignores posted input when nothing changed, and does not use real input unasked', async () => {
    const lock = new InputLock({ settings: () => ({ inputLockIdleSeconds: 10 }), presence: { idleMs: async () => 99999 }, notice: { ask: async () => 'go' }, injector: { inject: vi.fn() } as never })
    const { control } = rig({ windows: () => [W()], act: () => ({ ok: false, reason: 'ignored', tried: [{ rung: 'post:mouse', result: 'sent, nothing changed' }], cursor: { before: { x: 1, y: 1 }, after: { x: 1, y: 1 } }, foreground: { before: '0xA', after: '0xA' } }) }, { lock, realInputAllowed: () => true })
    const out = await control.act({ hwnd: '0x10', action: 'click', x: 10, y: 10 })
    expect(out).toMatchObject({ ok: false, code: 'ignored' })
    expect(out.message).toContain('ignores posted input')
  })

  it('real input needs the ask AND the setting, and goes through the lock', async () => {
    const inject = vi.fn(async () => ({ done: 1, of: 1, aborted: false, cursorRestored: true, foregroundRestored: true }))
    const lock = new InputLock({ settings: () => ({ inputLockIdleSeconds: 10 }), presence: { idleMs: async () => 99999 }, notice: { ask: async () => 'go' }, injector: { inject }, sleep: async () => undefined })
    const ignored = () => ({ ok: false, reason: 'ignored', tried: [], cursor: { before: { x: 1, y: 1 }, after: { x: 1, y: 1 } }, foreground: { before: '0xA', after: '0xA' } })
    const off = rig({ windows: () => [W()], act: ignored }, { lock, realInputAllowed: () => false })
    expect(await off.control.act({ hwnd: '0x10', action: 'click', x: 10, y: 10, realInput: true })).toMatchObject({ ok: false, code: 'real_input_off' })
    expect(inject).not.toHaveBeenCalled()
    const on = rig({ windows: () => [W()], act: ignored }, { lock, realInputAllowed: () => true })
    const out = await on.control.act({ hwnd: '0x10', action: 'click', x: 10, y: 10, realInput: true })
    expect(out).toMatchObject({ ok: true, rung: 'real:lock' })
    expect(inject).toHaveBeenCalledOnce()
    expect(inject.mock.calls[0]?.[0]).toMatchObject({ hwnd: '0x10', pid: 4, steps: [{ do: 'click', x: 10, y: 10 }], minIdleMs: 10000 })
  })

  it('uses the CDP hook first for Chromium windows and the desktop hook for what ignores posted input', async () => {
    const cdp = vi.fn(async (): Promise<ScreenActAnswer | null> => ({ ok: true, rung: 'cdp:click', message: 'ok', his: { cursorMoved: false, foregroundChanged: false } }))
    const chrome = rig({ windows: () => [W({ className: 'Chrome_WidgetWin_1', process: 'chrome' })] }, { cdp })
    expect(await chrome.control.act({ hwnd: '0x10', action: 'click', name: 'Go' })).toMatchObject({ ok: true, rung: 'cdp:click' })
    expect(chrome.calls.some((c) => c.op === 'act')).toBe(false)
    const desktop = vi.fn(async (): Promise<ScreenActAnswer | null> => ({ ok: true, rung: 'desktop', message: 'ok', his: { cursorMoved: false, foregroundChanged: false } }))
    const ignored = rig({ windows: () => [W()], act: () => ({ ok: false, reason: 'ignored', tried: [], cursor: { before: { x: 1, y: 1 }, after: { x: 1, y: 1 } }, foreground: {} }) }, { desktop })
    expect(await ignored.control.act({ hwnd: '0x10', action: 'click', x: 1, y: 1 })).toMatchObject({ ok: true, rung: 'desktop' })
  })

  it('reads a window: filtered elements and an off-screen picture', async () => {
    const { control } = rig({
      windows: () => [W()],
      tree: () => ({ seen: 40, nodes: [{ role: 'button', name: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4 }, enabled: true, path: '' }, { role: 'button', name: 'Open', bounds: { x: 1, y: 2, width: 3, height: 4 }, enabled: true, path: '' }] }),
      capture: () => ({ png: Buffer.from('x').toString('base64'), how: 'window' }),
    })
    const out = await control.read({ hwnd: '0x10', filter: 'save', picture: true })
    expect('error' in out).toBe(false)
    if (!('error' in out)) {
      expect(out.elements.map((e) => e.name)).toEqual(['Save'])
      expect(out.picture).toBe('/tmp/p.png')
      expect(out.pictureHow).toBe('window')
    }
  })
})

describe('screen tools', () => {
  const host = (control: ScreenControl) => screenControlTools({ control: () => control })
  it('screen_windows, screen_read and screen_act exist and answer plainly', async () => {
    const { control } = rig({ windows: () => [W()], tree: () => ({ seen: 1, nodes: [] }), act: () => worked('msg:settext') })
    const tools = host(control)
    expect(tools.map((t) => t.spec.name)).toEqual(['screen_windows', 'screen_read', 'screen_act'])
    expect(await toolNamed(tools, 'screen_windows').run({}, testContext())).toContain('Untitled - Notepad')
    expect(await toolNamed(tools, 'screen_read').run({ hwnd: '0x10' }, testContext())).toContain('Elements')
    const done = await toolNamed(tools, 'screen_act').run({ hwnd: '0x10', action: 'type', text: 'x' }, testContext())
    expect(done).toContain('OK')
    expect(done).toContain('his pointer unchanged')
  })
  it('screen_act refuses an unknown action and says when there is no screen', async () => {
    const { control } = rig({ windows: () => [W()] })
    expect(await toolNamed(host(control), 'screen_act').run({ hwnd: '0x10', action: 'fly' }, testContext())).toContain('Say the action')
    expect(await toolNamed(screenControlTools({}), 'screen_act').run({ action: 'click' }, testContext())).toContain('cannot do it')
  })
  it('no description names a real-input API', () => {
    for (const tool of screenControlTools({})) expect(JSON.stringify(tool.spec)).not.toMatch(/SendInput|SetCursorPos|mouse_event|keybd_event|SendKeys|SetForegroundWindow/)
  })
})
