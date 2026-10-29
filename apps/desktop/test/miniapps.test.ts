/**
 * Mini-apps (docs/plans/mini-apps.md): the lint refuses hard-coded colours, fonts, radii, the network and escapes;
 * saves keep versions and undo; pins order the sidebar; the bridge host checks every call against the app's
 * permissions, asks before a change unless he allowed it, runs reads through the real tool, and an edit or delete
 * takes the app's sessions and subscriptions away, on Cordis and on the plain engine alike.
 */
import { describe, expect, it } from 'vitest'

import type { JsonObject, MiniAppRow } from '@agent/core'

import { Store } from '../src/main/db'
import { MiniAppStore } from '../src/main/miniapps/store'
import { MiniAppHost, type Push } from '../src/main/miniapps/host'
import { cordisHost, plainHost } from '../src/main/miniapps/plugin-host'
import { checkCall, checkIcon, lintMiniApp, parseIconSvg, repin, type MiniAppDraft } from '../src/shared/miniapps'
import { frameHtml, serveMiniApp, TOKENS_CSS } from '../src/shared/miniapp-kit'

const GOOD_HTML = `<!doctype html><html><head><title>Plan</title><link rel="stylesheet" href="app.css"></head>
<body><div class="head"><h1 class="h1">Plan</h1></div><ul class="list" id="list"></ul><script src="app.js"></script></body></html>`
const GOOD_CSS = `.done{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent);border-radius:var(--r-sm);font:500 13px/1 var(--font)}
/* #fff is not allowed, this comment is fine */`
const GOOD_JS = `async function load(){const tasks=await agent.call('task_list',{});document.getElementById('list').textContent=JSON.stringify(tasks)}
agent.subscribe('data.task',load);load()`

function draft(over: Partial<MiniAppDraft> = {}): MiniAppDraft {
  return {
    name: 'Plan tracker',
    description: 'Ticks off the plan',
    icon: 'tasks',
    files: { 'index.html': GOOD_HTML, 'app.css': GOOD_CSS, 'app.js': GOOD_JS },
    permissions: ['task_list', 'task_update'],
    subscribe: ['data.task'],
    refreshMinutes: 0,
    ...over,
  }
}

function rules(findings: ReturnType<typeof lintMiniApp>): string[] {
  return findings.map((f) => `${f.rule}:${f.file}`)
}

