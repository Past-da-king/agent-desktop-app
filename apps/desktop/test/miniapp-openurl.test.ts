/**
 * agent.openUrl (29 Oct 2026): a mini-app opens an https link in his default browser (desktop) or the app Android
 * picks (phone), with no permission entry, a few at a time and logged; a plain <a href> click goes the same way.
 */
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import type { JsonObject } from '@agent/core'

import { Store } from '../src/main/db'
import { MiniAppStore } from '../src/main/miniapps/store'
import { MiniAppHost } from '../src/main/miniapps/host'
import { plainHost } from '../src/main/miniapps/plugin-host'
import { MINIAPP_GUIDE } from '../src/main/tools/miniapps'
import { checkOpenUrl, lintMiniApp, MINIAPP_OPEN_RATE, type MiniAppDraft } from '../src/shared/miniapps'
import { agentJs } from '../src/shared/miniapp-kit'

const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d'
const MEET = 'https://meet.google.com/abc-defg-hij'

function draft(js: string, html = '<!doctype html><html><head></head><body><div id="x"></div><script src="app.js"></script></body></html>'): MiniAppDraft {
  return { name: 'Cal', description: 'd', icon: 'cal', files: { 'index.html': html, 'app.js': js }, permissions: ['calendar_events'], subscribe: [], refreshMinutes: 0 }
}

describe('checkOpenUrl', () => {
  it('lets https links through and refuses everything else with a reason', () => {
    expect(checkOpenUrl(TEAMS)).toEqual({ ok: true, url: TEAMS })
    expect(checkOpenUrl(`  ${MEET}  `)).toEqual({ ok: true, url: MEET })
    for (const bad of ['http://meet.google.com/x', 'javascript:alert(1)', 'file:///C:/x', 'msteams://l/x', 'intent://x#Intent;end', 'data:text/html,x', 'https://user:pw@example.com/', 'meet.google.com/x', '', 42, null]) {
      const verdict = checkOpenUrl(bad)
      expect(verdict.ok, String(bad)).toBe(false)
      if (!verdict.ok) expect(verdict.why.length).toBeGreaterThan(5)
    }
    expect(checkOpenUrl('http://x.example/')).toMatchObject({ ok: false, why: 'Only https links open (not http).' })
    expect(checkOpenUrl(`https://x.example/${'a'.repeat(5000)}`).ok).toBe(false)
  })
})

describe('mini-app lint and links', () => {
  it('an https link in an <a href> or in agent.openUrl("...") is not network; other addresses still are', () => {
    expect(lintMiniApp(draft(`agent.openUrl('${MEET}')`))).toEqual([])
    expect(lintMiniApp(draft('', `<!doctype html><html><head></head><body><a class="btn" href="${MEET}" target="_blank">Join</a><script src="app.js"></script></body></html>`))).toEqual([])
    expect(lintMiniApp(draft("const u='https://evil.example/?d='+x")).some((f) => f.rule === 'network')).toBe(true)
    expect(lintMiniApp(draft('', `<!doctype html><html><head></head><body><img src="${MEET}"><script src="app.js"></script></body></html>`)).some((f) => f.rule === 'network')).toBe(true)
    expect(lintMiniApp(draft("window.open('x')")).some((f) => f.rule === 'escape')).toBe(true)
  })

  it('the guide tells agents how to open links', () => {
    expect(MINIAPP_GUIDE).toContain('agent.openUrl(url)')
    expect(MINIAPP_GUIDE).toMatch(/https only/)
  })
})

async function fixture() {
  let t = 10_000
  const store = new Store(':memory:', () => t)
  const apps = new MiniAppStore({ store, now: () => t })
  const made = await apps.create(draft("agent.call('calendar_events',{})"), { by: 'agent', profile: '' })
  if (!made.ok) throw new Error(made.why)
  const opened: string[] = []
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = []
  const host = new MiniAppHost({
    apps,
    onRowsChange: (listener) => store.onChange(listener),
    runTool: async (_app, _tool: string, _args: JsonObject) => '[]',
    approve: async () => {
      throw new Error('a link never asks')
    },
    openUrl: async (url) => {
      opened.push(url)
    },
    host: plainHost(),
    now: () => t,
    log: (message, detail) => logs.push({ message, ...(detail === undefined ? {} : { detail }) }),
  })
  await host.start()
  return { host, app: made.app, opened, logs, tick: (ms: number) => (t += ms) }
}

