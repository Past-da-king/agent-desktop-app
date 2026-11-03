import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MEDIA_MAX_CHUNK, readChunk } from '../src/main/media/fetch'
import { ShownMedia } from '../src/main/media/shown'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-media-fetch-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A "video": 4096 bytes of a known pattern, so every byte of a range can be checked. */
function video(): { shown: ShownMedia; token: string; path: string } {
  const dir = tempDir()
  const path = join(dir, 'clip.mp4')
  writeFileSync(path, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)))
  const shown = new ShownMedia(join(dir, 'shown-media.json'))
  const result = shown.show(path)
  if (!result.ok) throw new Error(result.why)
  return { shown, token: result.file.token, path }
}

function deps(shown: ShownMedia) {
  return { get: (token: string) => shown.get(token) }
}

const ask = (token: string, offset: number, length: number, chat = 'main') => [{ chat, token, offset, length }]

describe('media.fetch: a device reads a file an agent showed, in ranges', () => {
  it('returns exactly the bytes it was asked for, and says what the file is', () => {
    const { shown, token } = video()
    const chunk = readChunk(ask(token, 1000, 100), deps(shown))
    expect(chunk.token).toBe(token)
    expect(chunk.chat).toBe('main')
    expect(chunk.name).toBe('clip.mp4')
    expect(chunk.mime).toBe('video/mp4')
    expect(chunk.kind).toBe('video')
    expect(chunk.size).toBe(4096)
    expect(chunk.offset).toBe(1000)
    expect(chunk.length).toBe(100)
    expect(chunk.more).toBe(true)
    expect(Array.from(chunk.bytes)).toEqual(Array.from({ length: 100 }, (_, i) => (1000 + i) % 256))
  })

  it('gives the rest of the file to a last range, and says there is no more after it', () => {
    const { shown, token } = video()
    const chunk = readChunk(ask(token, 4000, 4096), deps(shown))
    expect(chunk.offset).toBe(4000)
    expect(chunk.length).toBe(96)
    expect(chunk.more).toBe(false)
    expect(chunk.bytes.length).toBe(96)
  })

  it('never reads more than one chunk at a time, however much is asked for', () => {
    const dir = tempDir()
    const path = join(dir, 'long.mp4')
    writeFileSync(path, Buffer.alloc(MEDIA_MAX_CHUNK * 2 + 9, 7))
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const result = shown.show(path)
    if (!result.ok) throw new Error(result.why)
    const chunk = readChunk(ask(result.file.token, 0, 900_000_000), deps(shown))
    expect(chunk.length).toBe(MEDIA_MAX_CHUNK)
    expect(chunk.more).toBe(true)
    expect(chunk.size).toBe(MEDIA_MAX_CHUNK * 2 + 9)
  })

  it('refuses a token that was never shown', () => {
    const { shown } = video()
    expect(() => readChunk(ask('0'.repeat(32), 0, 1024), deps(shown))).toThrow(/not a file an agent has shown/i)
  })

  it('refuses a file that has gone since it was shown', () => {
    const { shown, token, path } = video()
    unlinkSync(path)
    expect(() => readChunk(ask(token, 0, 1024), deps(shown))).toThrow(/not a file an agent has shown/i)
  })

  it('refuses a range that is not in the file', () => {
    const { shown, token } = video()
    expect(() => readChunk(ask(token, 4096, 100), deps(shown))).toThrow(/not in the file/i)
    expect(() => readChunk(ask(token, -1, 100), deps(shown))).toThrow(/not in the file/i)
  })

  it('refuses an ask it cannot read: no token, no chat, a length that is not a number', () => {
    const { shown, token } = video()
    expect(() => readChunk([], deps(shown))).toThrow(/needs the chat/i)
    expect(() => readChunk([{ chat: 'main', offset: 0, length: 10 }], deps(shown))).toThrow(/needs a token/i)
    expect(() => readChunk([{ chat: 'main', token, offset: 0, length: 'many' }], deps(shown))).toThrow(/number for length/i)
    expect(() => readChunk(['nonsense'], deps(shown))).toThrow(/needs the chat/i)
  })
})
