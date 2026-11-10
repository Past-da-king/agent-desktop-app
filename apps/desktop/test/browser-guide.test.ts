/**
 * Guided click-through in a real Chromium (26 Oct 2026): the target is found the way browser_act finds it, inside
 * same-origin and cross-origin frames (a cross-site frame is its own process, reached through its own debugger
 * session as in the app); the ring sits on the element; his trusted click (CDP input, as a real mouse) ends the step
 * at once, a synthetic click never does; typing, I did it, Skip, timeout and cancel all return; the page's own
 * handlers run and nothing is prevented; the overlay is gone after every step; a chain stops early when a target is
 * missing.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { chromium, type Browser, type CDPSession, type Frame, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { findTarget, formatGuide, GuideRuns, runGuide, type GuideHost, type GuideStep } from '../src/main/browser/guide'
import { evaluateIn, FrameSessions, type GuideLink } from '../src/main/browser/guide-host'
import { DRAWS, guideOn, type RecordingSurface } from './helpers/outside-surface'

function findChrome(): string | null {
  const env = process.env.CHROME_PATH
  if (env !== undefined && env !== '' && existsSync(env)) return env
  const base = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    const path = join(base, dir, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}

const chrome = findChrome()
const suite = chrome === null ? describe.skip : describe

let portA = 0
let portB = 0
const A = (): string => `http://127.0.0.1:${portA}`
const B = (): string => `http://localhost:${portB}`

const page1 = (): string => `<!doctype html><title>One</title><body style="margin:0">
<h1>Step one</h1>
<button id="go" style="margin:40px">Next page</button>
<button id="other">Something else</button>
<div style="height:1600px"></div>
<button id="far">Far down</button>
<div style="height:1200px"></div>
<script>
window.__ownClicks = 0;
document.getElementById('go').addEventListener('click', () => { window.__ownClicks++; localStorage.setItem('p1', 'ran'); location.href = '/p2'; });
document.getElementById('other').addEventListener('click', () => { window.__ownClicks++; });
document.getElementById('far').addEventListener('click', () => { window.__ownClicks++; });
</script></body>`

const page2 = (): string => `<!doctype html><title>Two</title><body>
<h1>Step two</h1>
<button id="open">Open form</button>
<dialog id="d"><label>Pixel name <input id="pname"></label><button id="confirm">Confirm</button></dialog>
<p id="out"></p>
<script>
document.getElementById('open').addEventListener('click', () => document.getElementById('d').showModal());
document.getElementById('confirm').addEventListener('click', () => { document.getElementById('out').textContent = 'Saved ' + document.getElementById('pname').value; document.getElementById('d').close(); });
</script></body>`

const page3 = (): string => `<!doctype html><title>Three</title><body>
<h1>Step three</h1>
<iframe id="same" src="/inner" style="width:300px;height:120px"></iframe>
<iframe id="cross" src="${B()}/frame" style="width:400px;height:160px;margin-top:20px"></iframe>
</body>`

const inner = (): string => `<!doctype html><body><button id="ib">Same origin inside</button><script>document.getElementById('ib').addEventListener('click', () => { document.body.dataset.hit = 'yes'; });</script></body>`
const frame = (): string => `<!doctype html><body style="margin:0"><button id="fb" style="margin:30px">Inside frame</button><script>document.getElementById('fb').addEventListener('click', () => { document.body.dataset.hit = 'yes'; });</script></body>`

const rerender = (): string => `<!doctype html><title>Re</title><body><div id="box"><button>Keep going</button></div>
<script>setTimeout(() => { document.getElementById('box').innerHTML = '<button style="margin-top:80px">Keep going</button>'; }, 400);</script></body>`

let serverA: Server
let serverB: Server

function serve(handler: (path: string) => string | null): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = handler((req.url ?? '/').split('?')[0] ?? '/')
      if (body === null) {
        res.writeHead(404)
        res.end('nope')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

/**
 * The app's debugger link, built from Playwright's CDP sessions: the page's own, plus one per cross-site frame
 * (announced as Target.attachedToTarget with the frame's id, exactly what flat auto-attach gives the app).
 */