describe('mini-app host: open', () => {
  it('a window session opens the https link on this computer, logs the host only, and asks nothing', async () => {
    const f = await fixture()
    const sid = f.host.openSession(f.app.id, () => undefined, 'window')!
    expect(await f.host.handle(sid, { op: 'open', id: 1, url: TEAMS })).toEqual({ op: 'reply', id: 1, ok: true, result: 'Opened.' })
    expect(f.opened).toEqual([TEAMS])
    const line = f.logs.find((l) => l.message === 'Mini-app link opened')
    expect(line?.detail).toEqual({ app: f.app.id, host: 'teams.microsoft.com', on: 'window' })
    expect(JSON.stringify(f.logs)).not.toContain('meetup-join')
    await f.host.stop()
  })

  it('refuses anything but https, with the reason, and opens nothing', async () => {
    const f = await fixture()
    const sid = f.host.openSession(f.app.id, () => undefined, 'window')!
    expect(await f.host.handle(sid, { op: 'open', id: 2, url: 'http://meet.google.com/x' })).toMatchObject({ ok: false, error: 'Only https links open (not http).' })
    expect(await f.host.handle(sid, { op: 'open', id: 3, url: 'javascript:alert(1)' })).toMatchObject({ ok: false })
    expect(await f.host.handle(sid, { op: 'open', id: 4 })).toMatchObject({ ok: false })
    expect(f.opened).toEqual([])
    expect(f.logs.filter((l) => l.message === 'Mini-app link not opened').length).toBe(3)
    await f.host.stop()
  })

  it('is rate-limited per app', async () => {
    const f = await fixture()
    const sid = f.host.openSession(f.app.id, () => undefined, 'window')!
    for (let i = 0; i < MINIAPP_OPEN_RATE.opens; i += 1) expect(await f.host.handle(sid, { op: 'open', id: 10 + i, url: MEET })).toMatchObject({ ok: true })
    expect(await f.host.handle(sid, { op: 'open', id: 20, url: MEET })).toMatchObject({ ok: false, error: expect.stringMatching(/^Too many links/) })
    expect(f.opened.length).toBe(MINIAPP_OPEN_RATE.opens)
    f.tick(MINIAPP_OPEN_RATE.perMs + 1)
    expect(await f.host.handle(sid, { op: 'open', id: 21, url: MEET })).toMatchObject({ ok: true })
    await f.host.stop()
  })

  it('the look check opens nothing; a phone session gets the checked link back to open itself', async () => {
    const f = await fixture()
    const check = f.host.openSession(f.app.id, () => undefined, 'check')!
    expect(await f.host.handle(check, { op: 'open', id: 1, url: MEET })).toMatchObject({ ok: true, result: 'Not opened during the check.' })
    const phone = f.host.openSession(f.app.id, () => undefined, 'device')!
    expect(await f.host.handle(phone, { op: 'open', id: 2, url: TEAMS })).toEqual({ op: 'reply', id: 2, ok: true, result: { open: TEAMS } })
    expect(await f.host.handle(phone, { op: 'open', id: 3, url: 'http://x.example' })).toMatchObject({ ok: false })
    expect(f.opened).toEqual([])
    await f.host.stop()
  })
})

/** agent.js in a small fake page: what it sends, and the click listener it adds. */
function page(origin = 'miniapp://maabc123/') {
  const sent: Array<Record<string, unknown>> = []
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = [...(listeners[type] ?? []), fn]),
    __miniappHost: { post: (text: string) => sent.push(JSON.parse(text)), onMessage: () => undefined },
  }
  const context: Record<string, unknown> = {
    window: win,
    location: new URL(`${origin}index.html?theme=light`),
    document: { documentElement: { setAttribute: () => undefined, style: { setProperty: () => undefined } } },
    URL,
    URLSearchParams,
    Promise,
    JSON,
    console,
  }
  win['window'] = win
  runInNewContext(agentJs(), Object.assign(win, context))
  const click = (href: string | null, extra: Record<string, unknown> = {}) => {
    let prevented = false
    const anchor = href === null ? null : { getAttribute: () => href }
    const event = { button: 0, defaultPrevented: false, target: { closest: () => anchor }, preventDefault: () => (prevented = true), ...extra }
    for (const fn of listeners['click'] ?? []) fn(event)
    return prevented
  }
  return { sent, click, agent: win['agent'] as { openUrl: (url: string) => Promise<unknown> } }
}

describe('agent.js: openUrl and link clicks', () => {
  it('agent.openUrl sends an open request', () => {
    const p = page()
    void p.agent.openUrl(MEET)
    expect(p.sent.at(-1)).toMatchObject({ op: 'open', url: MEET })
  })

  it('a click on an outside <a href> (target=_blank or not) goes through openUrl; its own files and # links do not', () => {
    const p = page()
    expect(p.click(TEAMS)).toBe(true)
    expect(p.sent.at(-1)).toMatchObject({ op: 'open', url: TEAMS })
    const before = p.sent.length
    expect(p.click('#today')).toBe(false)
    expect(p.click('other.html')).toBe(false)
    expect(p.click(null)).toBe(false)
    expect(p.click(MEET, { defaultPrevented: true })).toBe(false)
    expect(p.click(MEET, { button: 1 })).toBe(false)
    expect(p.sent.length).toBe(before)
    // An http link still goes to the host, which refuses it with the reason.
    expect(p.click('http://x.example/')).toBe(true)
    expect(p.sent.at(-1)).toMatchObject({ op: 'open', url: 'http://x.example/' })
  })

  it('works the same on the phone origin', () => {
    const p = page('https://maabc123.miniapp.invalid/')
    expect(p.click('/index.html')).toBe(false)
    expect(p.click(MEET)).toBe(true)
    expect(p.sent.at(-1)).toMatchObject({ op: 'open', url: MEET })
  })
})
