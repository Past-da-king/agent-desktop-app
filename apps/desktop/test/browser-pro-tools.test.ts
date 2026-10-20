import { describe, expect, it } from 'vitest'

import type { ActRequest, BrowserProDriver, FixRequest, ViewRequest } from '../src/main/browser/types'
import { browserProTools, parseHeaders } from '../src/main/tools/browser-pro'
import { testContext, toolNamed } from './support'

class FakePro implements BrowserProDriver {
  views: ViewRequest[] = []
  fixes: FixRequest[] = []
  acts: ActRequest[] = []
  evals: Array<{ code: string; seconds: number }> = []
  snaps: Array<{ filter?: string; deep?: boolean }> = []
  async view(request: ViewRequest): Promise<string> {
    this.views.push(request)
    return 'viewed'
  }
  async fix(request: FixRequest): Promise<string> {
    this.fixes.push(request)
    return 'fixed'
  }
  async snapshotPro(options: { filter?: string; deep?: boolean }): Promise<string> {
    this.snaps.push(options)
    return 'snap'
  }
  async act(request: ActRequest): Promise<string> {
    this.acts.push(request)
    return 'acted'
  }
  async evaluate(code: string, seconds: number): Promise<string> {
    this.evals.push({ code, seconds })
    return 'evaluated'
  }
}

describe('the stronger browser tools', () => {
  it('offers browser_view, browser_fix, browser_snapshot, browser_act and browser_eval', () => {
    const names = browserProTools({ browser: new FakePro() }).map((tool) => tool.spec.name)
    expect(names).toEqual(['browser_view', 'browser_fix', 'browser_snapshot', 'browser_act', 'browser_eval'])
  })

  it('browser_view understands mobile, sizes and aspect, and refuses an empty call', async () => {
    const fake = new FakePro()
    const tools = browserProTools({ browser: fake })
    const view = toolNamed(tools, 'browser_view')
    await view.run({ mode: 'mobile', width: '430', aspect: '9:19.5', asDefault: true }, testContext())
    expect(fake.views[0]).toEqual({ mode: 'phone', width: 430, aspect: '9:19.5', asDefault: true })
    expect(await view.run({ mode: 'toaster' }, testContext())).toContain('mode is')
    expect(await view.run({}, testContext())).toContain('Pass a mode')
  })

  it('browser_fix parses headers one per line and checks the action', async () => {
    const fake = new FakePro()
    const fix = toolNamed(browserProTools({ browser: fake }), 'browser_fix')
    await fix.run({ action: 'headers', headers: 'X-One: 1\nAccept-Language: en-GB' }, testContext())
    expect(fake.fixes[0]?.headers).toEqual({ 'X-One': '1', 'Accept-Language': 'en-GB' })
    expect(await fix.run({ action: 'headers', headers: 'no colon here' }, testContext())).toContain('Name: value')
    expect(await fix.run({ action: 'explode' }, testContext())).toContain('action is one of')
    expect(parseHeaders('A: b: c')).toEqual({ A: 'b: c' })
  })

  it('browser_act passes name, role, nth and screenshot coordinates through', async () => {
    const fake = new FakePro()
    const act = toolNamed(browserProTools({ browser: fake }), 'browser_act')
    await act.run({ action: 'click', name: 'Sign in', role: 'button', nth: 2 }, testContext())
    await act.run({ action: 'drag', at_x: 10, at_y: 20, to_x: 300, to_y: 20 }, testContext())
    expect(fake.acts[0]).toEqual({ action: 'click', name: 'Sign in', role: 'button', nth: 2 })
    expect(fake.acts[1]).toMatchObject({ at: { x: 10, y: 20 }, to: { x: 300, y: 20 } })
    expect(await act.run({ action: 'click', at_x: 5 }, testContext())).toContain('both at_x and at_y')
  })

  it('browser_eval needs a script and caps how long it waits', async () => {
    const fake = new FakePro()
    const run = toolNamed(browserProTools({ browser: fake }), 'browser_eval')
    expect(await run.run({ js: '  ' }, testContext())).toContain('Pass the script')
    await run.run({ js: 'document.title', seconds: 999 }, testContext())
    expect(fake.evals[0]).toEqual({ code: 'document.title', seconds: 120 })
  })

  it('says the browser is not open when the driver lacks the stronger controls', async () => {
    const tools = browserProTools({ browser: { open: async () => '' } })
    expect(await toolNamed(tools, 'browser_snapshot').run({}, testContext())).toContain('not open')
  })
})
