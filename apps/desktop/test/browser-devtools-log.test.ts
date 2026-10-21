import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LearnedStore } from '../src/main/apps/store'
import { Store } from '../src/main/db'
import { buildWorkerToolset } from '../src/main/runtime/toolset'

import {
  ConsoleLog,
  EAGER_BODY_BUDGET,
  NetworkLog,
  Ring,
  bodyText,
  cap,
  consoleArgsText,
  filterConsole,
  filterNetwork,
  formatConsole,
  formatNetworkEntry,
  formatNetworkList,
  remoteText,
  statusMatcher,
} from '../src/main/browser/devtools-log'
import { testContext } from './support'

function request(log: NetworkLog, id: string, url: string, options: { method?: string; type?: string; t?: number; postData?: string } = {}): void {
  log.handle('Network.requestWillBeSent', {
    requestId: id,
    request: { url, method: options.method ?? 'GET', headers: { Accept: '*/*' }, ...(options.postData === undefined ? {} : { postData: options.postData, hasPostData: true }) },
    type: options.type ?? 'Fetch',
    timestamp: options.t ?? 100,
    wallTime: 1_760_000_000,
    initiator: { type: 'script' },
  })
}

function respond(log: NetworkLog, id: string, status: number, mimeType = 'application/json', t = 100.25): void {
  log.handle('Network.responseReceived', {
    requestId: id,
    response: { status, statusText: status === 200 ? 'OK' : 'Nope', mimeType, headers: { 'content-type': mimeType }, timing: { requestTime: 100, sendEnd: 5, receiveHeadersEnd: 200 } },
  })
  log.handle('Network.loadingFinished', { requestId: id, timestamp: t, encodedDataLength: 1234 })
}

describe('Ring', () => {
  it('keeps the newest items up to its capacity and hands back what it drops', () => {
    const ring = new Ring<number>(3)
    expect(ring.push(1)).toBeUndefined()
    ring.push(2)
    ring.push(3)
    expect(ring.push(4)).toBe(1)
    expect(ring.all()).toEqual([2, 3, 4])
    expect(ring.size).toBe(3)
    expect(ring.last()).toBe(4)
    ring.clear()
    expect(ring.size).toBe(0)
  })
})

