import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { facts, startTestHost } from './devices-host'
import { Store } from '../src/main/db'
import { DeviceToolHub } from '../src/main/devices/device-tools'
import type { DeviceTool } from '../src/main/devices/types'
import { waitFor } from '../../../packages/core/test/helpers'
import { TransferRelay, registerTransferRelayRoutes } from '../src/main/devices/transfer-relay'
import { TransferSender } from '../src/main/devices/transfer-sender'
import { TransferInbox, TransferStore } from '../src/main/devices/file-transfer'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('persists a queued file transfer across store restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-test-'))
  dirs.push(dir)
  const source = join(dir, 'source')
  await writeFile(source, 'hello')
  const store = new TransferStore(join(dir, 'inbox'))
  const transfer = await store.create(source, 'phone', 'report.txt')
  expect(transfer).toMatchObject({ target: 'phone', name: 'report.txt', size: 5, nextIndex: 0, status: 'queued' })
  expect(transfer.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  const resumed = new TransferStore(join(dir, 'inbox'))
  expect(await resumed.get(transfer.id)).toEqual(transfer)
  expect(await readFile(source, 'utf8')).toBe('hello')
})

it('resumes a 50 MB relay after the link drops and delivers identical bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-large-'))
  dirs.push(dir)
  const source = join(dir, 'source')
  const bytes = Buffer.alloc(50 * 1024 * 1024)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  await writeFile(source, bytes)
  const store = new TransferStore(join(dir, 'sender'))
  const transfer = await store.create(source, 'phone', 'large.bin')
  const chunks = new Map<number, Buffer>()
  let fail = true
  const remote = async (chunk: { transferId: string; index: number; dataBase64: string }) => {
    if (chunk.index === 7 && fail) { fail = false; throw new Error('link dropped') }
    chunks.set(chunk.index, Buffer.from(chunk.dataBase64, 'base64'))
    return { status: 'partial' as const, nextIndex: chunk.index + 1 }
  }
  await expect(store.send(transfer.id, remote)).rejects.toThrow('link dropped')
  expect((await store.get(transfer.id)).nextIndex).toBe(7)
  const resumed = new TransferStore(join(dir, 'sender'))
  await resumed.send(transfer.id, remote)
  expect(createHash('sha256').update(Buffer.concat([...chunks.values()])).digest('hex')).toBe(transfer.sha256)
})

it('stores chunks in the second node inbox, resumes and rejects corrupted bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-inbox-'))
  dirs.push(dir)
  const inbox = new TransferInbox(dir)
  const id = '11111111-1111-4111-8111-111111111111'
  const first = { transferId: id, index: 0, name: 'a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', total: 2, dataBase64: Buffer.from('hel').toString('base64') }
  expect(await inbox.receive(first)).toEqual({ status: 'partial', nextIndex: 1 })
  expect(await new TransferInbox(dir).receive(first)).toEqual({ status: 'partial', nextIndex: 1 })
  expect(await inbox.receive({ transferId: id, index: 1, dataBase64: Buffer.from('xx').toString('base64') })).toEqual({ status: 'hash_mismatch' })
})

it('relays a file through a second inbox to a fake phone after a dropped link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-two-node-'))
  dirs.push(dir)
  const source = join(dir, 'source')
  await writeFile(source, Buffer.alloc(2 * 1024 * 1024 + 10, 37))
  const sender = new TransferStore(join(dir, 'sender'))
  const relay = new TransferInbox(join(dir, 'relay'))
  const phone = new TransferInbox(join(dir, 'phone'))
  const row = await sender.create(source, 'phone', 'test.dat')
  let dropped = false
  const transport = async (chunk: Parameters<TransferInbox['receive']>[0]) => {
    if (!dropped && chunk.index === 2) { dropped = true; throw new Error('disconnected') }
    const ack = await relay.receive(chunk)
    if (ack.status !== 'received') return ack
    let phoneResult: Awaited<ReturnType<TransferInbox['receive']>> = { status: 'partial', nextIndex: 0 }
    for (let index = 0; index < Math.ceil(row.size / row.chunkSize); index++) {
      const dataBase64 = (await readFile(join(ack.path, String(index)))).toString('base64')
      phoneResult = await phone.receive({ transferId: row.id, index, dataBase64, ...(index === 0 ? { name: row.name, size: row.size, sha256: row.sha256, total: Math.ceil(row.size / row.chunkSize) } : {}) })
    }
    return phoneResult
  }
  await expect(sender.send(row.id, transport)).rejects.toThrow('disconnected')
  const delivered = await new TransferStore(join(dir, 'sender')).send(row.id, transport)
  expect(delivered.status).toBe('delivered')
  expect(delivered.nextIndex).toBe(5)
})

