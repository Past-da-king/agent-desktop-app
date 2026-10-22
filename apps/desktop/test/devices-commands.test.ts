import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { DeviceCommands } from '../src/main/devices/commands'
import { latestOrigin, originLine } from '../src/main/devices/origin'
import type { MessageOrigin } from '../src/main/devices/types'
import { deviceTools } from '../src/main/tools/devices'
import { startTestHost, type TestHost } from './devices-host'
import { testContext, toolNamed } from './support'
import { waitFor } from '../../../packages/core/test/helpers'

const PHONE: MessageOrigin = {
  deviceId: 'dev_phone',
  name: 'Test Phone',
  kind: 'phone',
  platform: 'android',
  screenWidth: 412,
  canOpenLinks: true,
  canReceiveFiles: true,
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup(options: { connected?: boolean; now?: () => number } = {}) {
  const store = new Store(':memory:')
  const host: TestHost = await startTestHost('dev_pc')
  if (options.connected !== false) host.connected.add('dev_phone')
  const notes: Array<{ chat: string; text: string }> = []
  const commands = new DeviceCommands({
    store,
    selfId: () => 'dev_pc',
    noteBack: (chat, text) => {
      notes.push({ chat, text })
    },
    ackWaitMs: 2000,
    tickMs: 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  commands.attach(host)
  const opened: string[] = []
  const tools = deviceTools({ store, selfId: () => 'dev_pc', commands: () => commands, openLocal: (url) => opened.push(url) })
  cleanups.push(async () => {
    commands.stop()
    await host.close()
    store.close()
  })
  return { store, host, commands, notes, opened, tools }
}

/** The phone side: answer every device.command it is sent. */
function phoneAnswers(host: TestHost, ok = true, note = ''): () => void {
  let seen = 0
  const timer = setInterval(() => {
    const commands = host.events.filter((e) => e.name === 'device.command' && e.deviceId === 'dev_phone')
    for (const event of commands.slice(seen)) {
      const id = (event.payload as { id: string }).id
      void host.rpc.get('device.ack')?.('dev_phone', [id, ok, note])
    }
    seen = commands.length
  }, 10)
  return () => clearInterval(timer)
}

async function userSays(store: Store, text: string, origin: MessageOrigin | null, chat = 'main'): Promise<void> {
  const meta: Record<string, unknown> = chat === 'main' ? {} : { chat }
  if (origin !== null) meta['origin'] = origin
  await store.upsert('chat_item', { kind: 'user', text, meta: JSON.stringify(meta) })
}

describe('origin', () => {
  it('names the device the message came from in one line', async () => {
    const { store } = await setup()
    await userSays(store, 'from the phone', PHONE)
    const origin = await latestOrigin(store, 'main')
    expect(origin?.deviceId).toBe('dev_phone')
    const line = originLine(origin, 'dev_pc')
    expect(line).toContain('Test Phone')
    expect(line).toContain('phone, Android')
    expect(line).toContain('412 px')
    expect(line).toContain('can open links')
    expect(line.split('\n')).toHaveLength(1)
    expect(originLine(null, 'dev_pc')).toContain('this computer')
    expect(originLine({ ...PHONE, deviceId: 'dev_pc' }, 'dev_pc')).toContain('this computer')
  })
})

describe('device commands and the tools that use them', () => {
  it('open_url from a phone message goes to the phone, which confirms it', async () => {
    const { store, host, tools, opened } = await setup()
    cleanups.push(phoneAnswers(host))
    await userSays(store, 'show me the map', PHONE)
    const result = await toolNamed(tools, 'open_url').run({ url: 'https://example.com/map' }, testContext({ chat: 'main' }))
    expect(result).toBe("Opened https://example.com/map on the user's Test Phone.")
    expect(opened).toEqual([])
    const sent = host.events.filter((e) => e.name === 'device.command')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.deviceId).toBe('dev_phone')
    expect(sent[0]?.payload).toMatchObject({ kind: 'open_url', url: 'https://example.com/map' })
    expect((await store.list('device_command'))[0]?.status).toBe('done')
  })

  it('open_url from this computer opens the browser here, as before', async () => {
    const { store, host, tools, opened } = await setup()
    await userSays(store, 'open it', null)
    const result = await toolNamed(tools, 'open_url').run({ url: 'https://example.com/' }, testContext())
    expect(result).toContain('this computer')
    expect(opened).toEqual(['https://example.com/'])
    expect(host.events).toEqual([])
  })

  it('send_file gives the phone a /v1/file address to download with its pass', async () => {
    const { store, host, tools } = await setup()
    cleanups.push(phoneAnswers(host))
    const dir = mkdtempSync(join(tmpdir(), 'agent-send-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'report.pdf')
    writeFileSync(file, 'pdf')
    await userSays(store, 'send me the report', PHONE, 'pc1')
    const result = await toolNamed(tools, 'send_file').run({ path: file }, testContext({ chat: 'pc1' }))
    expect(result).toBe("Sent report.pdf to the user's Test Phone.")
    expect(host.events[0]?.payload).toMatchObject({ kind: 'send_file', name: 'report.pdf', url: `/v1/file?path=${encodeURIComponent(file)}` })
    expect(await toolNamed(tools, 'send_file').run({ path: join(dir, 'missing.pdf') }, testContext({ chat: 'pc1' }))).toContain('no file')
  })

  it('waits for an offline phone, delivers when it connects, and only the phone may answer', async () => {
    const { store, host, tools, commands } = await setup({ connected: false })
    await userSays(store, 'open it on my phone', PHONE)
    const result = await toolNamed(tools, 'open_url').run({ url: 'https://example.com/later' }, testContext())
    expect(result).toContain('not online')
    expect(host.events).toEqual([])
    const [row] = await store.list('device_command')
    expect(row?.status).toBe('queued')

    host.connected.add('dev_phone')
    await commands.tick()
    expect(host.events.map((e) => e.name)).toEqual(['device.command'])
    expect((await store.get('device_command', row?.id ?? ''))?.status).toBe('sent')

    expect(await commands.ack('dev_other', row?.id ?? '', true, '')).toBe(false)
    expect(await commands.ack('dev_phone', row?.id ?? '', true, '')).toBe(true)
    expect((await store.get('device_command', row?.id ?? ''))?.status).toBe('done')
    // Delivered once.
    await commands.tick()
    expect(host.events).toHaveLength(1)
  })

  it('expires after 10 minutes with one note back to the agent', async () => {
    let now = 1_000_000
    const { store, tools, commands, notes } = await setup({ connected: false, now: () => now })
    await userSays(store, 'open it', PHONE, 'pc9')
    await toolNamed(tools, 'open_url').run({ url: 'https://example.com/x' }, testContext({ chat: 'pc9' }))
    now += 9 * 60_000
    await commands.tick()
    expect(notes).toEqual([])
    now += 2 * 60_000
    await commands.tick()
    await commands.tick()
    expect(notes).toHaveLength(1)
    expect(notes[0]?.chat).toBe('pc9')
    expect(notes[0]?.text).toContain('did not come online within 10 minutes')
    expect((await store.list('device_command'))[0]?.status).toBe('expired')
  })

  it('says so when the phone cannot do it', async () => {
    const { store, host, tools } = await setup()
    cleanups.push(phoneAnswers(host, false, 'no browser'))
    await userSays(store, 'open', PHONE)
    const failed = await toolNamed(tools, 'open_url').run({ url: 'https://example.com/' }, testContext())
    expect(failed).toContain('could not open it: no browser')
    await userSays(store, 'open', { ...PHONE, canOpenLinks: false })
    expect(await toolNamed(tools, 'open_url').run({ url: 'https://example.com/' }, testContext())).toContain('cannot open links')
    await waitFor(() => true)
  })
})