async function linkFor(page: Page): Promise<GuideLink & { refresh(): Promise<void> }> {
  const main = await page.context().newCDPSession(page)
  const sessions = new Map<string, CDPSession>()
  const listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  const emit = (method: string, params: Record<string, unknown>, sid?: string): void => {
    for (const listener of listeners) listener(method, params, sid)
  }
  const wire = (session: CDPSession, sid?: string): void => {
    for (const method of ['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Page.frameNavigated', 'Runtime.bindingCalled'] as const) {
      session.on(method, (params: unknown) => emit(method, params as Record<string, unknown>, sid))
    }
  }
  wire(main)
  await main.send('Page.enable')
  await main.send('Runtime.enable')
  const refresh = async (): Promise<void> => {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.isDetached()) continue
      let session: CDPSession
      try {
        session = await page.context().newCDPSession(f)
      } catch {
        continue // a same-process frame: the page's own session reaches it
      }
      const tree = (await session.send('Page.getFrameTree')) as { frameTree: { frame: { id: string; url: string } } }
      const targetId = tree.frameTree.frame.id
      if (sessions.has(targetId)) {
        await session.detach().catch(() => undefined)
        continue
      }
      sessions.set(targetId, session)
      wire(session, targetId)
      await session.send('Page.enable')
      await session.send('Runtime.enable')
      emit('Target.attachedToTarget', { sessionId: targetId, targetInfo: { type: 'iframe', targetId, url: tree.frameTree.frame.url } })
    }
  }
  return {
    send: (method, params = {}, sid) => {
      if (method === 'Target.setAutoAttach') return Promise.resolve({})
      const session = sid === undefined ? main : sessions.get(sid)
      if (session === undefined) return Promise.reject(new Error('No session'))
      return session.send(method as 'Runtime.evaluate', params as never)
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
  }
}

async function hostFor(page: Page): Promise<{ host: GuideHost; frames: FrameSessions }> {
  const link = await linkFor(page)
  const frames = new FrameSessions(link)
  await frames.start()
  const host: GuideHost = {
    frames: async () => {
      await link.refresh()
      return frames.frames()
    },
    evaluate: (key, code) => evaluateIn(frames, key, code),
    page: async () => ({ url: page.url(), title: await page.title().catch(() => ''), dialogs: [], text: '' }),
    onNavigate: (listener) => {
      const handler = (f: Frame): void => {
        if (f === page.mainFrame()) listener()
      }
      page.on('framenavigated', handler)
      return () => page.off('framenavigated', handler)
    },
    onReport: (listener) => frames.onReport(listener),
    loading: () => false,
    ready: async (ms) => {
      await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => undefined)
    },
  }
  return { host, frames }
}

/** The ring's box, the label's box and its two buttons, as the overlay host reports them, in its frame's viewport. */
async function overlayIn(f: Frame): Promise<{ box: number[]; label: number[]; ok: number[]; skip: number[] } | null> {
  return f.evaluate(() => {
    const host = document.querySelector('[data-agent-guide]')
    if (host === null || host.getAttribute('data-agent-guide-box') === null) return null
    const nums = (s: string | null): number[] => (s ?? '').split(',').map(Number)
    const [ok = '', skip = ''] = (host.getAttribute('data-agent-guide-buttons') ?? '').split(';')
    return { box: nums(host.getAttribute('data-agent-guide-box')), label: nums(host.getAttribute('data-agent-guide-label')), ok: nums(ok), skip: nums(skip) }
  })
}