describe('NetworkLog', () => {
  it('builds one entry per request with status, timing and size, and gives short ids', () => {
    const log = new NetworkLog()
    request(log, 'A', 'https://example.test/api/items?q=1')
    respond(log, 'A', 200)
    const [entry] = log.all()
    expect(entry?.id).toBe('r1')
    expect(entry?.status).toBe(200)
    expect(entry?.finished).toBe(true)
    expect(entry?.encodedBytes).toBe(1234)
    expect(entry?.timing.waitMs).toBe(195)
    expect(entry?.timing.downloadMs).toBe(50)
    expect(log.get('r1')).toBe(entry)
    expect(log.get('A')).toBe(entry)
  })

  it('splits a redirect into two hops and applies extra-info headers that arrive first', () => {
    const log = new NetworkLog()
    log.handle('Network.requestWillBeSentExtraInfo', { requestId: 'B', headers: { Cookie: 'sid=1', Accept: '*/*' } })
    request(log, 'B', 'https://example.test/old', { type: 'Document' })
    log.handle('Network.requestWillBeSent', {
      requestId: 'B',
      request: { url: 'https://example.test/new', method: 'GET', headers: {} },
      redirectResponse: { status: 302, statusText: 'Found', headers: { location: '/new' }, mimeType: '' },
      type: 'Document',
      timestamp: 100.1,
    })
    respond(log, 'B', 200, 'text/html')
    const [hop, final] = log.all()
    expect(hop?.status).toBe(302)
    expect(hop?.redirectedTo).toBe('https://example.test/new')
    expect(hop?.requestHeaders['Cookie']).toBe('sid=1')
    expect(hop?.rawRequestHeaders).toBe(true)
    expect(final?.url).toBe('https://example.test/new')
    expect(final?.status).toBe(200)
  })

  it('records failures with their reason', () => {
    const log = new NetworkLog()
    request(log, 'C', 'https://other.test/x')
    log.handle('Network.loadingFailed', { requestId: 'C', timestamp: 101, errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } })
    expect(log.all()[0]?.failed).toBe('net::ERR_FAILED (CORS: MissingAllowOriginHeader)')
  })

  it('drops the oldest request past its capacity', () => {
    const log = new NetworkLog(3)
    for (let i = 1; i <= 5; i++) request(log, `id${i}`, `https://example.test/${i}`)
    expect(log.all().map((e) => e.id)).toEqual(['r3', 'r4', 'r5'])
    expect(log.get('r1')).toBeNull()
    // A late event for a dropped request is ignored.
    expect(log.handle('Network.loadingFinished', { requestId: 'id1', timestamp: 1 })).toBeNull()
  })

  it('keeps bodies within a budget, dropping the oldest kept body first', () => {
    const log = new NetworkLog(10)
    const big = 'x'.repeat(60_000)
    const count = Math.ceil(EAGER_BODY_BUDGET / big.length) + 2
    const small = new NetworkLog(count + 1)
    for (let i = 0; i < count; i++) {
      request(small, `b${i}`, `https://example.test/${i}`)
      const entry = small.all()[i]!
      small.keepBody(entry, big, false)
    }
    expect(small.keptBodyChars).toBeLessThanOrEqual(EAGER_BODY_BUDGET)
    expect(small.all()[0]?.body).toBeNull()
    expect(small.all()[count - 1]?.body?.text.length).toBe(60_000)
    // A body longer than the keeping size is cut.
    request(log, 'z', 'https://example.test/z')
    log.keepBody(log.all()[0]!, 'y'.repeat(100_000), false)
    expect(log.all()[0]?.body?.text.length).toBe(64_000)
  })

  it('filters by url, method, type, status and api calls', () => {
    const log = new NetworkLog()
    request(log, '1', 'https://example.test/api/items', { type: 'Fetch' })
    respond(log, '1', 200)
    request(log, '2', 'https://example.test/api/login', { method: 'POST', type: 'XHR', postData: '{"u":"a"}' })
    respond(log, '2', 401)
    request(log, '3', 'https://example.test/app.js', { type: 'Script' })
    respond(log, '3', 200, 'text/javascript')
    request(log, '4', 'https://example.test/broken', { type: 'Fetch' })
    log.handle('Network.loadingFailed', { requestId: '4', timestamp: 101, errorText: 'net::ERR_CONNECTION_REFUSED' })
    const all = log.all()
    expect(filterNetwork(all, { api: true }).map((e) => e.id)).toEqual(['r1', 'r2', 'r4'])
    expect(filterNetwork(all, { url: 'API/' }).length).toBe(2)
    expect(filterNetwork(all, { method: 'post' }).map((e) => e.id)).toEqual(['r2'])
    expect(filterNetwork(all, { type: 'script' }).map((e) => e.id)).toEqual(['r3'])
    expect(filterNetwork(all, { status: '4xx' }).map((e) => e.id)).toEqual(['r2'])
    expect(filterNetwork(all, { status: 'error' }).map((e) => e.id)).toEqual(['r2', 'r4'])
    expect(filterNetwork(all, { status: 'failed' }).map((e) => e.id)).toEqual(['r4'])
    expect(filterNetwork(all, { status: '200' }).map((e) => e.id)).toEqual(['r1', 'r3'])
    expect(statusMatcher('teapot')).toBeNull()
  })

  it('lists the newest within the limit and says how to see one', () => {
    const log = new NetworkLog()
    for (let i = 1; i <= 30; i++) {
      request(log, `${i}`, `https://example.test/api/${i}`)
      respond(log, `${i}`, 200)
    }
    const out = formatNetworkList(log.all(), { limit: 5, total: 30 })
    expect(out).toContain('30 match (of 30 recorded); the newest 5')
    expect(out).toContain('r30 GET 200 fetch application/json 1.2 KB 250 ms https://example.test/api/30')
    expect(out).not.toContain('r25 ')
    expect(out).toContain('browser_network_get')
    expect(formatNetworkList([], { limit: 5, total: 0 })).toContain('No requests recorded')
    expect(formatNetworkList([], { limit: 5, total: 3 })).toContain('None of the 3')
    // A very long address is cut.
    request(log, 'long', `https://example.test/${'a'.repeat(1000)}`)
    expect(formatNetworkList(log.all(), { limit: 1, total: 31 }).length).toBeLessThan(500)
  })

  it('shows one request in full with its bodies capped', () => {
    const log = new NetworkLog()
    request(log, '1', 'https://example.test/api/login', { method: 'POST', type: 'XHR', postData: '{"user":"ann"}' })
    respond(log, '1', 200)
    const entry = log.all()[0]!
    const out = formatNetworkEntry(entry, {
      requestBody: entry.postData,
      responseBody: bodyText('{"ok":true,"items":[1,2,3]}', false, 'application/json', 10),
      bodyNote: '',
      maxBody: 20,
    })
    expect(out).toContain('r1 POST https://example.test/api/login')
    expect(out).toContain('Status: 200 OK')
    expect(out).toContain('Request body (14 characters):\n{"user":"ann"}')
    expect(out).toContain('  content-type: application/json')
    expect(out).toContain('Response body (text, 27 characters):\n{"ok":true\n[cut: 17 more characters]')
  })
})

describe('bodyText', () => {
  it('decodes base64 text and names binary with its size', () => {
    const json = Buffer.from('{"a":1}').toString('base64')
    expect(bodyText(json, true, 'application/json', 100)).toEqual({ text: '{"a":1}', kind: 'text', length: 7 })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]).toString('base64')
    const out = bodyText(png, true, 'image/png', 100)
    expect(out.kind).toBe('binary')
    expect(out.text).toContain('[binary image/png, 8 B')
    expect(cap('abcdef', 3)).toBe('abc\n[cut: 3 more characters]')
  })
})