it('allows only a paired node to upload into the relay inbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-route-'))
  dirs.push(dir)
  const host = await startTestHost('node2')
  try {
    host.passes.set('node-pass', { deviceId: 'node1', node: true })
    host.passes.set('phone-pass', { deviceId: 'phone', node: false })
    const relay = new TransferRelay(dir, async () => { throw new Error('unavailable') })
    registerTransferRelayRoutes(host, relay)
    const payload = { transferId: '22222222-2222-4222-8222-222222222222', index: 0, name: 'a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', total: 1, dataBase64: Buffer.from('hello').toString('base64') }
    const post = (token: string) => fetch(host.url + '/v1/file-relay/chunk', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'phone', chunk: payload }) })
    expect((await post('phone-pass')).status).toBe(401)
    const result = await post('node-pass')
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ status: 'queued' })
  } finally { await host.close() }
})

it('resumes relay-to-phone delivery after restart and reports delivered only after phone acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-phone-resume-'))
  dirs.push(dir)
  const inbox = new TransferInbox(join(dir, 'relay'))
  const phone = new TransferInbox(join(dir, 'phone'))
  const id = '33333333-3333-4333-8333-333333333333'
  const data = Buffer.alloc(2 * 512 * 1024 + 3, 51)
  const hash = createHash('sha256').update(data).digest('hex')
  for (let i = 0; i < 3; i++) {
    await inbox.receive({ transferId: id, index: i, dataBase64: data.subarray(i * 512 * 1024, (i + 1) * 512 * 1024).toString('base64'), ...(i === 0 ? { name: 'phone.bin', size: data.length, sha256: hash, total: 3 } : {}) })
  }
  let drop = true
  const receive = async (chunk: Parameters<TransferInbox['receive']>[0]) => {
    if (chunk.index === 1 && drop) { drop = false; throw new Error('phone link lost') }
    return phone.receive(chunk)
  }
  await expect(inbox.deliver(id, receive)).rejects.toThrow('phone link lost')
  const resumed = await new TransferInbox(join(dir, 'relay')).deliver(id, receive)
  expect(resumed).toMatchObject({ status: 'received', bytes: data.length })
})

it('finds a target only on the node holding its connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-presence-'))
  dirs.push(dir)
  const host = await startTestHost('node2')
  try {
    host.passes.set('node-pass', { deviceId: 'node1', node: true })
    host.connected.add('phone')
    registerTransferRelayRoutes(host, new TransferRelay(dir, async () => { throw new Error('unavailable') }))
    const check = async (target: string) => (await fetch(host.url + '/v1/file-relay/presence?target=' + target, { headers: { authorization: 'Bearer node-pass' } })).json()
    expect(await check('phone')).toEqual({ connected: true })
    expect(await check('other')).toEqual({ connected: false })
  } finally { await host.close() }
})

it('keeps an uploaded relay job queued until a phone confirms it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-relay-job-'))
  dirs.push(dir)
  let connected = false
  const phone = new TransferInbox(join(dir, 'phone'))
  const relay = new TransferRelay(join(dir, 'server'), async (_target, chunk) => {
    if (!connected) throw new Error('unavailable')
    return phone.receive(chunk)
  })
  const id = '44444444-4444-4444-8444-444444444444'
  const chunk = { transferId: id, index: 0, name: 'a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', total: 1, dataBase64: Buffer.from('hello').toString('base64') }
  expect(await relay.receive('sender', 'phone', chunk)).toMatchObject({ status: 'queued' })
  await relay.tick()
  expect(await relay.status('sender', id)).toMatchObject({ status: 'queued' })
  connected = true
  const restarted = new TransferRelay(join(dir, 'server'), async (_target, part) => phone.receive(part))
  await restarted.tick()
  expect(await restarted.status('sender', id)).toMatchObject({ status: 'delivered' })
  expect(await restarted.status('other', id)).toBeNull()
})