async function waitOverlay(f: Frame, ms = 5000): Promise<{ box: number[]; label: number[]; ok: number[]; skip: number[] }> {
  const end = Date.now() + ms
  for (;;) {
    const o = await overlayIn(f).catch(() => null)
    if (o !== null) return o
    if (Date.now() > end) throw new Error('no overlay')
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function overlays(page: Page): Promise<number> {
  let n = 0
  for (const f of page.frames()) n += await f.evaluate(() => document.querySelectorAll('[data-agent-guide]').length).catch(() => 0)
  return n
}

const centre = (b: number[]): { x: number; y: number } => ({ x: (b[0] ?? 0) + (b[2] ?? 0) / 2, y: (b[1] ?? 0) + (b[3] ?? 0) / 2 })

suite.each(DRAWS)('browser_guide in a real Chromium (ring drawn by: %s)', (draw) => {
  let browser: Browser
  let page: Page
  // Every test runs twice: the page draws its own ring, or it only reports and something outside draws (the private
  // overlay). His click, typing, the chain, frames, re-renders, timeout and cancel must be the same on both.
  let guide = guideOn(draw).run
  let surface: RecordingSurface | null = null

  beforeAll(async () => {
    const a = await serve((path) => ({ '/p1': page1(), '/p2': page2(), '/p3': page3(), '/inner': inner(), '/re': rerender(), '/done': '<!doctype html><title>Done</title><h1>Done</h1>' })[path] ?? null)
    serverA = a.server
    portA = a.port
    const b = await serve((path) => (path === '/frame' ? frame() : null))
    serverB = b.server
    portB = b.port
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox', '--site-per-process'] })
  })

  afterAll(async () => {
    await browser?.close()
    serverA?.close()
    serverB?.close()
  })

  beforeEach(async () => {
    await page?.close().catch(() => undefined)
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    const on = guideOn(draw)
    guide = on.run
    surface = on.surface
  })

  afterEach(async () => {
    if (surface === null) return
    // Drawn outside: every step that began was ended (nothing stays on the screen), and the page painted nothing.
    expect(surface.ended).toEqual(surface.begun.map((step) => step.token))
    if (surface.begun.length > 0) expect(surface.reports.some((report) => report.shown)).toBe(true)
  })

  it('finds targets by name, role and nth in the page, a same-origin frame and a cross-origin frame', async () => {
    await page.goto(`${A()}/p3`)
    await page.frameLocator('#cross').locator('#fb').waitFor()
    const { host } = await hostFor(page)
    const frames = await host.frames()
    expect(frames.length).toBe(3)
    expect(frames[0]?.top).toBe(true)
    const cross = await findTarget(host, { name: 'Inside frame', role: 'button' }, 't1', Date.now() + 1000, undefined)
    expect(cross.ok).toBe(true)
    if (cross.ok) expect(cross.frame.url).toContain(`localhost:${portB}`)
    const same = await findTarget(host, { name: 'Same origin inside' }, 't2', Date.now() + 1000, undefined)
    expect(same.ok && same.frame.url.endsWith('/inner')).toBe(true)
    const missing = await findTarget(host, { name: 'Not here at all' }, 't3', Date.now() + 300, undefined)
    expect(missing.ok).toBe(false)
  })

  it('draws the ring on the element and returns his trusted click within a second; the page handles it as usual', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const steps: GuideStep[] = [{ target: { name: 'Next page', role: 'button' }, label: 'Click Next page' }]
    const run = guide(host, steps, { timeoutMs: 10_000 })
    const o = await waitOverlay(page.mainFrame())
    const el = await page.locator('#go').boundingBox()
    expect(el).not.toBeNull()
    expect(Math.abs((o.box[0] ?? 0) - el!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs((o.box[1] ?? 0) - el!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs((o.box[2] ?? 0) - el!.width)).toBeLessThanOrEqual(1)
    // The label never sits on the target.
    const [lx = 0, ly = 0, lw = 0, lh = 0] = o.label
    const overlaps = lx < el!.x + el!.width && lx + lw > el!.x && ly < el!.y + el!.height && ly + lh > el!.y
    expect(overlaps).toBe(false)
    const painted = await page.evaluate(() => getComputedStyle(document.querySelector('[data-agent-guide]')!).visibility)
    if (surface === null) {
      expect(painted).toBe('visible')
    } else {
      // Drawn outside: nothing of the guide is painted in the page, and the page said exactly where the target is.
      expect(painted).toBe('hidden')
      await expect.poll(() => surface!.last()?.shown ?? false, { timeout: 3000 }).toBe(true)
      const told = surface.last()!
      expect(Math.abs(told.box!.x - el!.x)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(told.box!.y - el!.y)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(told.box!.width - el!.width)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(told.box!.height - el!.height)).toBeLessThanOrEqual(0.5)
      expect([told.vw, told.vh]).toEqual([1000, 700])
      expect([told.tag!.x, told.tag!.y, told.tag!.width, told.tag!.height]).toEqual(o.label)
      expect(surface.current()).toMatchObject({ label: 'Click Next page', n: 1, total: 1 })
    }
    const clickedAt = Date.now()
    await page.mouse.click(el!.x + el!.width / 2, el!.y + el!.height / 2)
    const result = await run
    const took = Date.now() - clickedAt
    expect(result.outcome).toBe('clicked')
    expect(result.steps[0]?.returnMs ?? 9999).toBeLessThan(1000)
    expect(took).toBeLessThan(4000)
    // His click did what it does in any browser: the page's own handler ran and navigated.
    expect(result.url).toContain('/p2')
    expect(await page.evaluate(() => localStorage.getItem('p1'))).toBe('ran')
    expect(await overlays(page)).toBe(0)
    expect(formatGuide(result, 'guide-1')).toContain('clicked')
  })

  it('ignores a synthetic click; only his trusted click counts', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const run = guide(host, [{ target: { name: 'Something else' }, label: 'Click it' }], { timeoutMs: 10_000 })
    await waitOverlay(page.mainFrame())
    let settled = false
    void run.then(() => (settled = true))
    await page.evaluate(() => (document.getElementById('other') as HTMLButtonElement).click())
    await page.evaluate(() => document.getElementById('other')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await new Promise((r) => setTimeout(r, 400))
    expect(settled).toBe(false)
    expect(await page.evaluate(() => (window as unknown as { __ownClicks: number }).__ownClicks)).toBe(2)
    const el = (await page.locator('#other').boundingBox())!
    await page.mouse.click(el.x + 5, el.y + 5)
    const result = await run
    expect(result.outcome).toBe('clicked')
    expect(await page.evaluate(() => (window as unknown as { __ownClicks: number }).__ownClicks)).toBe(3)
  })

  it('scrolls a target out of sight into view and follows it on scroll', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const run = guide(host, [{ target: { name: 'Far down' }, label: 'Click Far down' }], { timeoutMs: 10_000 })
    const o = await waitOverlay(page.mainFrame())
    expect((o.box[1] ?? -1) >= 0 && (o.box[1] ?? 9999) < 700).toBe(true)
    await page.mouse.wheel(0, -120)
    await new Promise((r) => setTimeout(r, 250))
    const el = (await page.locator('#far').boundingBox())!
    const after = await waitOverlay(page.mainFrame())
    expect(Math.abs((after.box[1] ?? 0) - el.y)).toBeLessThanOrEqual(1)
    // Drawn outside: the page told where the target went the moment it scrolled.
    if (surface !== null) expect(Math.abs((surface.last()?.box?.y ?? -999) - el.y)).toBeLessThanOrEqual(0.5)
    await page.mouse.click(el.x + 3, el.y + 3)
    expect((await run).outcome).toBe('clicked')
  })

  it('walks a chain: a navigation, a modal dialog with a field he types in, a confirm button', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const steps: GuideStep[] = [
      { target: { name: 'Next page' }, label: 'Click Next page' },
      { target: { name: 'Open form' }, label: 'Open the form' },
      { target: { name: 'Pixel name', role: 'textbox' }, label: 'Type a name' },
      { target: { name: 'Confirm' }, label: 'Click Confirm' },
    ]
    const shown: number[] = []
    const run = guide(host, steps, { timeoutMs: 20_000, onStep: (e) => e.kind === 'shown' && shown.push(e.n) })
    for (const [n, selector] of [[1, '#go'], [2, '#open']] as const) {
      await expect.poll(() => shown.includes(n), { timeout: 6000 }).toBe(true)
      await waitOverlay(page.mainFrame())
      const el = (await page.locator(selector).boundingBox())!
      await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2)
    }
    await expect.poll(() => shown.includes(3), { timeout: 6000 }).toBe(true)
    const o = await waitOverlay(page.mainFrame())
    const field = (await page.locator('#pname').boundingBox())!
    // The ring is drawn above the modal dialog (top layer) and sits on the field.
    expect(Math.abs((o.box[0] ?? 0) - field.x)).toBeLessThanOrEqual(1)
    // The label leaves the dialog's other buttons clear (Confirm is the next thing he needs).
    for (const other of ['#confirm']) {
      const b = (await page.locator(other).boundingBox())!
      const [lx = 0, ly = 0, lw = 0, lh = 0] = o.label
      expect(lx < b.x + b.width && lx + lw > b.x && ly < b.y + b.height && ly + lh > b.y).toBe(false)
    }
    await page.mouse.click(field.x + 5, field.y + 5)
    await page.keyboard.type('Shop pixel')
    await page.keyboard.press('Enter')
    await expect.poll(() => shown.includes(4), { timeout: 6000 }).toBe(true)
    await waitOverlay(page.mainFrame())
    const confirm = (await page.locator('#confirm').boundingBox())!
    await page.mouse.click(confirm.x + confirm.width / 2, confirm.y + confirm.height / 2)
    const result = await run
    expect(result.outcome).toBe('clicked')
    expect(result.completed).toBe(4)
    expect(result.steps.map((s) => s.outcome)).toEqual(['clicked', 'clicked', 'typed', 'clicked'])
    expect(result.steps[2]?.value).toBe('Shop pixel')
    expect(await page.locator('#out').textContent()).toBe('Saved Shop pixel')
    for (const step of [result.steps[1], result.steps[3]]) expect(step?.returnMs ?? 9999).toBeLessThan(1000)
    expect(await overlays(page)).toBe(0)
  })

  it('guides inside a cross-origin frame and the frame handles his click', async () => {
    await page.goto(`${A()}/p3`)
    await page.frameLocator('#cross').locator('#fb').waitFor()
    const { host } = await hostFor(page)
    const run = guide(host, [{ target: { name: 'Inside frame' }, label: 'Click inside the frame' }], { timeoutMs: 10_000 })
    const cross = page.frames().find((f) => f.url().includes(`localhost:${portB}`))!
    const o = await waitOverlay(cross)
    const local = await cross.evaluate(() => { const r = document.getElementById('fb')!.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })
    expect(Math.abs((o.box[0] ?? 0) - (local[0] ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((o.box[1] ?? 0) - (local[1] ?? 0))).toBeLessThanOrEqual(1)
    const el = (await page.frameLocator('#cross').locator('#fb').boundingBox())!
    await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2)
    const result = await run
    expect(result.outcome).toBe('clicked')
    expect(result.steps[0]?.frame).toContain(`localhost:${portB}`)
    expect(result.steps[0]?.returnMs ?? 9999).toBeLessThan(1000)
    expect(await cross.evaluate(() => document.body.dataset['hit'])).toBe('yes')
    expect(await overlays(page)).toBe(0)
  })

  it('stops the chain early when the next target is not on the page, with what is there', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const run = guide(host, [
      { target: { name: 'Something else' }, label: 'Click it' },
      { target: { name: 'Create Pixel' }, label: 'Click Create Pixel' },
    ], { timeoutMs: 10_000, nextFindMs: 600 })
    await waitOverlay(page.mainFrame())
    const el = (await page.locator('#other').boundingBox())!
    await page.mouse.click(el.x + 3, el.y + 3)
    const result = await run
    expect(result.outcome).toBe('not_found')
    expect(result.completed).toBe(1)
    expect(result.steps[1]?.outcome).toBe('not_found')
    expect(formatGuide(result, 'g')).toContain('Stopped at step 2 of 2')
    expect(await overlays(page)).toBe(0)
  })

  it('survives a re-render: the ring finds the new element by name', async () => {
    await page.goto(`${A()}/re`)
    const { host } = await hostFor(page)
    const run = guide(host, [{ target: { name: 'Keep going' }, label: 'Click Keep going' }], { timeoutMs: 10_000 })
    await waitOverlay(page.mainFrame())
    await new Promise((r) => setTimeout(r, 900))
    const el = (await page.locator('button').boundingBox())!
    const o = await waitOverlay(page.mainFrame())
    expect(Math.abs((o.box[1] ?? 0) - el.y)).toBeLessThanOrEqual(1)
    await page.mouse.click(el.x + 3, el.y + 3)
    expect((await run).outcome).toBe('clicked')
  })

  it('I did it and Skip on the label end the step; their clicks never reach the page', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const run = guide(host, [
      { target: { name: 'Something else' }, label: 'Click it' },
      { target: { name: 'Far down' }, label: 'Then this' },
    ], { timeoutMs: 10_000 })
    let o = await waitOverlay(page.mainFrame())
    if (surface === null) {
      await page.mouse.click(centre(o.ok).x, centre(o.ok).y)
      await new Promise((r) => setTimeout(r, 300))
      o = await waitOverlay(page.mainFrame())
      await page.mouse.click(centre(o.skip).x, centre(o.skip).y)
    } else {
      // Drawn outside: the two buttons are in the overlay window; pressing one ends the step in the page.
      // A click where the page's own (unpainted) buttons are laid out reaches nothing of the guide.
      await page.mouse.click(centre(o.ok).x, centre(o.ok).y)
      await new Promise((r) => setTimeout(r, 200))
      expect(surface.ended.length).toBe(0)
      surface.current()!.act('done')
      await expect.poll(() => surface!.begun.length, { timeout: 5000 }).toBe(2)
      surface.current()!.act('skipped')
    }
    const result = await run
    expect(result.steps.map((s) => s.outcome)).toEqual(['done', 'skipped'])
    expect(await page.evaluate(() => (window as unknown as { __ownClicks: number }).__ownClicks)).toBe(0)
  })

  it('times out with what the page shows, and the overlay is gone', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const result = await guide(host, [{ target: { name: 'Something else' }, label: 'Click it' }], { timeoutMs: 1200 })
    expect(result.outcome).toBe('timeout')
    expect(result.url).toContain('/p1')
    await new Promise((r) => setTimeout(r, 100))
    expect(await overlays(page)).toBe(0)
  })

  it('a run that ends cancels its guide at once (GuideRuns) and the overlay is removed', async () => {
    await page.goto(`${A()}/p1`)
    const { host } = await hostFor(page)
    const runs = new GuideRuns()
    const mine = runs.start('tab-1', 'helper:h1')
    const other = runs.start('tab-2', 'main')
    const run = guide(host, [{ target: { name: 'Something else' }, label: 'Click it' }], { timeoutMs: 20_000, signal: mine.abort.signal })
    await waitOverlay(page.mainFrame())
    const at = Date.now()
    expect(runs.endOwner('helper:h1')).toBe(1)
    const result = await run
    expect(Date.now() - at).toBeLessThan(1000)
    expect(result.outcome).toBe('cancelled')
    expect(mine.endedBy).toBe('run')
    expect(other.abort.signal.aborted).toBe(false)
    runs.finish(mine)
    expect(runs.running('tab-1')).toBe(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(await overlays(page)).toBe(0)
  })
})
