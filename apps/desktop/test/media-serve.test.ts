import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseRange, serveShown } from '../src/main/media/serve'
import { ShownMedia, shownUrl, tokenOf } from '../src/main/media/shown'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-media-serve-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A "video": 4096 bytes of a known pattern, so a range can be checked byte for byte. */
function video(): { shown: ShownMedia; url: string; path: string } {
  const dir = tempDir()
  const path = join(dir, 'clip.mp4')
  writeFileSync(path, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)))
  const shown = new ShownMedia(join(dir, 'shown-media.json'))
  const result = shown.show(path)
  if (!result.ok) throw new Error(result.why)
  return { shown, url: shownUrl(result.file.token), path }
}

describe('streaming a shown file to the window', () => {
  it('answers the whole file with its type, its length and Range support', async () => {
    const { shown, url, path } = video()
    const answer = await serveShown(new Request(url), (token) => shown.get(token))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('video/mp4')
    expect(answer.headers.get('accept-ranges')).toBe('bytes')
    expect(answer.headers.get('content-length')).toBe(String(statSync(path).size))
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = new Uint8Array(await answer.arrayBuffer())
    expect(bytes.length).toBe(4096)
    expect(bytes[300]).toBe(300 % 256)
  })

  it('answers a Range with 206 and exactly those bytes, so a video can be dragged to any point', async () => {
    const { shown, url } = video()
    const answer = await serveShown(new Request(url, { headers: { range: 'bytes=1000-1099' } }), (token) => shown.get(token))
    expect(answer.status).toBe(206)
    expect(answer.headers.get('content-range')).toBe('bytes 1000-1099/4096')
    expect(answer.headers.get('content-length')).toBe('100')
    const bytes = new Uint8Array(await answer.arrayBuffer())
    expect(bytes.length).toBe(100)
    expect(bytes[0]).toBe(1000 % 256)
    expect(bytes[99]).toBe(1099 % 256)
  })

  it('reads "from here to the end" and "the last n bytes" the way a player asks for them', async () => {
    const { shown, url } = video()
    const tail = await serveShown(new Request(url, { headers: { range: 'bytes=4000-' } }), (token) => shown.get(token))
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe('bytes 4000-4095/4096')
    const last = await serveShown(new Request(url, { headers: { range: 'bytes=-96' } }), (token) => shown.get(token))
    expect(last.status).toBe(206)
    expect(last.headers.get('content-range')).toBe('bytes 4000-4095/4096')
  })

  it('refuses a Range it cannot serve with 416, and says how long the file is', async () => {
    const { shown, url } = video()
    const answer = await serveShown(new Request(url, { headers: { range: 'bytes=9000-9100' } }), (token) => shown.get(token))
    expect(answer.status).toBe(416)
    expect(answer.headers.get('content-range')).toBe('bytes */4096')
  })

  it('answers a HEAD with the headers and no body', async () => {
    const { shown, url } = video()
    const answer = await serveShown(new Request(url, { method: 'HEAD' }), (token) => shown.get(token))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('video/mp4')
    expect(answer.body).toBeNull()
  })

  it('answers 404 for a token no agent was given, and for a path dressed up as one', async () => {
    const { shown, url } = video()
    const lookup = (token: string): ReturnType<ShownMedia['get']> => shown.get(token)
    expect((await serveShown(new Request('agent-media://f/' + '0'.repeat(32)), lookup)).status).toBe(404)
    expect((await serveShown(new Request('agent-media://f/../../etc/passwd'), lookup)).status).toBe(404)
    expect((await serveShown(new Request('agent-media://f/%2e%2e%2f%2e%2e%2fetc%2fpasswd'), lookup)).status).toBe(404)
    expect((await serveShown(new Request('agent-media://other/' + tokenOf(url)), lookup)).status).toBe(404)
    expect((await serveShown(new Request('https://example.com/' + tokenOf(url)), lookup)).status).toBe(404)
  })

  it('refuses anything that is not a read: nothing on this disk can be written through it', async () => {
    const { shown, url } = video()
    const answer = await serveShown(new Request(url, { method: 'POST', body: 'x' }), (token) => shown.get(token))
    expect(answer.status).toBe(405)
    expect(answer.headers.get('allow')).toBe('GET, HEAD')
  })

  it('stops serving a file that has gone, even with its old token', async () => {
    const { shown, url, path } = video()
    rmSync(path)
    const answer = await serveShown(new Request(url), (token) => shown.get(token))
    expect(answer.status).toBe(404)
  })

  it('parses the Range header forms, and calls the rest bad', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'none' })
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'ok', start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'ok', start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'ok', start: 90, end: 99 })
    expect(parseRange('bytes=95-999', 100)).toEqual({ kind: 'ok', start: 95, end: 99 })
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'bad' })
    expect(parseRange('bytes=50-10', 100)).toEqual({ kind: 'bad' })
    expect(parseRange('items=0-9', 100)).toEqual({ kind: 'bad' })
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'bad' })
    expect(parseRange('bytes=0-9', 0)).toEqual({ kind: 'bad' })
  })
})