describe('ConsoleLog', () => {
  it('formats console arguments the way DevTools prints them', () => {
    expect(
      consoleArgsText([
        { type: 'string', value: '%cHello %s, you are %d' },
        { type: 'string', value: 'color: red' },
        { type: 'string', value: 'Ann' },
        { type: 'number', value: 41.7 },
        { type: 'object', className: 'Object', description: 'Object', preview: { type: 'object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'b', type: 'string', value: 'x' }] } },
      ]),
    ).toBe('Hello Ann, you are 41 {a: 1, b: "x"}')
    expect(remoteText({ type: 'object', subtype: 'array', description: 'Array(2)', preview: { type: 'object', subtype: 'array', properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'number', value: '2' }] } })).toBe('Array(2) [1, 2]')
    expect(remoteText({ type: 'undefined' })).toBe('undefined')
    expect(remoteText({ type: 'object', subtype: 'null', value: null })).toBe('null')
    expect(remoteText({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN')
  })

  it('records messages, uncaught exceptions and browser entries, counting repeats', () => {
    const log = new ConsoleLog()
    const at = { callFrames: [{ functionName: 'go', url: 'https://example.test/app.js', lineNumber: 9, columnNumber: 4 }] }
    log.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'ready' }], timestamp: 1_760_000_000_000, stackTrace: at })
    log.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'ready' }], timestamp: 1_760_000_000_100, stackTrace: at })
    log.handle('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }], timestamp: 1_760_000_000_200 })
    log.handle('Runtime.exceptionThrown', {
      timestamp: 1_760_000_000_300,
      exceptionDetails: {
        text: 'Uncaught',
        url: 'https://example.test/app.js',
        lineNumber: 19,
        columnNumber: 2,
        exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at explode (https://example.test/app.js:20:3)' },
      },
    })
    log.handle('Runtime.exceptionThrown', {
      timestamp: 1_760_000_000_400,
      exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'string', value: 'nope' }, stackTrace: at },
    })
    log.handle('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', url: 'https://example.test/missing', timestamp: 1_760_000_000_500 } })
    const all = log.all()
    expect(all.length).toBe(5)
    expect(all[0]?.count).toBe(2)
    expect(all[2]?.text).toBe('Uncaught Error: boom\n    at explode (https://example.test/app.js:20:3)')
    expect(all[2]?.stack).toBe('')
    expect(all[3]?.text).toBe('Uncaught (in promise) nope')
    expect(all[3]?.stack).toContain('at go (https://example.test/app.js:10:5)')
    expect(all[4]?.text).toBe('[network] Failed to load resource: 404')

    const errors = filterConsole(all, { level: 'error' })!
    expect(errors.map((e) => e.source)).toEqual(['exception', 'exception', 'browser'])
    expect(filterConsole(all, { level: 'warning' })!.length).toBe(4)
    expect(filterConsole(all, { text: 'BOOM' })!.length).toBe(1)
    expect(filterConsole(all, { level: 'loud' })).toBeNull()
    const out = formatConsole(all, { limit: 50, total: all.length })
    expect(out).toContain('[log] ')
    expect(out).toContain('(x2) ready')
    expect(out).toContain('[uncaught] ')
    // The error's own stack names the place once; no second 'at' line for it.
    expect(out.split('app.js:20:3').length).toBe(2)
    expect(out).toContain('    at https://example.test/missing')
  })

  it('caps long messages, the ring, and the whole listing', () => {
    const log = new ConsoleLog(10)
    for (let i = 0; i < 25; i++) log.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `${i} ${'z'.repeat(5_000)}` }], timestamp: 1 })
    const all = log.all()
    expect(all.length).toBe(10)
    expect(all[0]?.text.startsWith('15 ')).toBe(true)
    expect(all[0]!.text.length).toBeLessThan(1_600)
    expect(formatConsole(all, { limit: 200, total: 10, maxChars: 4_000 }).length).toBeLessThan(4_100)
  })
})

describe('the toolset', () => {
  it('offers the developer tools once each, with the recording browser_network in place of the in-page watcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-devtools-'))
    try {
      const names = buildWorkerToolset({ store: new Store(':memory:'), learned: new LearnedStore(join(dir, 'learned.json')) }).map((t) => t.spec.name)
      for (const name of ['browser_network', 'browser_network_get', 'browser_fetch', 'browser_console', 'browser_inspect', 'browser_storage', 'browser_eval']) {
        expect(names.filter((n) => n === name)).toEqual([name])
      }
      expect(new Set(names).size).toBe(names.length)
      const network = buildWorkerToolset({ store: new Store(':memory:'), learned: new LearnedStore(join(dir, 'learned.json')) }).find((t) => t.spec.name === 'browser_network')!
      expect(network.spec.description).toContain('always recording')
      expect(await network.run({}, testContext())).toContain('No page is open')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
