import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { addressAllowed, coreTools, htmlToText } from '../src/main/tools/core'
import { testContext, toolNamed } from './support'

let server: Server | null = null
let store: Store | null = null

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = null
  }
  store?.close()
  store = null
})

async function localServer(): Promise<string> {
  const httpServer = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<html><head><style>body{color:red}</style></head><body><h1>Hello</h1><p>World &amp; all</p><script>secret()</script></body></html>',
      )
    } else if (url === '/text') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('plain words')
    } else if (url === '/big') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(5_000))
    } else if (url === '/redirect') {
      response.writeHead(302, { location: '/page' })
      response.end()
    } else if (url === '/loop') {
      response.writeHead(302, { location: '/loop' })
      response.end()
    } else if (url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('late')
      }, 300)
    } else if (url === '/pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' })
      response.end('%PDF-1.4')
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not here')
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  server = httpServer
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function fetchTool(options: { allowLoopback?: boolean; timeoutMs?: number } = {}) {
  store ??= new Store(':memory:')
  return toolNamed(coreTools({ store, ...options }), 'web_fetch')
}

describe('htmlToText', () => {
  it('drops scripts, styles and tags but keeps the words', () => {
    const text = htmlToText(
      '<html><style>.x{}</style><body><h1>Hello</h1><p>World &amp; all</p><script>secret()</script></body></html>',
    )
    expect(text).toBe('Hello\nWorld & all')
  })
})

describe('web_fetch', () => {
  it('reads a local page and strips the markup', async () => {
    const base = await localServer()
    const answer = await fetchTool().run({ url: `${base}/page` }, testContext())
    expect(answer).toContain('HTTP 200')
    expect(answer).toContain('Hello')
    expect(answer).toContain('World & all')
    expect(answer).not.toContain('<h1>')
    expect(answer).not.toContain('secret()')
  })

  it('returns plain text as it is', async () => {
    const base = await localServer()
    const answer = await fetchTool().run({ url: `${base}/text` }, testContext())
    expect(answer).toBe('HTTP 200\nplain words')
  })

  it('follows a redirect', async () => {
    const base = await localServer()
    const answer = await fetchTool().run({ url: `${base}/redirect` }, testContext())
    expect(answer).toContain('Hello')
  })

  it('gives up on a redirect loop', async () => {
    const base = await localServer()
    expect(await fetchTool().run({ url: `${base}/loop` }, testContext())).toBe(
      'That address redirected too many times.',
    )
  })

  it('reports an HTTP error without pretending the page was read', async () => {
    const base = await localServer()
    const answer = await fetchTool().run({ url: `${base}/missing` }, testContext())
    expect(answer).toBe('HTTP 404\nnot here')
  })

  it('caps the text it hands the model', async () => {
    const base = await localServer()
    const answer = await fetchTool().run({ url: `${base}/big`, maxChars: 300 }, testContext())
    expect(answer.length).toBeLessThan(500)
    expect(answer).toContain('...(cut, 5000 characters in all)')
  })

  it('refuses a file it cannot read as text', async () => {
    const base = await localServer()
    expect(await fetchTool().run({ url: `${base}/pdf` }, testContext())).toBe(
      'That address is a application/pdf file, not text I can read.',
    )
  })

  it('stops waiting when the page is too slow', async () => {
    const base = await localServer()
    const answer = await fetchTool({ timeoutMs: 40 }).run({ url: `${base}/slow` }, testContext())
    expect(answer).toContain('took too long')
  })

  it('blocks a private network address without trying it', async () => {
    expect(await fetchTool().run({ url: 'http://192.168.1.10/admin' }, testContext())).toBe(
      'That address is on a private network, so I will not fetch it.',
    )
    expect(await fetchTool().run({ url: 'https://10.0.0.5/' }, testContext())).toBe(
      'That address is on a private network, so I will not fetch it.',
    )
    expect(await fetchTool().run({ url: 'https://169.254.169.254/latest' }, testContext())).toBe(
      'That address is on a private network, so I will not fetch it.',
    )
  })

  it('only allows plain http to this computer', async () => {
    expect(await fetchTool().run({ url: 'http://example.com/' }, testContext())).toBe(
      'Plain http is only fetched from this computer. Use an https:// address.',
    )
  })

  it('can be told not to talk to this computer at all', async () => {
    const base = await localServer()
    expect(await fetchTool({ allowLoopback: false }).run({ url: `${base}/page` }, testContext())).toBe(
      'That address is this computer, which is not allowed here.',
    )
  })

  it('rejects nonsense addresses in plain words', async () => {
    expect(await fetchTool().run({ url: 'not a url' }, testContext())).toBe(
      'That is not a valid web address.',
    )
    expect(await fetchTool().run({ url: 'ftp://example.com/file' }, testContext())).toBe(
      'Only web addresses (https://) can be fetched.',
    )
  })

  it('knows which resolved addresses are safe', () => {
    expect(addressAllowed('127.0.0.1')).toBe(true)
    expect(addressAllowed('127.0.0.1', false)).toBe(false)
    expect(addressAllowed('10.1.2.3')).toBe(false)
    expect(addressAllowed('172.16.4.2')).toBe(false)
    expect(addressAllowed('172.32.4.2')).toBe(true)
    expect(addressAllowed('192.168.0.10')).toBe(false)
    expect(addressAllowed('169.254.169.254')).toBe(false)
    expect(addressAllowed('8.8.8.8')).toBe(true)
    expect(addressAllowed('::1')).toBe(true)
    expect(addressAllowed('fd00::1')).toBe(false)
    expect(addressAllowed('fe80::1')).toBe(false)
  })
})
