/**
 * S2 (review of 14 Nov 2026): what another device may write through the generic data calls, per role, entity and
 * field. Runs through callAllowed, the one door every paired device (phone, desktop, headless node) comes in by.
 */
import { describe, expect, it } from 'vitest'

import { callAllowed } from '../src/main/devices/rpc'
import { HandlerRegistry, recordHandlers } from '../src/main/devices/registry'
import type { DeviceRole, MessageOrigin } from '../src/main/devices/types'
import { CHANNELS } from '../src/shared/channels'

const origin = { deviceId: 'dev_p', name: 'Pixel', kind: 'phone', platform: 'android' } as unknown as MessageOrigin
const session = (roles: DeviceRole[] | null) => ({ deviceId: 'dev_p', origin: () => origin, roles })

/** A registry whose data handlers record what they were really asked. */
function rig() {
  const registry = new HandlerRegistry()
  const seen: Array<{ method: string; args: unknown[] }> = []
  const ipc = recordHandlers({ handle: (_channel: string, _listener: unknown) => undefined }, registry)
  const record = (method: string) => async (_event: unknown, ...args: unknown[]) => {
    seen.push({ method, args })
    return { ok: true }
  }
  ipc.handle(CHANNELS.data.upsert, record('data.upsert'))
  ipc.handle(CHANNELS.data.remove, record('data.remove'))
  ipc.handle(CHANNELS.data.list, record('data.list'))
  ipc.handle(CHANNELS.chat.decide, record('chat.decide'))
  ipc.handle(CHANNELS.chat.send, record('chat.send'))
  return { registry, seen, call: (roles: DeviceRole[] | null, method: string, ...args: unknown[]) => callAllowed(registry, new Map(), session(roles), method, args) }
}

const SCREEN: DeviceRole[] = ['screen']

describe('remote data writes: default deny', () => {
  for (const entity of ['chat_item', 'turn', 'device', 'device_command', 'turn_lease', 'job', 'wakeup', 'miniapp', 'nonsense', '__proto__', 'constructor']) {
    it(`refuses a generic upsert and remove of ${entity}`, async () => {
      const { call, seen } = rig()
      await expect(call(SCREEN, 'data.upsert', entity, { id: 'x' })).rejects.toThrow(/not available/)
      await expect(call(SCREEN, 'data.remove', entity, 'x')).rejects.toThrow(/not available/)
      expect(seen).toEqual([])
    })
  }

  it('refuses to decide an approval through generic CRUD, and the typed transition still works', async () => {
    const { call, seen } = rig()
    const meta = JSON.stringify({ approval: true, answer: 'approve', decided: true })
    await expect(call(SCREEN, 'data.upsert', 'chat_item', { id: 'card1', kind: 'approval', meta })).rejects.toThrow(/not available/)
    await expect(call(SCREEN, 'data.remove', 'chat_item', 'card1')).rejects.toThrow(/not available/)
    expect(seen).toEqual([])
    await call(SCREEN, 'chat.decide', 'card1', 'approve')
    expect(seen.map((each) => each.method)).toEqual(['chat.decide'])
  })

  it('refuses a field the entity does not have', async () => {
    const { call, seen } = rig()
    await expect(call(SCREEN, 'data.upsert', 'task', { title: 'x', evil: 1 })).rejects.toThrow(/task\.evil/)
    await expect(call(SCREEN, 'data.upsert', 'memory', { title: 'x', permissions: ['shell'] })).rejects.toThrow(/memory\.permissions/)
    await expect(call(SCREEN, 'data.upsert', 'project', { name: 'x', secrets: {} })).rejects.toThrow(/project\.secrets/)
    expect(seen).toEqual([])
  })

  it('refuses a value of the wrong type or outside its choices', async () => {
    const { call } = rig()
    await expect(call(SCREEN, 'data.upsert', 'task', { status: 'approved' })).rejects.toThrow(/task\.status/)
    await expect(call(SCREEN, 'data.upsert', 'task', { title: { $ne: 1 } })).rejects.toThrow(/task\.title/)
    await expect(call(SCREEN, 'data.upsert', 'trigger', { kind: 'shell' })).rejects.toThrow(/trigger\.kind/)
    await expect(call(SCREEN, 'data.upsert', 'trigger', { enabled: 'yes' })).rejects.toThrow(/trigger\.enabled/)
    await expect(call(SCREEN, 'data.upsert', 'task', 'not an object')).rejects.toThrow(/row must be an object/)
    await expect(call(SCREEN, 'data.upsert', 'task', { id: '../../etc' })).rejects.toThrow(/valid id/)
  })

  it("never lets a device move a routine's run state or make a row the app's own", async () => {
    const { call, seen } = rig()
    await call(SCREEN, 'data.upsert', 'trigger', { id: 't1', name: 'Brief', enabled: false, lastRunAt: 1, lastResult: 'done', lastStartedAt: 2, deskId: 'h1', builtin: 'memory-daily', eventId: 'e' })
    expect(seen[0]?.args).toEqual(['trigger', { id: 't1', name: 'Brief', enabled: false }])
  })

  it('does not let a prompt rule be deleted (it keeps its history)', async () => {
    const { call } = rig()
    await expect(call(SCREEN, 'data.remove', 'prompt_rule', 'r1')).rejects.toThrow(/not available/)
  })
})

