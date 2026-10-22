import { existsSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncClient, schema, str, type DeviceRow, type Tool } from '@agent/core'

import { Store } from '../src/main/db'
import { DeviceToolHub, DeviceToolRunner, canonTool, catalogueOf, deviceAgentTools, offers, shareOf, withDeviceArg } from '../src/main/devices/device-tools'
import { Replicator, registerSyncRoutes } from '../src/main/devices/replicate'
import { Runner } from '../src/main/runtime/runner'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import type { DeviceTool, MessageOrigin } from '../src/main/devices/types'
import { facts, startTestHost, type TestHost } from './devices-host'
import { secretsView, settingsView, testContext, toolNamed } from './support'
import { waitFor } from '../../../packages/core/test/helpers'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const PHONE_TOOLS: DeviceTool[] = [
  { name: 'browser_open', description: 'Open a page in the phone browser', params: { type: 'object', properties: { url: { type: 'string' } } }, group: 'browser', readOnly: false },
  { name: 'browser_look', description: 'Screenshot', params: { type: 'object', properties: {} }, group: 'browser', readOnly: true },
  { name: 'ask_user', description: 'Ask on the phone', params: { type: 'object', properties: {} }, group: 'approval', readOnly: false },
  { name: 'request_approval', description: 'Approve on the phone', params: { type: 'object', properties: {} }, group: 'approval', readOnly: false },
  { name: 'notify', description: 'Phone notification', params: { type: 'object', properties: {} }, group: 'notifications', readOnly: false },
]

const PHONE_ORIGIN: MessageOrigin = { deviceId: 'dev_phone', name: 'Test Phone', kind: 'phone', platform: 'android', screenWidth: 412, canOpenLinks: true, canReceiveFiles: true }

/** A tool that stands in for a real one on this computer. */
function fakeTool(name: string, answer: (input: Record<string, unknown>) => string): Tool {
  return { spec: { name, description: `fake ${name}`, schema: schema([], { url: str('url') }) }, run: async (input) => answer(input) }
}

const base = { platform: 'linux', urls: [], fp: '', facts: {}, pairedAt: 1, lastSeen: 1, revoked: false }

async function setup(options: { phoneOnline?: boolean } = {}) {
  const store = new Store(':memory:')
  const host: TestHost = await startTestHost('dev_pc')
  await store.upsert('device', { ...base, id: 'dev_pc', name: 'Office PC', kind: 'desktop', roles: ['brain'], priority: 0 })
  await store.upsert('device', { ...base, id: 'dev_phone', name: 'Test Phone', kind: 'phone', platform: 'android', roles: ['screen'], priority: 5 })
  host.facts.set('dev_phone', { ...facts('Test Phone', { kind: 'phone', platform: 'android' }), tools: PHONE_TOOLS })
  if (options.phoneOnline !== false) host.connected.add('dev_phone')
  // What it offered when it was last connected.
  else await store.upsert('device', { id: 'dev_phone', tools: PHONE_TOOLS } as Partial<DeviceRow> & { id: string })
  const notes: Array<{ chat: string; text: string }> = []
  const localTools = [fakeTool('browser_open', (i) => `Opened ${String(i['url'])} on the PC`), fakeTool('shell_run', () => 'ran')]
  const settings = { preferred: {} as Record<string, string> }
  const hub = new DeviceToolHub({
    store,
    selfId: () => 'dev_pc',
    localTools: () => localTools,
    preferred: () => settings.preferred,
    noteBack: (chat, text) => {
      notes.push({ chat, text })
    },
    waitMs: 1500,
  })
  hub.attach(host)
  cleanups.push(async () => {
    hub.stop()
    await host.close()
    store.close()
  })
  return { store, host, hub, notes, settings, localTools }
}

/** The phone: answers every tool command it is sent, like the app would. */
function phone(host: TestHost, answer: (tool: string, args: Record<string, unknown>) => { ok: boolean; value: unknown } | null): () => void {
  let seen = 0
  const timer = setInterval(() => {
    const commands = host.events.filter((e) => e.name === 'device.command' && e.deviceId === 'dev_phone')
    for (const event of commands.slice(seen)) {
      const payload = event.payload as { id: string; kind: string; tool: string; args: Record<string, unknown>; deadlineMs: number }
      if (payload.kind !== 'tool') continue
      const out = answer(payload.tool, payload.args)
      if (out !== null) void host.rpc.get('device.result')?.('dev_phone', [payload.id, out.ok, out.value])
    }
    seen = commands.length
  }, 10)
  return () => clearInterval(timer)
}