describe('mini-app lint', () => {
  it('passes an app drawn only with tokens', () => {
    expect(lintMiniApp(draft())).toEqual([])
  })

  it('refuses hard-coded colours in CSS, inline styles, JS and SVG', () => {
    const cases: Array<[string, string]> = [
      ['app.css', '.a{color:#fff}'],
      ['app.css', '.a{background:rgb(1,2,3)}'],
      ['app.css', '.a{border:1px solid red}'],
      ['app.css', '.a{box-shadow:0 0 4px hsl(0 0% 0%)}'],
      ['index.html', '<div style="color:#123456">x</div>'],
      ['index.html', '<svg><path fill="#f00" d="M0 0"/></svg>'],
      ['app.js', "el.style.color = 'white'"],
      ['app.js', "el.style.background = '#abcdef'"],
    ]
    for (const [file, text] of cases) {
      const files = { ...draft().files, [file]: file === 'index.html' ? GOOD_HTML.replace('</body>', `${text}</body>`) : text }
      expect(rules(lintMiniApp(draft({ files }))), text).toContain(`colour:${file}`)
    }
  })

  it('refuses its own fonts and radii', () => {
    expect(rules(lintMiniApp(draft({ files: { ...draft().files, 'app.css': '.a{font-family:Arial}' } })))).toContain('font:app.css')
    expect(rules(lintMiniApp(draft({ files: { ...draft().files, 'app.css': '.a{border-radius:7px}' } })))).toContain('radius:app.css')
    expect(lintMiniApp(draft({ files: { ...draft().files, 'app.css': '.a{border-radius:999px}.b{border-radius:var(--r-lg) var(--r-lg) 0 0}' } }))).toEqual([])
  })

  it('refuses the network and every way out of the frame', () => {
    const bad = [
      "fetch('/x')",
      "new XMLHttpRequest()",
      "new WebSocket('x')",
      "const u='https://evil.example/?d='+x",
      "window.open('x')",
      "window.parent.postMessage(1,'*')",
      "top.location.href='x'",
      "document.cookie='a=1'",
      "localStorage.setItem('a','b')",
      "import('x.js')",
      "eval('1')",
    ]
    for (const code of bad) {
      const found = lintMiniApp(draft({ files: { ...draft().files, 'app.js': code } }))
      expect(found.some((f) => f.rule === 'network' || f.rule === 'escape'), code).toBe(true)
    }
    expect(rules(lintMiniApp(draft({ files: { ...draft().files, 'index.html': GOOD_HTML.replace('app.js', 'https://cdn.example/x.js') } })))).toContain('network:index.html')
    // The SVG namespace is not an address.
    expect(lintMiniApp(draft({ files: { ...draft().files, 'index.html': GOOD_HTML.replace('</body>', '<svg xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor" d="M0 0"/></svg></body>') } }))).toEqual([])
  })

  it('refuses calls and topics outside its permissions, and tools never granted', () => {
    expect(rules(lintMiniApp(draft({ permissions: ['task_list'], files: { ...draft().files, 'app.js': GOOD_JS + ";agent.call('memory_save',{})" } })))).toContain('permission:app.js')
    expect(rules(lintMiniApp(draft({ permissions: ['task_list', 'shell_run'] })))).toContain('permission:manifest')
    expect(rules(lintMiniApp(draft({ permissions: ['task_list', 'web_fetch'] })))).toContain('permission:manifest')
    expect(rules(lintMiniApp(draft({ permissions: ['task_list', 'browser_open'] })))).toContain('permission:manifest')
    expect(rules(lintMiniApp(draft({ permissions: [], subscribe: ['data.task'], files: { 'index.html': GOOD_HTML.replace('<script src="app.js"></script>', '') .replace('<link rel="stylesheet" href="app.css">', '') } })))).toContain('permission:manifest')
    expect(rules(lintMiniApp(draft({ permissions: ['task_list', 'apps_run'] })))).toContain('permission:manifest')
    expect(rules(lintMiniApp(draft(), new Set(['task_list'])))).toContain('permission:manifest')
  })

  it('checks the icon: a name from the set, or an SVG in currentColor only', () => {
    expect(checkIcon('cal')).toBeNull()
    expect(checkIcon('rocket')).not.toBeNull()
    expect(checkIcon('<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" stroke="currentColor" fill="none"/></svg>')).toBeNull()
    expect(checkIcon('<svg viewBox="0 0 24 24"><path d="M4 4h16" stroke="#000"/></svg>')).toMatch(/currentColor/)
    expect(checkIcon('<svg><script>alert(1)</script></svg>')).not.toBeNull()
    expect(checkIcon('<svg><path d="M0 0" onclick="x()"/></svg>')).not.toBeNull()
    const parsed = parseIconSvg('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-width="2"/></svg>')
    expect(parsed.ok && parsed.nodes[0]).toEqual({ tag: 'circle', attrs: { cx: '12', cy: '12', r: '9', strokeWidth: '2' } })
  })
})

describe('mini-app calls', () => {
  const app = { permissions: ['task_list', 'task_update', 'apps_run:GOOGLECALENDAR_EVENTS_LIST', 'webapp_run:Site/read'] }
  it('reads run, changes ask, the rest are refused', () => {
    expect(checkCall(app, 'task_list', {})).toEqual({ ok: true, reads: true, key: 'task_list' })
    expect(checkCall(app, 'task_update', {})).toEqual({ ok: true, reads: false, key: 'task_update' })
    expect(checkCall(app, 'memory_save', {}).ok).toBe(false)
    expect(checkCall(app, 'shell_run', {}).ok).toBe(false)
    expect(checkCall(app, 'apps_run', { slug: 'googlecalendar_events_list' })).toEqual({ ok: true, reads: true, key: 'apps_run:GOOGLECALENDAR_EVENTS_LIST' })
    expect(checkCall(app, 'apps_run', { slug: 'GMAIL_SEND_EMAIL' }).ok).toBe(false)
    expect(checkCall(app, 'webapp_run', { app: 'Site', tool: 'read' }).ok).toBe(true)
    expect(checkCall(app, 'webapp_run', { app: 'Site', tool: 'post' }).ok).toBe(false)
  })
})

