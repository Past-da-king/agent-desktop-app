/**
 * browser_upload in a real Chromium (26 Oct 2026). The browser's page scripts run in an isolated world here, as they
 * do in the app, so a file faked inside that world would never reach the page. Each sample page POSTs the file it got
 * to the local server, and every check reads the server: a file counts only when its bytes arrived.
 *
 * Patterns: (a) a plain field, (b) a hidden field behind a label and behind a button, (c) a field made on click and
 * clicked by script, (d) showPicker(), (e) a React component, (f) a drop zone only, (g) a field in shadow DOM, (h) a
 * page where nothing happens, which must be an error.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { outlineScript, parseOutline } from '../src/main/browser/outline'
import { formatUpload, uploadFiles, type UploadHost, type UploadTarget } from '../src/main/browser/upload'
// @ts-expect-error a plain script shared with the built-app proof
import { startUploadSite } from './fixtures/upload-site.mjs'

function findChrome(): string | null {
  const env = process.env.CHROME_PATH
  if (env !== undefined && env !== '' && existsSync(env)) return env
  const base = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
    const path = join(base, dir, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}

const chrome = findChrome()
const suite = chrome === null ? describe.skip : describe

interface Received {
  page: string
  name: string
  how: string
  size: number
}

let browser: Browser
let server: Server
let received: Received[]
let base = ''
const dir = mkdtempSync(join(tmpdir(), 'agent-upload-'))
const resume = join(dir, 'resume.txt')
const photo = join(dir, 'photo.png')
writeFileSync(resume, 'Ayanda test resume, plain text.\n'.repeat(40))
writeFileSync(photo, Buffer.alloc(3210, 7))

interface Harness {
  page: Page
  cdp: CDPSession
  host: UploadHost
  requests: Array<{ method: string; url: string; type: string; status: number | null; at: number }>
  outline(): Promise<ReturnType<typeof parseOutline>>
}

/** The app's way into a tab, over a real debugger session: page scripts in an isolated world, trusted mouse clicks. */
async function open(name: string): Promise<Harness> {
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  const requests: Harness['requests'] = []
  cdp.on('Network.requestWillBeSent', (event) => {
    requests.push({ method: event.request.method, url: event.request.url, type: String(event.type ?? ''), status: null, at: Date.now() })
  })
  await page.goto(`${base}/${name}`)
  await page.waitForLoadState('networkidle')
  const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
  const world = (await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'agent-page-test' })) as { executionContextId: number }
  const runPage = async (code: string): Promise<unknown> => {
    const result = (await cdp.send('Runtime.evaluate', { expression: code, contextId: world.executionContextId, awaitPromise: true, returnByValue: true })) as {
      result: { value?: unknown }
      exceptionDetails?: unknown
    }
    if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  cdp.on('Page.fileChooserOpened', (params) => {
    for (const listener of listeners) listener('Page.fileChooserOpened', params as unknown as Record<string, unknown>)
  })
  const host: UploadHost = {
    link: {
      send: (method, params) => cdp.send(method as never, params as never) as Promise<unknown>,
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    runPage,
    click: async (at) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 })
      return true
    },
    requestsSince: (since) => requests.filter((entry) => entry.at >= since),
  }
  return { page, cdp, host, requests, outline: async () => parseOutline(await runPage(outlineScript())) }
}

