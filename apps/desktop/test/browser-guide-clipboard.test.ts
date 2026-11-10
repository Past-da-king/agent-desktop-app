/**
 * Clipboard fill (26 Oct 2026): when a guided step is a field and the agent knows the value, the value goes on his
 * clipboard, the label says so, and his paste (or the field coming to hold the value) ends the step at once. A
 * sensitive value (a Vault item) is never shown, logged or saved, and is taken off the clipboard after his paste or
 * after 30 s, but only while it is still ours.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { NetEntry } from '../src/main/browser/devtools-log'
import { ClipboardFill, fillLabel, formatGuide, type ClipboardLike, type GuideHost, type GuideStep } from '../src/main/browser/guide'
import { evaluateIn, FrameSessions, type GuideLink } from '../src/main/browser/guide-host'
import { formatLog, GuideLog } from '../src/main/browser/guide-log'
import { stepOf } from '../src/main/tools/browser-guide'
import { markVaultSteps } from '../src/main/vault/guard'
import { DRAWS, guideOn } from './helpers/outside-surface'

const SECRET = 'Pa55-word-SECRET-7781'

class FakeClipboard implements ClipboardLike {
  text = ''
  writes: string[] = []
  read(): string {
    return this.text
  }
  write(text: string): void {
    this.text = text
    this.writes.push(text)
  }
  clear(): void {
    this.text = ''
  }
}

describe('ClipboardFill: what goes on his clipboard, and when it comes off', () => {
  it('a sensitive value is cleared after his paste; a plain one gives him his own clipboard back', async () => {
    const cb = new FakeClipboard()
    cb.text = 'what he had'
    const fill = new ClipboardFill(cb, 10_000)
    await fill.put('Shop pixel', false)
    expect(cb.text).toBe('Shop pixel')
    expect(await fill.settle()).toBe('restored')
    expect(cb.text).toBe('what he had')
    await fill.put(SECRET, true)
    expect(cb.text).toBe(SECRET)
    expect(await fill.settle()).toBe('cleared')
    expect(cb.text).toBe('')
  })

  it('a sensitive value comes off by itself after the time limit if he never pastes', async () => {
    const cb = new FakeClipboard()
    const fill = new ClipboardFill(cb, 60)
    await fill.put(SECRET, true)
    await new Promise((r) => setTimeout(r, 150))
    expect(cb.text).toBe('')
  })

  it('never wipes something he copied since', async () => {
    const cb = new FakeClipboard()
    const fill = new ClipboardFill(cb, 60)
    await fill.put(SECRET, true)
    cb.text = 'he copied this'
    await new Promise((r) => setTimeout(r, 150))
    expect(cb.text).toBe('he copied this')
    expect(await fill.settle()).toBe('left')
    expect(cb.text).toBe('he copied this')
  })

  it('labels say what is on the clipboard for a plain value, and only the field for a sensitive one', () => {
    expect(fillLabel({ label: 'Type the name', target: { name: 'Pixel name' }, value: 'Cosmiprint' })).toBe('Pixel name: Cosmiprint, press Ctrl+V')
    const secret = fillLabel({ label: 'Password', target: { name: 'Password' }, value: SECRET, sensitive: true }, 'Cmd+V')
    expect(secret).toBe('Password: on your clipboard, press Cmd+V')
    expect(secret).not.toContain(SECRET)
  })

  it('a {{vault:...}} value marks its step sensitive before it is filled in; the tool reads value and sensitive', () => {
    const marked = markVaultSteps({ steps: [{ name: 'Email', value: 'me@example.com' }, { name: 'Password', value: '{{vault:test-login.password}}' }] })
    expect((marked['steps'] as Array<Record<string, unknown>>).map((s) => s['sensitive'] === true)).toEqual([false, true])
    expect(stepOf({ name: 'Password', role: 'textbox', value: SECRET, sensitive: true })).toEqual({ label: 'Use Password', target: { name: 'Password', role: 'textbox' }, value: SECRET, sensitive: true })
  })

  it('the step log keeps no value and masks a sensitive one in every captured request', () => {
    const guides = new GuideLog()
    const rows: NetEntry[] = []
    const session = guides.start({
      owner: 'main',
      tabId: 't',
      url: 'https://site.example.com/',
      steps: [{ label: 'Password', target: { name: 'Password' }, value: SECRET, sensitive: true }],
      masks: [SECRET],
      network: () => rows,
    })
    expect(JSON.stringify(session.steps)).not.toContain(SECRET)
    guides.stepEnded(session.id, { n: 1, label: 'Password: on your clipboard, press Ctrl+V', outcome: 'typed', target: 'textbox "Password"', role: 'textbox', name: 'Password', frame: '', foundMs: 1, waitedMs: 1, returnMs: 1, at: 1000, url: '', secret: true, pasted: true })
    rows.push({
      id: 'r1', requestId: 'r1', url: `https://site.example.com/login?p=${encodeURIComponent(SECRET)}`, method: 'POST', type: 'Fetch', wallTime: 1010, requestHeaders: { 'Content-Type': 'application/json' }, rawRequestHeaders: true,
      postData: JSON.stringify({ user: 'me', password: SECRET }), hasPostData: true, status: 200, statusText: 'OK', mimeType: 'application/json', responseHeaders: {}, rawResponseHeaders: true, remoteAddress: '', fromCache: false,
      fromServiceWorker: false, encodedBytes: 1, finished: true, failed: '', redirectedTo: '', initiator: '', timing: { start: null, end: null, dnsMs: null, connectMs: null, sslMs: null, waitMs: null, downloadMs: null, headersAt: null }, body: { text: `{"echo":"${SECRET}"}`, base64: false },
    })
    const all = JSON.stringify(guides.requests(session.id)) + formatLog(guides.get(session.id)!, guides.requests(session.id))
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain(encodeURIComponent(SECRET))
    expect(all).toContain('[secret]')
  })
})

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

const FORM = `<!doctype html><title>Sign up</title><body>
<label>Pixel name <input id="name"></label><br>
<label>Password <input id="pw" type="password"></label><br>
<button id="go">Create</button>
<script>window.__pastes = 0; document.addEventListener('paste', () => window.__pastes++, true);</script></body>`

async function linkFor(session: CDPSession): Promise<GuideLink> {
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  return {
    send: (method, params = {}) => (method === 'Target.setAutoAttach' ? Promise.resolve({}) : session.send(method as 'Runtime.evaluate', params as never)),
    onEvent: () => () => undefined,
  }
}

;(chrome === null ? describe.skip : describe).each(DRAWS)('clipboard fill in a real Chromium: his paste is the signal (ring drawn by: %s)', (draw) => {
  let browser: Browser
  let server: Server
  let page: Page
  let url = ''

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FORM)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox'] })
  })

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  it('puts each value on the clipboard, ends each step the moment he pastes, and clears the password after', async () => {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url })
    page = await context.newPage()
    await page.goto(url)
    const cdp = await context.newCDPSession(page)
    const frames = new FrameSessions(await linkFor(cdp))
    const host: GuideHost = {
      frames: () => frames.frames(),
      evaluate: (key, code) => evaluateIn(frames, key, code),
      page: async () => ({ url: page.url(), title: await page.title(), dialogs: [], text: '' }),
      onNavigate: () => () => undefined,
      loading: () => false,
      ready: async () => undefined,
    }
    const clipboard = new FakeClipboard()
    clipboard.text = 'his own clipboard'
    const labels: string[] = []
    const steps: GuideStep[] = [
      { label: 'Type the name', target: { name: 'Pixel name', role: 'textbox' }, value: 'Cosmiprint' },
      { label: 'Password', target: { name: 'Password', role: 'textbox' }, value: SECRET, sensitive: true },
    ]
    const on = guideOn(draw)
    const run = on.run(host, steps, { timeoutMs: 15_000, clipboard, onStep: (e) => { if (e.kind === 'shown') labels.push(e.step.label) } })
    // He clicks the field and pastes what the label says is on his clipboard: a trusted paste into the field.
    const paste = async (selector: string): Promise<number> => {
      await expect.poll(() => page.evaluate(() => document.querySelector('[data-agent-guide]') !== null), { timeout: 5000 }).toBe(true)
      await page.click(selector)
      await page.evaluate((text) => navigator.clipboard.writeText(text), clipboard.text)
      const at = Date.now()
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86, commands: ['paste'] })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 })
      return at
    }
    await expect.poll(() => labels.length, { timeout: 5000 }).toBe(1)
    expect(clipboard.text).toBe('Cosmiprint')
    await paste('#name')
    await expect.poll(() => labels.length, { timeout: 5000 }).toBe(2)
    // His own clipboard came back after the plain step; the password is on it now.
    expect(clipboard.writes).toContain('his own clipboard')
    expect(clipboard.text).toBe(SECRET)
    await paste('#pw')
    const result = await run
    expect(result.steps.map((s) => s.outcome)).toEqual(['typed', 'typed'])
    expect(result.steps.every((s) => s.pasted === true)).toBe(true)
    for (const s of result.steps) expect(s.returnMs ?? 9999).toBeLessThan(1000)
    expect(await page.inputValue('#name')).toBe('Cosmiprint')
    expect(await page.inputValue('#pw')).toBe(SECRET)
    expect(result.steps[1]?.clipboard).toBe('cleared')
    expect(clipboard.text).toBe('')
    expect(labels).toEqual(['Pixel name: Cosmiprint, press Ctrl+V', 'Password: on your clipboard, press Ctrl+V'])
    const text = formatGuide(result, 'g1')
    expect(text).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(text).toContain('he pasted it and the clipboard was cleared')
    if (on.surface !== null) {
      // Drawn outside the page (this link has no binding, so the frame was asked where its target is): the label it
      // was given names the field only, both steps were told and ended, and the secret is in nothing it heard.
      expect(on.surface.begun.map((step) => step.label)).toEqual(labels)
      expect(on.surface.ended.length).toBe(2)
      expect(on.surface.reports.some((report) => report.shown)).toBe(true)
      expect(JSON.stringify([on.surface.begun, on.surface.reports])).not.toContain(SECRET)
    }
    await context.close()
  })
})