describe('mini-app store: versions, undo, pins', () => {
  it('saves only what passes, keeps versions, undoes, pins in order', async () => {
    let t = 1000
    const store = new Store(':memory:', () => t)
    const apps = new MiniAppStore({ store, now: () => t })
    const bad = await apps.create({ ...draft(), files: { ...draft().files, 'app.css': '.a{color:#fff}' } }, { by: 'agent', profile: '' })
    expect(bad.ok).toBe(false)
    expect((await store.list('miniapp')).length).toBe(0)

    const made = await apps.create(draft(), { by: 'agent', profile: 'p1' })
    if (!made.ok) throw new Error(made.why)
    expect(made.app.id).toMatch(/^ma[a-z0-9]+$/)
    expect(made.app.version).toBe(1)
    t += 1
    const edited = await apps.update(made.app.id, { patches: [{ file: 'app.css', old: 'color:var(--ok)', new: 'color:var(--primary)' }] }, { by: 'agent', reason: 'accent' })
    if (!edited.ok) throw new Error(edited.why)
    expect(edited.app.version).toBe(2)
    expect(edited.app.history.map((v) => v.n)).toEqual([1])
    const refused = await apps.update(made.app.id, { files: { 'app.css': '.a{color:red}' } }, { by: 'agent', reason: 'x' })
    expect(refused.ok).toBe(false)
    expect((await apps.find(made.app.id))?.version).toBe(2)
    const undone = await apps.undo('plan tracker', { by: 'agent' })
    if (!undone.ok) throw new Error(undone.why)
    expect(undone.app.version).toBe(3)
    expect(undone.app.files['app.css']).toContain('var(--ok)')

    const second = await apps.create({ ...draft(), name: 'Dash' }, { by: 'agent', profile: '' })
    const third = await apps.create({ ...draft(), name: 'Cal' }, { by: 'agent', profile: '' })
    if (!second.ok || !third.ok) throw new Error('not made')
    await apps.pin('Dash')
    await apps.pin('Plan tracker')
    await apps.pin('Cal', 1)
    const order = (await apps.list()).filter((a) => a.pinned > 0).sort((a, b) => a.pinned - b.pinned).map((a) => a.name)
    expect(order).toEqual(['Cal', 'Dash', 'Plan tracker'])
    await apps.unpin('Dash')
    const after = (await apps.list()).filter((a) => a.pinned > 0).sort((a, b) => a.pinned - b.pinned).map((a) => `${a.name}:${a.pinned}`)
    expect(after).toEqual(['Cal:1', 'Plan tracker:2'])
    expect(repin([{ id: 'a', pinned: 1, name: 'a' }, { id: 'b', pinned: 2, name: 'b' }], 'b', 1)).toEqual([{ id: 'a', pinned: 2 }, { id: 'b', pinned: 1 }])
  })
})

describe('mini-app kit', () => {
  it('serves the very tokens the app is drawn with, and injects the bridge first', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(__dirname, '../src/renderer/styles/tokens.css'), 'utf8').replace(/\r\n/g, '\n')
    // Run `node scripts/gen-miniapp-tokens.mjs` when tokens.css changes.
    expect(TOKENS_CSS).toBe(css)
    const html = frameHtml('<html><head><title>x</title></head><body></body></html>')
    expect(html.indexOf('/_agent/agent.js')).toBeLessThan(html.indexOf('<title>'))
    expect(serveMiniApp({ 'index.html': '<p>x</p>' }, '/index.html').body).toContain('/_agent/ui.css')
    expect(serveMiniApp({ 'index.html': '' }, '/../secret').status).toBe(404)
  })
})

async function hostFixture(engine: 'cordis' | 'plain') {
  const t = 5000
  const store = new Store(':memory:', () => t)
  const apps = new MiniAppStore({ store, now: () => t })
  const made = await apps.create(draft(), { by: 'agent', profile: '' })
  if (!made.ok) throw new Error(made.why)
  const ran: Array<{ tool: string; args: JsonObject; app: string }> = []
  const asked: string[] = []
  let answer = true
  const host = new MiniAppHost({
    apps,
    onRowsChange: (listener) => store.onChange(listener),
    runTool: async (app: MiniAppRow, tool: string, args: JsonObject) => {
      ran.push({ tool, args, app: app.id })
      return JSON.stringify([{ id: 't1', title: 'First' }])
    },
    approve: async (_app, summary) => {
      asked.push(summary)
      return answer
    },
    host: engine === 'cordis' ? cordisHost() : plainHost(),
  })
  await host.start()
  const pushed: Array<Parameters<Push>[0]> = []
  return { store, apps, app: made.app, host, ran, asked, pushed, setAnswer: (v: boolean) => (answer = v) }
}

