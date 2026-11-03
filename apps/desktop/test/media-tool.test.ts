import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { ShownMedia } from '../src/main/media/shown'
import { mediaTools } from '../src/main/tools/media'
import { testContext, toolNamed } from './support'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-media-tool-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const dir = tempDir()
  const store = new Store(':memory:')
  const shown = new ShownMedia(join(dir, 'shown-media.json'))
  const tools = mediaTools({ store, show: (path) => shown.show(path) })
  return { dir, store, shown, tools }
}

describe('show_media', () => {
  it('puts a card in the chat that a player can be drawn from, and says one line about it', async () => {
    const { dir, store, tools } = await setup()
    const path = join(dir, 'clip.mp4')
    writeFileSync(path, Buffer.from('not really a video, but a file'))
    const answer = await toolNamed(tools, 'show_media').run({ path, caption: 'The render' }, testContext({ chat: 'c1' }))
    expect(answer).toContain('The card is in the chat')
    expect(answer).toContain('agent-media://f/')
    expect(answer).toContain('never paste the path')
    const rows = await store.list('chat_item')
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row?.kind).toBe('media')
    expect(row?.text).toBe('The render')
    const meta = JSON.parse(row?.meta ?? '{}') as Record<string, unknown>
    expect(meta['kind']).toBe('video')
    expect(meta['mime']).toBe('video/mp4')
    expect(meta['name']).toBe('clip.mp4')
    expect(meta['caption']).toBe('The render')
    expect(String(meta['src'])).toMatch(/^agent-media:\/\/f\/[a-f0-9]{32}$/)
    expect(typeof meta['size']).toBe('number')
  })

  it('says why when the file is not there, and posts nothing', async () => {
    const { dir, store, tools } = await setup()
    const answer = await toolNamed(tools, 'show_media').run({ path: join(dir, 'gone.mp4') }, testContext({ chat: 'c1' }))
    expect(answer).toContain('There is no file at')
    expect(await store.list('chat_item')).toHaveLength(0)
  })

  it('needs a full path, and never puts the path in the address', async () => {
    const { tools } = await setup()
    const answer = await toolNamed(tools, 'show_media').run({ path: 'clip.mp4' }, testContext({ chat: 'c1' }))
    expect(answer).toContain('full path')
  })

  it('shows a picture with the kind the window draws it as', async () => {
    const { dir, store, tools } = await setup()
    const path = join(dir, 'shot.png')
    writeFileSync(path, Buffer.from('png'))
    await toolNamed(tools, 'show_media').run({ path }, testContext({ chat: 'c1' }))
    const row = (await store.list('chat_item'))[0]
    expect(row?.text).toBe('shot.png')
    const meta = JSON.parse(row?.meta ?? '{}') as Record<string, unknown>
    expect(meta['kind']).toBe('image')
    expect(meta['caption']).toBe('')
  })

  it('tells the agent the card is no use to someone on their phone, and points at send_file', async () => {
    const dir = tempDir()
    const store = new Store(':memory:')
    const shown = new ShownMedia(join(dir, 'shown-media.json'))
    const tools = mediaTools({
      store,
      show: (path) => shown.show(path),
      selfId: () => 'dev_pc',
      origin: async () => ({ deviceId: 'dev_phone', name: 'Pixel' }),
    })
    const path = join(dir, 'clip.mp4')
    writeFileSync(path, Buffer.from('x'))
    const answer = await toolNamed(tools, 'show_media').run({ path }, testContext({ chat: 'c1' }))
    expect(answer).toContain('on their Pixel now')
    expect(answer).toContain('send_file')
    expect(await store.list('chat_item')).toHaveLength(1)
  })
})