it('reports queued and delivered separately over the paired node endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-relay-http-'))
  dirs.push(dir)
  const host = await startTestHost('relay')
  const phone = new TransferInbox(join(dir, 'phone'))
  const relay = new TransferRelay(join(dir, 'relay'), async (_target, part) => phone.receive(part))
  try {
    host.passes.set('node-pass', { deviceId: 'sender', node: true })
    registerTransferRelayRoutes(host, relay)
    const id = '55555555-5555-4555-8555-555555555555'
    const chunk = { transferId: id, index: 0, name: 'a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', total: 1, dataBase64: Buffer.from('hello').toString('base64') }
    const headers = { authorization: 'Bearer node-pass', 'content-type': 'application/json' }
    const upload = await fetch(host.url + '/v1/file-relay/chunk', { method: 'POST', headers, body: JSON.stringify({ target: 'phone', chunk }) })
    expect(await upload.json()).toMatchObject({ status: 'queued' })
    const status = async () => (await fetch(host.url + '/v1/file-relay/status?id=' + id, { headers })).json()
    expect(await status()).toMatchObject({ status: 'queued' })
    await relay.tick()
    expect(await status()).toMatchObject({ status: 'delivered' })
  } finally { await host.close() }
})

it('sends through the connected peer and observes the phone receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-sender-'))
  dirs.push(dir)
  const host = await startTestHost('relay')
  const phone = new TransferInbox(join(dir, 'phone'))
  const relay = new TransferRelay(join(dir, 'relay'), async (_target, part) => phone.receive(part))
  try {
    host.passes.set('node-pass', { deviceId: 'sender', node: true })
    host.connected.add('phone')
    registerTransferRelayRoutes(host, relay)
    const source = join(dir, 'source')
    await writeFile(source, 'hello')
    const manager = new TransferSender({ directory: join(dir, 'out'), peers: async () => [{ id: 'relay', urls: [host.url], fp: '' }], pass: () => 'node-pass', fetchFor: () => fetch })
    const row = await manager.enqueue(source, 'phone', 'a.txt')
    await manager.tick()
    expect(await manager.status(row.id)).toMatchObject({ status: 'sending' })
    await relay.tick()
    await manager.tick()
    expect(await manager.status(row.id)).toMatchObject({ status: 'delivered' })
  } finally { await host.close() }
})

it('moves 50 MB over the second node HTTP link, resumes a dropped chunk and waits for the phone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-http-50m-'))
  dirs.push(dir)
  const host = await startTestHost('relay')
  const phone = new TransferInbox(join(dir, 'phone'))
  const relay = new TransferRelay(join(dir, 'relay'), async (_target, part) => phone.receive(part))
  try {
    host.passes.set('node-pass', { deviceId: 'sender', node: true })
    host.connected.add('phone')
    registerTransferRelayRoutes(host, relay)
    const bytes = Buffer.alloc(50 * 1024 * 1024, 97)
    const source = join(dir, 'source')
    await writeFile(source, bytes)
    let drop = true
    const transport: typeof fetch = async (input, init) => {
      if (drop && String(input).endsWith('/chunk') && typeof init?.body === 'string' && (JSON.parse(init.body) as { chunk: { index: number } }).chunk.index === 10) {
        drop = false
        throw new Error('link dropped')
      }
      return fetch(input, init)
    }
    const deps = { directory: join(dir, 'out'), peers: async () => [{ id: 'relay', urls: [host.url], fp: '' }], pass: () => 'node-pass', fetchFor: () => transport }
    const sender = new TransferSender(deps)
    const row = await sender.enqueue(source, 'phone', 'large.bin')
    await sender.tick()
    expect(await sender.status(row.id)).toMatchObject({ status: 'queued', nextIndex: 10 })
    const restarted = new TransferSender(deps)
    await restarted.tick()
    expect(await restarted.status(row.id)).toMatchObject({ status: 'sending', nextIndex: 100 })
    await relay.tick()
    await restarted.tick()
    expect(await restarted.status(row.id)).toMatchObject({ status: 'delivered' })
    const hash = createHash('sha256')
    for (let i = 0; i < 100; i++) hash.update(await readFile(join(dir, 'phone', row.id, String(i))))
    expect(hash.digest('hex')).toBe(row.sha256)
  } finally { await host.close() }
}, 60000)