describe.each(['cordis', 'plain'] as const)('mini-app host (%s)', (engine) => {
  it('runs granted reads, asks before changes, refuses the rest', async () => {
    const f = await hostFixture(engine)
    expect(f.host.engine.kind).toBe(engine)
    const session = f.host.openSession(f.app.id, (m) => f.pushed.push(m), 'window')
    expect(session).not.toBeNull()
    const read = await f.host.handle(session!, { op: 'call', id: 1, tool: 'task_list', args: {} })
    expect(read).toMatchObject({ ok: true, id: 1 })
    expect(f.asked).toEqual([])
    const write = await f.host.handle(session!, { op: 'call', id: 2, tool: 'task_update', args: { id: 't1', status: 'done' } })
    expect(write).toMatchObject({ ok: true })
    expect(f.asked.length).toBe(1)
    f.setAnswer(false)
    const no = await f.host.handle(session!, { op: 'call', id: 3, tool: 'task_update', args: {} })
    expect(no).toMatchObject({ ok: false, error: 'He said no.' })
    await f.apps.setAllowed(f.app.id, 'task_update', true)
    await new Promise((r) => setTimeout(r, 20))
    const allowed = await f.host.handle(session!, { op: 'call', id: 4, tool: 'task_update', args: {} })
    expect(allowed).toMatchObject({ ok: true })
    expect(f.asked.length).toBe(2)
    const refused = await f.host.handle(session!, { op: 'call', id: 5, tool: 'shell_run', args: { command: 'calc' } })
    expect(refused).toMatchObject({ ok: false })
    const outside = await f.host.handle(session!, { op: 'call', id: 6, tool: 'memory_search', args: {} })
    expect(outside).toMatchObject({ ok: false })
    expect(f.ran.map((r) => r.tool)).toEqual(['task_list', 'task_update', 'task_update'])
    await f.host.stop()
  })

  it('a check session never changes anything', async () => {
    const f = await hostFixture(engine)
    const session = f.host.openSession(f.app.id, () => undefined, 'check')!
    expect(await f.host.handle(session, { op: 'call', id: 1, tool: 'task_update', args: {} })).toMatchObject({ ok: false })
    expect(await f.host.handle(session, { op: 'store.set', id: 2, key: 'k', value: 'v' })).toMatchObject({ ok: true })
    expect(await f.host.handle(session, { op: 'store.get', id: 3, key: 'k' })).toMatchObject({ result: 'v' })
    expect((await f.apps.find(f.app.id))?.data).toEqual({})
    expect(f.asked).toEqual([])
    await f.host.stop()
  })

  it('subscriptions follow the data while open; an edit or delete takes the session away', async () => {
    const f = await hostFixture(engine)
    const session = f.host.openSession(f.app.id, (m) => f.pushed.push(m), 'window')!
    await f.host.handle(session, { op: 'subscribe', topic: 'data.task' })
    await f.host.handle(session, { op: 'subscribe', topic: 'calendar.changed' })
    expect(f.pushed.some((m) => m.op === 'event' && m.topic === 'error')).toBe(true)
    await f.store.upsert('task', { title: 'New' })
    await new Promise((r) => setTimeout(r, 400))
    expect(f.pushed.filter((m) => m.op === 'event' && m.topic === 'data.task').length).toBe(1)
    // The app's own store persists.
    expect(await f.host.handle(session, { op: 'store.set', id: 9, key: 'k', value: '1' })).toMatchObject({ ok: true })
    expect((await f.apps.find(f.app.id))?.data).toEqual({ k: '1' })

    await f.apps.update(f.app.id, { description: 'changed' }, { by: 'agent', reason: 'x' })
    await new Promise((r) => setTimeout(r, 50))
    expect(f.pushed.some((m) => m.op === 'event' && m.topic === 'app.changed')).toBe(true)
    expect(await f.host.handle(session, { op: 'call', id: 10, tool: 'task_list', args: {} })).toMatchObject({ ok: false, error: 'This app is closed.' })
    // After the reload the old subscription is gone: a task write tells nobody.
    const before = f.pushed.length
    await f.store.upsert('task', { title: 'Another' })
    await new Promise((r) => setTimeout(r, 400))
    expect(f.pushed.length).toBe(before)
    expect(f.host.loaded().find((p) => p.id === f.app.id)?.version).toBe(2)

    const again = f.host.openSession(f.app.id, (m) => f.pushed.push(m), 'window')!
    expect(again).not.toBeNull()
    await f.apps.remove(f.app.id)
    await new Promise((r) => setTimeout(r, 50))
    expect(f.pushed.some((m) => m.op === 'event' && m.topic === 'app.deleted')).toBe(true)
    expect(f.host.loaded()).toEqual([])
    expect(f.host.openSession(f.app.id, () => undefined, 'window')).toBeNull()
    await f.host.stop()
  })
})