async function arrived(page: string, timeoutMs = 4000): Promise<Received[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = received.filter((entry) => entry.page === page)
    if (got.length > 0 || Date.now() > deadline) return got
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function upload(name: string, target: UploadTarget | ((h: Harness) => Promise<UploadTarget>), paths: string[] = [resume]) {
  const h = await open(name)
  try {
    const resolved = typeof target === 'function' ? await target(h) : target
    // Numbers come from an outline, as the model gets them.
    if (resolved.index === undefined) await h.outline()
    const outcome = await uploadFiles(h.host, resolved, paths, { chooserMs: 1500, networkMs: 1500 })
    const shown = await h.page.textContent('#out').catch(() => '')
    return { outcome, text: formatUpload(outcome), shown, h }
  } finally {
    await h.page.close()
  }
}

suite('browser_upload reaches the page and proves it', () => {
  beforeAll(async () => {
    const site = (await startUploadSite(0)) as { server: Server; port: number; received: Received[] }
    server = site.server
    received = site.received
    base = `http://127.0.0.1:${site.port}`
    browser = await chromium.launch({ executablePath: chrome ?? undefined, headless: true })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  it('(a) a plain field by its number: the page gets the bytes', async () => {
    const r = await upload('plain', async (h) => {
      const outline = await h.outline()
      return { index: outline.elements.find((e) => e.kind === 'input[file]')?.index ?? -1 }
    })
    expect(r.outcome).toMatchObject({ ok: true, route: 'input', changeFired: true })
    const got = await arrived('plain')
    expect(got).toEqual([expect.objectContaining({ name: 'resume.txt', size: 1280, how: 'change' })])
    expect(r.text).toMatch(/Uploaded resume\.txt \(1 KB\) by the input route/)
    expect(r.text).toMatch(/POST 127\.0\.0\.1:\d+\/upload/)
  })

  it('(b) a hidden field behind a styled label, named as the model sees it', async () => {
    const r = await upload('label', { name: 'Upload resume' })
    expect(r.outcome).toMatchObject({ ok: true, route: 'input', how: 'the field its label points at' })
    expect(await arrived('label')).toEqual([expect.objectContaining({ name: 'resume.txt', size: 1280 })])
  })

  it('(b) a hidden field next to a button, two files at once where it allows several', async () => {
    const r = await upload('button', { name: 'Choose photo', role: 'button' }, [resume, photo])
    expect(r.outcome).toMatchObject({ ok: true, route: 'input', how: 'the field next to it' })
    if (r.outcome.ok) expect(r.outcome.files).toEqual([{ name: 'resume.txt', size: 1280 }, { name: 'photo.png', size: 3210 }])
    const got = await arrived('button')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(received.filter((e) => e.page === 'button').map((e) => `${e.name}:${e.size}`).sort()).toEqual(['photo.png:3210', 'resume.txt:1280'])
    expect(got.length).toBeGreaterThan(0)
  })

  it('(c) a field made on click and clicked by script: the chooser is answered', async () => {
    const r = await upload('oncreate', { name: 'Add attachment' })
    expect(r.outcome).toMatchObject({ ok: true, route: 'chooser', changeFired: true })
    expect(await arrived('oncreate')).toEqual([expect.objectContaining({ name: 'resume.txt', size: 1280 })])
  })

  it('(d) showPicker() from a button: the chooser is answered', async () => {
    const r = await upload('picker', { name: 'Browse files' })
    expect(r.outcome).toMatchObject({ ok: true, route: 'chooser' })
    expect(await arrived('picker')).toEqual([expect.objectContaining({ name: 'resume.txt', size: 1280 })])
  })

  it('(e) a React component that only learns of the file through onChange', async () => {
    const r = await upload('react', { name: 'Upload profile photo' }, [photo])
    expect(r.outcome).toMatchObject({ ok: true, route: 'input', changeFired: true })
    expect(await arrived('react')).toEqual([expect.objectContaining({ name: 'photo.png', size: 3210, how: 'react' })])
    expect(r.shown).toContain('Got photo.png (3210 bytes) by react')
  })

  it('(f) a drop zone with no field: the file is dropped onto it', async () => {
    const r = await upload('drop', { name: 'Drop your file here' })
    expect(r.outcome).toMatchObject({ ok: true, route: 'drop' })
    expect(await arrived('drop')).toEqual([expect.objectContaining({ name: 'resume.txt', size: 1280, how: 'drop' })])
  })

  it('(g) a field in an open shadow root, behind a button there', async () => {
    const r = await upload('shadow', { name: 'Attach file' })
    expect(r.outcome).toMatchObject({ ok: true, route: 'input', how: 'the field next to it' })
    expect(await arrived('shadow')).toEqual([expect.objectContaining({ name: 'resume.txt', size: 1280 })])
  })

  it('(h) a page where nothing happens is an error, never a success', async () => {
    const r = await upload('nothing', { name: 'Upload document' })
    expect(r.outcome.ok).toBe(false)
    expect(r.text).toMatch(/^ERROR: No file field was found for button "Upload document", clicking it opened no file chooser, and it did not take a dropped file/)
    expect(await arrived('nothing', 800)).toEqual([])
  })

  it('a path that does not exist is a clear error and the page is not touched', async () => {
    const r = await upload('plain', { name: 'Your file' }, [join(dir, 'missing.pdf')])
    expect(r.text).toBe(`ERROR: There is no file at ${join(dir, 'missing.pdf')}. Nothing was uploaded.`)
  })

  it('two files into a field that takes one is an error, not half an upload', async () => {
    const before = received.filter((e) => e.page === 'label').length
    const r = await upload('label', { name: 'Upload resume' }, [resume, photo])
    expect(r.text).toMatch(/^ERROR: The file field for .* takes one file; 2 were given/)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(received.filter((e) => e.page === 'label').length).toBe(before)
  })

  it('the chooser is not left intercepted: the next chooser the page opens is not answered by the tool', async () => {
    const h = await open('oncreate')
    try {
      await h.outline()
      const outcome = await uploadFiles(h.host, { name: 'Add attachment' }, [resume], { chooserMs: 1500, networkMs: 0 })
      expect(outcome.ok).toBe(true)
      // With interception off a chooser is not reported to the debugger any more.
      let seen = 0
      h.cdp.on('Page.fileChooserOpened', () => seen++)
      await h.host.click({ x: 60, y: 90 })
      await h.page.click('#add')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(seen).toBe(0)
    } finally {
      await h.page.close()
    }
  })
})