function phoneAnswers(tool: string, args: Record<string, unknown>): { ok: boolean; value: unknown } {
  if (tool === 'browser_open') return { ok: true, value: `Phone opened ${String(args['url'])}` }
  if (tool === 'browser_look') return { ok: true, value: { title: 'Shop', shot: { type: 'image', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64') } } }
  if (tool === 'ask_user') return { ok: true, value: 'Yes, book it' }
  if (tool === 'request_approval') return { ok: true, value: true }
  if (tool === 'notify') return { ok: true, value: 'Shown' }
  return { ok: false, value: 'unknown tool' }
}

async function from(store: Store, origin: MessageOrigin | null, chat = 'main'): Promise<void> {
  const meta: Record<string, unknown> = chat === 'main' ? {} : { chat }
  if (origin !== null) meta['origin'] = origin
  await store.upsert('chat_item', { kind: 'user', text: 'hi', meta: JSON.stringify(meta) })
}

describe('shared device tools: a phone', () => {
  it('lists devices with their tool groups, keeping the phone tools from its hello on its row', async () => {
    const { hub, store } = await setup()
    const tools = deviceAgentTools({ hub: () => hub })
    const listed = await toolNamed(tools, 'devices_list').run({}, testContext())
    expect(listed).toContain('Test Phone (phone, online')
    expect(listed).toContain('browser, approval, notifications')
    expect(listed).toContain('Office PC (desktop, this computer, online')
    const row = (await store.get('device', 'dev_phone')) as DeviceRow
    expect(row.tools?.map((t) => t.name)).toEqual(PHONE_TOOLS.map((t) => t.name))
    // This computer shares its browser but not its shell (off by default).
    expect(((await store.get('device', 'dev_pc')) as DeviceRow).tools?.map((t) => t.name)).toEqual(['browser_open'])
  })

  it('device_tool runs a tool on the phone, found by a loose name, and returns its answer', async () => {
    const { host, hub, store } = await setup()
    cleanups.push(phone(host, phoneAnswers))
    const out = await toolNamed(deviceAgentTools({ hub: () => hub }), 'device_tool').run({ device: 'my phone', tool: 'browser_open', args: { url: 'https://example.com' } }, testContext())
    expect(out).toBe('On Test Phone: Phone opened https://example.com')
    const sent = host.events.find((e) => e.name === 'device.command')?.payload as Record<string, unknown>
    expect(sent).toMatchObject({ kind: 'tool', tool: 'browser_open', args: { url: 'https://example.com' }, deadlineMs: 600_000 })
    expect((await store.list('device_command'))[0]?.status).toBe('done')
  })

  it('pictures come back as files the model can see', async () => {
    const { host, hub } = await setup()
    cleanups.push(phone(host, phoneAnswers))
    const out = await hub.call('Test Phone', 'browser_look', {}, 'main')
    expect(out.text).toContain('"shot":"[picture]"')
    const path = /\[\[image:([^\]]+)]]/.exec(out.text)?.[1] ?? ''
    expect(existsSync(path)).toBe(true)
  })

  it('"best" picks the device the user wrote from, then the preferred one, then by priority with phones last for browsing', async () => {
    const { host, hub, store, settings } = await setup()
    cleanups.push(phone(host, phoneAnswers))
    // No origin: the PC (priority 0, not a phone) runs it, here.
    const here = await hub.call('best', 'browser_open', { url: 'https://example.com' }, 'main', testContext())
    expect(here).toMatchObject({ device: 'Office PC', text: 'Opened https://example.com on the PC' })
    // Preferred for browsing: the phone.
    settings.preferred = { browser: 'dev_phone' }
    expect((await hub.call('best', 'browser_open', { url: 'https://a.example' }, 'main', testContext())).device).toBe('Test Phone')
    settings.preferred = {}
    // Written from the phone: the phone, first.
    await from(store, PHONE_ORIGIN, 'pc7')
    expect((await hub.call('best', 'browser_open', { url: 'https://b.example' }, 'pc7', testContext())).device).toBe('Test Phone')
  })

  it('ask_user and request_approval with device put the question on the phone; the answer is the tool result', async () => {
    const { host, hub } = await setup()
    cleanups.push(phone(host, phoneAnswers))
    const local: Tool[] = [
      { spec: { name: 'ask_user', description: 'ask', schema: schema(['question'], { question: str('q') }) }, run: async () => 'asked here' },
      { spec: { name: 'request_approval', description: 'approve', schema: schema(['summary'], { summary: str('s') }) }, run: async () => 'approved here' },
    ]
    const wrapped = withDeviceArg(local, () => hub)
    expect((toolNamed(wrapped, 'ask_user').spec.schema['properties'] as Record<string, unknown>)['device']).toBeDefined()
    expect(await toolNamed(wrapped, 'ask_user').run({ question: 'Book the 9am?', options: ['Yes', 'No'], device: 'Test Phone' }, testContext())).toBe('The user answered on Test Phone: Yes, book it')
    expect(await toolNamed(wrapped, 'request_approval').run({ summary: 'Pay R200', device: 'phone' }, testContext())).toBe('The user approved on Test Phone.')
    // Without device it asks here, as before.
    expect(await toolNamed(wrapped, 'ask_user').run({ question: 'Here?' }, testContext())).toBe('asked here')
    const asked = host.events.map((e) => (e.payload as { tool?: string }).tool)
    expect(asked).toEqual(['ask_user', 'request_approval'])
  })

  it('notify_user goes to the device the user wrote from (by its own tool name), else stays here', async () => {
    const { host, hub, store } = await setup()
    cleanups.push(phone(host, phoneAnswers))
    const local: Tool[] = [{ spec: { name: 'notify_user', description: 'n', schema: schema([], {}) }, run: async () => 'Notified here.' }]
    const [notify] = withDeviceArg(local, () => hub)
    expect(await notify!.run({ title: 'x', body: 'y' }, testContext())).toBe('Notified here.')
    await from(store, PHONE_ORIGIN)
    expect(await notify!.run({ title: 'Done', body: 'Report ready' }, testContext())).toBe('On Test Phone: Shown')
    expect(host.events.at(-1)?.payload).toMatchObject({ tool: 'notify', args: { title: 'Done', body: 'Report ready' } })
  })

  it('an offline phone gets the command when it connects; the late result is posted to the chat once', async () => {
    const { host, hub, notes, store } = await setup({ phoneOnline: false })
    const out = await hub.call('Test Phone', 'browser_open', { url: 'https://late.example' }, 'pc3')
    expect(out.state).toBe('waiting')
    expect(out.text).toContain('offline')
    expect(host.events).toEqual([])
    cleanups.push(phone(host, phoneAnswers))
    host.connected.add('dev_phone')
    await hub.deliverQueued()
    await waitFor(() => notes.length === 1, 3000)
    expect(notes[0]).toEqual({ chat: 'pc3', text: '[Device result: browser_open on Test Phone finished: Phone opened https://late.example]' })
    await hub.deliverQueued()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(notes).toHaveLength(1)
    expect((await store.list('device_command'))[0]?.status).toBe('done')
  })

  it('only the target device may answer, and a tool it does not have is named', async () => {
    const { hub, store } = await setup({ phoneOnline: false })
    await hub.call('Test Phone', 'browser_open', { url: 'https://x.example' }, 'main')
    const [row] = await store.list('device_command')
    expect(await hub.result('dev_other', row?.id ?? '', true, 'forged')).toBe(false)
    expect((await store.get('device_command', row?.id ?? ''))?.status).toBe('queued')
    expect((await hub.call('Test Phone', 'shell_run', {}, 'main')).text).toContain('has no shell_run')
  })

  it('a block on this computer\'s browser names the linked devices that have one', async () => {
    const { hub } = await setup()
    const local: Tool[] = [{ spec: { name: 'browser_open', description: 'open', schema: schema([], {}) }, run: async () => 'HTTP 403 Forbidden: access denied' }]
    const [open] = withDeviceArg(local, () => hub)
    const out = await open!.run({ url: 'https://shop.example' }, testContext())
    expect(out).toContain('Linked devices with a browser: Test Phone (online)')
    const fine: Tool[] = [{ spec: { name: 'browser_open', description: 'open', schema: schema([], {}) }, run: async () => 'Opened. Outline: [1] Buy' }]
    expect(await withDeviceArg(fine, () => hub)[0]!.run({}, testContext())).toBe('Opened. Outline: [1] Buy')
  })
})

describe('tool names a device may spell its own way', () => {
  it('matches every alias pair in both directions, and nothing else', () => {
    const pairs: Array<[string, string]> = [
      ['notify_user', 'notify'],
      ['notify_user', 'notification_post'],
      ['notify_user', 'notifications_post'],
      ['notify_user', 'notify_post'],
      ['send_file', 'file_send'],
      ['send_file', 'files_receive'],
      ['send_file', 'file_receive'],
      ['open_url', 'url_open'],
      ['open_url', 'link_open'],
    ]
    for (const [a, b] of pairs) {
      expect(offers(a, b)).toBe(true)
      expect(offers(b, a)).toBe(true)
    }
    // Two aliases of the same tool match each other too.
    expect(offers('notify', 'notification_post')).toBe(true)
    expect(offers('notify', 'open_url')).toBe(false)
    expect(offers('browser_open', 'browser_look')).toBe(false)
    expect(canonTool('file_send')).toBe('send_file')
    expect(canonTool('browser_open')).toBe('browser_open')
  })

  it('device_tool "notify" reaches a device that offers notify_user, and "notify_user" reaches one that offers notify', async () => {
    const { host, hub, store } = await setup()
    cleanups.push(phone(host, (tool) => (tool === 'notify_user' || tool === 'notify' ? { ok: true, value: `Shown by ${tool}` } : { ok: false, value: 'no' })))
    // The phone in setup() offers `notify`.
    expect(await hub.call('best', 'notify_user', { title: 't', body: 'b' }, 'main')).toMatchObject({ state: 'done', text: 'Shown by notify' })
    // Now it offers `notify_user` instead.
    host.facts.set('dev_phone', { ...facts('Test Phone', { kind: 'phone', platform: 'android' }), tools: [{ name: 'notify_user', description: 'n', params: { type: 'object', properties: {} }, group: 'notifications', readOnly: false }] })
    await hub.refresh()
    expect(((await store.get('device', 'dev_phone')) as DeviceRow).tools?.map((t) => t.name)).toEqual(['notify_user'])
    const out = await toolNamed(deviceAgentTools({ hub: () => hub }), 'device_tool').run({ device: 'best', tool: 'notify', args: { title: 't', body: 'b' } }, testContext())
    expect(out).toBe('On Test Phone: Shown by notify_user')
    const sent = host.events.filter((e) => e.name === 'device.command').map((e) => (e.payload as { tool: string }).tool)
    expect(sent).toEqual(['notify', 'notify_user'])
  })
})

describe('shared device tools: another node, over replication', () => {
  it('a brain runs a tool on another node through synced rows; the node refuses its shell by default', async () => {
    const pcStore = new Store(':memory:')
    const serverStore = new Store(':memory:')
    const serverHost = await startTestHost('dev_server')
    registerSyncRoutes(serverHost, serverStore)
    serverHost.passes.set('pass-pc', { deviceId: 'dev_pc', node: true })
    const pcHost = await startTestHost('dev_pc')
    for (const s of [pcStore, serverStore]) {
      await s.upsert('device', { ...base, id: 'dev_pc', name: 'Office PC', kind: 'desktop', roles: ['brain'], priority: 0 })
      await s.upsert('device', { ...base, id: 'dev_server', name: 'Home Server', kind: 'server', roles: ['brain'], priority: 1, urls: [serverHost.url] })
    }
    // The server shares its browser; its shell stays off (the default).
    const serverTools = [fakeTool('browser_open', (i) => `Server opened ${String(i['url'])}`), fakeTool('shell_run', () => 'should not run')]
    const serverHub = new DeviceToolHub({ store: serverStore, selfId: () => 'dev_server', localTools: () => serverTools, noteBack: () => undefined })
    await serverHub.refresh()
    const runner = new DeviceToolRunner({ store: serverStore, selfId: () => 'dev_server', tools: () => serverTools })
    runner.start()
    const replicator = new Replicator({
      store: pcStore,
      selfId: () => 'dev_pc',
      pass: () => 'pass-pc',
      peers: async () => [{ id: 'dev_server', name: 'Home Server', urls: [serverHost.url], fp: '' }],
      clientFor: (url, _peer, pass) => new SyncClient(url, pass, fetch, true),
      waitSeconds: 1,
      initialBackoffMs: 50,
    })
    replicator.start()
    const hub = new DeviceToolHub({
      store: pcStore,
      selfId: () => 'dev_pc',
      noteBack: () => undefined,
      reachable: (id) => replicator.status().some((link) => link.peer === id && link.ok),
    })
    hub.attach(pcHost)
    cleanups.push(async () => {
      hub.stop()
      runner.stop()
      replicator.stop()
      await serverHost.close()
      await pcHost.close()
      pcStore.close()
      serverStore.close()
    })

    // The server's catalogue arrives with its row.
    await waitFor(async () => ((await pcStore.get('device', 'dev_server')) as DeviceRow | null)?.tools?.length === 1, 8000)
    const out = await hub.call('server', 'browser_open', { url: 'https://blocked.example' }, 'main')
    expect(out).toMatchObject({ state: 'done', device: 'Home Server', text: 'Server opened https://blocked.example' })

    // Even asked straight (bypassing the catalogue), the runner refuses a group it does not share.
    await pcStore.upsert('device_command', { id: 'cmd_forced', target: 'dev_server', kind: 'tool', tool: 'shell_run', args: '{}', deadlineMs: 5000, status: 'queued', note: '', chat: 'main', brainId: 'dev_pc', expiresAt: Date.now() + 60_000, updatedAt: Date.now() })
    await waitFor(async () => (await pcStore.get('device_command', 'cmd_forced'))?.status === 'failed', 8000)
    expect((await pcStore.get('device_command', 'cmd_forced'))?.result).toContain('does not share shell_run')
  }, 20_000)

  it('ask_user on another node shows the question as a card there; the person answers and the brain gets it', async () => {
    const pcStore = new Store(':memory:')
    const serverStore = new Store(':memory:')
    const serverHost = await startTestHost('dev_server')
    registerSyncRoutes(serverHost, serverStore)
    serverHost.passes.set('pass-pc', { deviceId: 'dev_pc', node: true })
    const pcHost = await startTestHost('dev_pc')
    for (const s of [pcStore, serverStore]) {
      await s.upsert('device', { ...base, id: 'dev_pc', name: 'Office PC', kind: 'desktop', roles: ['brain'], priority: 0 })
      await s.upsert('device', { ...base, id: 'dev_laptop', name: 'Laptop', kind: 'desktop', roles: ['brain'], priority: 1, urls: [serverHost.url] })
    }
    // The other node runs the real app tools and its real runner, which shows cards to its person.
    const nodeTools = buildWorkerToolset({ store: serverStore })
    const nodeRunner = new Runner({ store: serverStore, settings: settingsView(), secrets: secretsView(null), providerFactory: () => null, tools: nodeTools, isFocused: () => true })
    const nodeHub = new DeviceToolHub({ store: serverStore, selfId: () => 'dev_laptop', localTools: () => nodeTools, noteBack: () => undefined })
    await nodeHub.refresh()
    const runner = new DeviceToolRunner({ store: serverStore, selfId: () => 'dev_laptop', tools: () => nodeTools, context: (chat, signal) => nodeRunner.deviceContext(chat, signal) })
    runner.start()
    const replicator = new Replicator({
      store: pcStore,
      selfId: () => 'dev_pc',
      pass: () => 'pass-pc',
      peers: async () => [{ id: 'dev_laptop', name: 'Laptop', urls: [serverHost.url], fp: '' }],
      clientFor: (url, _peer, pass) => new SyncClient(url, pass, fetch, true),
      waitSeconds: 1,
      initialBackoffMs: 50,
    })
    replicator.start()
    const hub = new DeviceToolHub({ store: pcStore, selfId: () => 'dev_pc', noteBack: () => undefined, reachable: () => true })
    hub.attach(pcHost)
    cleanups.push(async () => {
      nodeRunner.dispose()
      hub.stop()
      runner.stop()
      replicator.stop()
      await serverHost.close()
      await pcHost.close()
      pcStore.close()
      serverStore.close()
    })
    await waitFor(async () => ((await pcStore.get('device', 'dev_laptop')) as DeviceRow | null)?.tools?.some((t) => t.name === 'ask_user') === true, 8000)

    const asking = withDeviceArg([{ spec: { name: 'ask_user', description: 'ask', schema: schema(['question'], { question: str('q') }) }, run: async () => 'asked here' }], () => hub)[0]!
      .run({ question: 'Ship the release tonight?', options: ['Yes', 'Not yet'], device: 'laptop' }, testContext({ chat: 'pc4' }))
    // The card shows on the laptop, in the same chat.
    const card = await waitFor(async () => (await serverStore.list('chat_item')).find((row) => row.kind === 'question'), 8000)
    expect(card.text).toBe('Ship the release tonight?')
    expect(JSON.parse(card.meta)).toMatchObject({ chat: 'pc4' })
    await nodeRunner.answer(card.id, 'Yes')
    expect(await asking).toBe('The user answered on Laptop: The user answered: Yes')
  }, 20_000)

  it('the catalogue follows the share switches', () => {
    const tools = [fakeTool('browser_open', () => ''), fakeTool('shell_run', () => ''), fakeTool('notify_user', () => ''), fakeTool('memory_search', () => '')]
    expect(catalogueOf(tools, shareOf({})).map((t) => t.name)).toEqual(['browser_open', 'notify_user'])
    expect(catalogueOf(tools, shareOf({ shell: true, browser: false })).map((t) => t.name)).toEqual(['shell_run', 'notify_user'])
  })
})