describe('mini-apps on the sidebar and the tools', () => {
  it('pinned apps shrink, then overflow into +N; the cap holds', async () => {
    const { fitPinned } = await import('../src/renderer/lib/miniapps')
    const roomy = { room: 400, cols: 3, gap: 6, extra: 18 }
    expect(fitPinned(roomy, 4, 8)).toEqual({ small: false, show: 4, more: 0 })
    expect(fitPinned(roomy, 12, 8)).toEqual({ small: false, show: 8, more: 4 })
    const tight = { room: 60, cols: 1, gap: 6, extra: 0 }
    const fit = fitPinned(tight, 5, 8)
    expect(fit.small).toBe(true)
    expect(fit.show + fit.more).toBe(5)
    expect(fit.more).toBeGreaterThan(0)
    expect(fitPinned({ room: 0, cols: 1, gap: 6, extra: 0 }, 3, 8)).toEqual({ small: true, show: 0, more: 3 })
  })

  it('every icon name an app may use exists in the app icon set', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { MINIAPP_ICON_NAMES } = await import('../src/shared/miniapps')
    const source = readFileSync(join(__dirname, '../src/renderer/ui/Icon.tsx'), 'utf8')
    for (const name of MINIAPP_ICON_NAMES) expect(source, name).toMatch(new RegExp(`\n  ${name}: `))
  })

  it('the tools save, refuse, check, pin only after the check, and delete only with his yes', async () => {
    const { miniAppTools } = await import('../src/main/tools/miniapps')
    const { testContext } = await import('./support')
    const store = new Store(':memory:')
    const checks: string[] = []
    let good = true
    const opened: string[] = []
    const tools = miniAppTools({
      store,
      knownTools: () => new Set(['task_list', 'task_update']),
      ui: () => ({
        open: async (app) => {
          opened.push(app.id)
        },
        check: async (app) => {
          checks.push(`${app.id}:${app.version}`)
          return { version: app.version, at: 1, ok: good, issues: good ? [] : ['390 dark: the page scrolls sideways'], shots: ['C:/x/v1-1440-light.png'] }
        },
      }),
    })
    const tool = (name: string) => tools.find((t) => t.spec.name === name)!
    const ctx = testContext()
    const refused = await tool('miniapp_create').run({ ...draft(), files: { 'index.html': '<p style="color:red">x</p>' } } as unknown as JsonObject, ctx)
    expect(refused).toMatch(/Not saved/)
    good = false
    const made = await tool('miniapp_create').run({ name: 'Plan tracker', description: 'x', icon: 'tasks', files: draft().files, permissions: ['task_list', 'task_update'], subscribe: ['data.task'] } as unknown as JsonObject, ctx)
    expect(made).toMatch(/Saved "Plan tracker"/)
    expect(made).toMatch(/\[\[image:C:\/x\/v1-1440-light.png]]/)
    expect(made).toMatch(/scrolls sideways/)
    const id = (await store.list('miniapp'))[0]!.id
    expect(await tool('miniapp_pin').run({ app: id }, ctx)).toMatch(/has to pass the look check/)
    expect(opened).toEqual([])
    good = true
    const fixed = await tool('miniapp_update').run({ app: 'Plan tracker', reason: 'fix width', patches: [{ file: 'app.css', old: 'color:var(--ok)', new: 'color:var(--primary)' }] }, ctx)
    expect(fixed).toMatch(/version 2/)
    expect(await tool('miniapp_pin').run({ app: id }, ctx)).toMatch(/pinned to the sidebar at #1/)
    expect(await tool('miniapp_open').run({ app: id }, ctx)).toMatch(/Opened/)
    expect(opened).toEqual([id])
    expect(await tool('miniapp_list').run({}, ctx)).toMatch(/pinned #1, checked/)
    expect(await tool('miniapp_undo').run({ app: id }, ctx)).toMatch(/Back to what version 1 was/)
    const no = await tool('miniapp_delete').run({ app: id }, { ...ctx, approve: async () => false })
    expect(no).toMatch(/he said no/)
    expect((await store.list('miniapp')).length).toBe(1)
    expect(await tool('miniapp_delete').run({ app: id }, { ...ctx, approve: async () => true })).toMatch(/Deleted/)
    expect((await store.list('miniapp')).length).toBe(0)
  })
})

describe('mini-apps and linked devices', () => {
  it('a phone on the small feed hears only that an app changed, never its files', async () => {
    const { shapeChange } = await import('../src/shared/device-feed')
    const row = { id: 'maabcdefgh12', files: { 'index.html': 'x'.repeat(5000) } }
    const shaped = shapeChange({ entity: 'miniapp', row } as never, { v: 2, metered: true, helpers: false } as never)
    expect(shaped).toEqual({ entity: 'miniapp', id: 'maabcdefgh12' })
    expect(JSON.stringify(shaped)).not.toContain('index.html')
    expect(shapeChange({ entity: 'miniapp', id: 'maabcdefgh12', deleted: true } as never, { v: 2, metered: false, helpers: true } as never)).toEqual({ entity: 'miniapp', id: 'maabcdefgh12', deleted: true })
  })
})

describe('a row that skipped the checks', () => {
  it('never runs, whoever wrote it', async () => {
    const store = new Store(':memory:')
    const apps = new MiniAppStore({ store })
    await store.upsert('miniapp', { id: 'mabadrow0001', name: 'Sneaky', icon: 'apps', files: { 'index.html': '<script>fetch("https://x.example")</script>' }, permissions: ['shell_run'] })
    const host = new MiniAppHost({ apps, onRowsChange: (l) => store.onChange(l), runTool: async () => 'ran', approve: async () => true, host: plainHost() })
    await host.start()
    expect(host.openSession('mabadrow0001', () => undefined, 'window')).toBeNull()
    await host.stop()
  })
  it('miniapp_open opens the app on the phone he wrote from, and gives the reply a card that opens it', async () => {
    const { miniAppTools, miniAppLink } = await import('../src/main/tools/miniapps')
    const { testContext } = await import('./support')
    const store = new Store(':memory:')
    const sent: Array<{ target: string; url: string | undefined }> = []
    const opened: string[] = []
    let status: 'done' | 'failed' = 'done'
    const tools = miniAppTools({
      store,
      knownTools: () => new Set(['task_list']),
      ui: () => ({ open: async (app) => void opened.push(app.id), check: async (app) => ({ version: app.version, at: 1, ok: true, issues: [], shots: [] }) }),
      devices: {
        selfId: () => 'dev_pc',
        commands: () => ({ send: async (target: string, input: { url?: string }) => { sent.push({ target, url: input.url }); return { status, note: status === 'done' ? '' : 'no' } } }) as never,
      },
    })
    const tool = (name: string) => tools.find((t) => t.spec.name === name)!
    const ctx = testContext()
    expect(await tool('miniapp_create').run({ name: 'Week calendar', description: 'x', icon: 'tasks', files: draft().files, permissions: ['task_list'] } as unknown as JsonObject, ctx)).toMatch(/Saved/)
    const id = (await store.list('miniapp'))[0]!.id
    // He wrote from his phone.
    const phone = { deviceId: 'dev_phone', name: "Ayanda's A35", kind: 'phone', platform: 'android', screenWidth: 461, canOpenLinks: true, canReceiveFiles: true }
    await store.upsert('chat_item', { id: 'u1', kind: 'user', text: 'pull up my calendar app', meta: JSON.stringify({ origin: phone }), createdAt: Date.now() } as never)
    const out = await tool('miniapp_open').run({ app: 'Week calendar' }, ctx)
    expect(sent).toEqual([{ target: 'dev_phone', url: `agent://miniapp/${id}` }])
    expect(opened).toEqual([])
    expect(out).toMatch(/Opened "Week calendar" on the user's Ayanda's A35/)
    expect(out).toContain(miniAppLink({ id, name: 'Week calendar' }))
    expect(miniAppLink({ id, name: 'Week calendar' })).toBe(`[Open Week calendar](agent://miniapp/${id})`)
    // An older phone that cannot open it: still a card for the reply.
    status = 'failed'
    expect(await tool('miniapp_open').run({ app: id }, ctx)).toMatch(/Could not open "Week calendar".*agent:\/\/miniapp\//)
    // He wrote on this computer: the window opens it, nothing goes to a device.
    await store.upsert('chat_item', { id: 'u2', kind: 'user', text: 'and here', meta: JSON.stringify({ origin: { ...phone, deviceId: 'dev_pc', kind: 'desktop', platform: 'windows' } }), createdAt: Date.now() + 1000 } as never)
    sent.length = 0
    expect(await tool('miniapp_open').run({ app: id }, ctx)).toMatch(/^Opened "Week calendar"\.$/)
    expect(opened).toEqual([id])
    expect(sent).toEqual([])
  })
})