it('delivers transfer chunks without replicating their bytes into command history', async () => {
  const store = new Store(':memory:')
  const host = await startTestHost('relay')
  const tools: DeviceTool[] = [{ name: 'receive_file', description: '', params: {}, group: 'files', readOnly: false }]
  await store.upsert('device', { id: 'phone', name: 'Phone', kind: 'phone', platform: 'android', roles: ['screen'], priority: 1, urls: [], fp: '', facts: {}, pairedAt: 1, lastSeen: 1, revoked: false, tools })
  host.connected.add('phone')
  host.facts.set('phone', { ...facts('Phone', { kind: 'phone', platform: 'android' }), tools })
  const hub = new DeviceToolHub({ store, selfId: () => 'relay', noteBack: () => {}, waitMs: 1000 })
  hub.attach(host)
  try {
    const pending = hub.callEphemeral('phone', 'receive_file', { transferId: 'id', index: 0, dataBase64: 'aGVsbG8=' })
    await waitFor(() => host.events.length > 0)
    const event = host.events[0]?.payload as { id: string }
    await host.rpc.get('device.result')?.('phone', [event.id, true, { status: 'partial', nextIndex: 1 }])
    expect(await pending).toEqual({ status: 'partial', nextIndex: 1 })
    expect(await store.list('device_command')).toHaveLength(0)
  } finally { hub.stop(); await host.close(); store.close() }
})

it('uses the local relay when the phone is directly connected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-local-'))
  dirs.push(dir)
  const phone = new TransferInbox(join(dir, 'phone'))
  const relay = new TransferRelay(join(dir, 'relay'), async (_target, part) => phone.receive(part))
  const local = { connected: (id: string) => id === 'phone', receive: (target: string, chunk: Parameters<TransferRelay['receive']>[2]) => relay.receive('self', target, chunk), status: (id: string) => relay.status('self', id) }
  const source = join(dir, 'source')
  await writeFile(source, 'hello')
  const sender = new TransferSender({ directory: join(dir, 'out'), peers: async () => [], pass: () => 'node-pass', fetchFor: () => fetch, local })
  const row = await sender.enqueue(source, 'phone', 'a.txt')
  await sender.tick()
  await relay.tick()
  await sender.tick()
  expect(await sender.status(row.id)).toMatchObject({ status: 'delivered' })
})

it('marks a source that changed after hashing as failed rather than retrying forever', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-transfer-changed-'))
  dirs.push(dir)
  const phone = new TransferInbox(join(dir, 'phone'))
  const relay = new TransferRelay(join(dir, 'relay'), async (_target, part) => phone.receive(part))
  const local = { connected: () => true, receive: (target: string, chunk: Parameters<TransferRelay['receive']>[2]) => relay.receive('self', target, chunk), status: (id: string) => relay.status('self', id) }
  const source = join(dir, 'source')
  await writeFile(source, 'hello')
  const sender = new TransferSender({ directory: join(dir, 'out'), peers: async () => [], pass: () => 'node-pass', fetchFor: () => fetch, local })
  const row = await sender.enqueue(source, 'phone', 'a.txt')
  await writeFile(source, 'other')
  await sender.tick()
  expect(await sender.status(row.id)).toMatchObject({ status: 'failed' })
})

it('marks a phone hash mismatch as failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-phone-hash-'))
  dirs.push(dir)
  const relay = new TransferRelay(dir, async () => ({ status: 'hash_mismatch' }))
  const id = '66666666-6666-4666-8666-666666666666'
  await relay.receive('sender', 'phone', { transferId: id, index: 0, name: 'a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', total: 1, dataBase64: Buffer.from('hello').toString('base64') })
  await relay.tick()
  expect(await relay.status('sender', id)).toMatchObject({ status: 'failed' })
})

it('resumes when the phone is ahead of the relay after an acknowledgement was lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-phone-ahead-'))
  dirs.push(dir)
  const relay = new TransferInbox(join(dir, 'relay'))
  const phone = new TransferInbox(join(dir, 'phone'))
  const id = '77777777-7777-4777-8777-777777777777'
  const data = Buffer.alloc(2 * 512 * 1024 + 1, 81)
  const sha256 = createHash('sha256').update(data).digest('hex')
  for (let index = 0; index < 3; index++) {
    const chunk = { transferId: id, index, dataBase64: data.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString('base64'), ...(index === 0 ? { name: 'test', size: data.length, sha256, total: 3 } : {}) }
    await relay.receive(chunk)
    if (index < 2) await phone.receive(chunk)
  }
  expect(await relay.deliver(id, (chunk) => phone.receive(chunk))).toMatchObject({ status: 'received', bytes: data.length })
})