describe('remote data writes: roles', () => {
  it('refuses a device that is only hands, and one that is unknown or taken out', async () => {
    const { call, seen } = rig()
    await expect(call(['hands'], 'data.upsert', 'task', { title: 'x' })).rejects.toThrow(/not available/)
    await expect(call(['hands'], 'data.remove', 'task', 't1')).rejects.toThrow(/not available/)
    await expect(call(['hands'], 'chat.decide', 'card1', 'approve')).rejects.toThrow(/not available/)
    await expect(call(['hands'], 'chat.send', 'hi')).rejects.toThrow(/not available/)
    await expect(call(null, 'data.upsert', 'task', { title: 'x' })).rejects.toThrow(/not available/)
    await expect(call(null, 'data.list', 'task')).rejects.toThrow(/not available/)
    expect(seen).toEqual([])
  })

  it('lets hands read, and screen or brain write', async () => {
    const { call, seen } = rig()
    await call(['hands'], 'data.list', 'task')
    await call(['screen'], 'data.upsert', 'task', { title: 'x' })
    await call(['brain'], 'data.upsert', 'task', { title: 'y' })
    await call(['hands', 'screen'], 'chat.send', 'hi')
    expect(seen.map((each) => each.method)).toEqual(['data.list', 'data.upsert', 'data.upsert', 'chat.send'])
  })
})

describe('the phone app keeps working (the exact payloads of its Kotlin builders)', () => {
  // RemoteRows.taskInput / memoryInput / triggerInput and ProjectsApi.createPayload in Past-da-king/agent, 14 Nov 2026.
  it('task, memory and routine saves and deletes', async () => {
    const { call, seen } = rig()
    const task = { id: 't1', title: 'Milk', notes: '', status: 'doing', owner: 'user', blocker: '', dueAt: null, goalId: null, updatedAt: 1_700_000_000_000 }
    const newTask = { title: 'Milk', notes: 'n', status: 'todo', owner: 'user', blocker: '', dueAt: 1_700_000_000_000, goalId: 'g1', updatedAt: 1 }
    const memory = { id: 'm1', title: 'Seat', body: 'window', kind: 'preference', topics: 'travel', pinned: true, source: 'user', updatedAt: 5 }
    const routine = { id: 'r1', name: 'Brief', kind: 'daily', spec: '07:30', prompt: 'Brief me', enabled: true }
    for (const [entity, row] of [['task', task], ['task', newTask], ['memory', memory], ['trigger', routine]] as const) {
      await call(SCREEN, 'data.upsert', entity, row)
      expect(seen.at(-1)?.args).toEqual([entity, row])
    }
    for (const entity of ['task', 'memory', 'trigger']) await call(SCREEN, 'data.remove', entity, 'abc123')
    expect(seen.filter((each) => each.method === 'data.remove')).toHaveLength(3)
  })

  it('project create and the chat-list update', async () => {
    const { call, seen } = rig()
    const create = {
      chats: [],
      name: 'Plumbing',
      description: 'Pipes',
      aliases: [],
      icon: { glyph: 'folder', color: 'iris' },
      path: '',
      profile: '',
      hidden: false,
      ai: { main: { account: '', model: '' }, helpers: { account: '', model: '' } },
    }
    await call(SCREEN, 'data.upsert', 'project', create)
    await call(SCREEN, 'data.upsert', 'project', { id: 'p1', chats: ['pcabcdefghij012345'] })
    expect(seen.map((each) => each.args[1])).toEqual([create, { id: 'p1', chats: ['pcabcdefghij012345'] }])
  })

  it('the reads and typed calls it makes', async () => {
    const { call } = rig()
    await call(SCREEN, 'data.list', 'project')
    await call(SCREEN, 'chat.decide', 'card1', 'decline')
    await call(SCREEN, 'chat.send', 'hello')
  })
})
