/**
 * Learned apps run in the browser of the device where their site is signed in (23 Oct 2026): a helper offloaded to a
 * linked server runs a learned tool in the computer's signed-in browser, not the server's empty one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { JsonObject, Tool, ToolContext } from '@agent/core'

import { LearnedStore } from '../src/main/apps/store'
import { Store } from '../src/main/db'
import { DeviceToolHub as Hub, catalogueOf, groupOf, shareOf, type DeviceToolHub, type ToolOutcome } from '../src/main/devices/device-tools'
import { learnedTarget, withLearnedRoute } from '../src/main/devices/learned-route'
import { testContext } from './support'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-learned-route-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Device {
  id: string
  name: string
  kind: string
  online: boolean
  self: boolean
  tools: string[]
}

/** A hub with a server (this node) and a computer, recording what it was asked to run where. */
function fakeHub(self: string, devices: Device[]) {
  const calls: Array<{ ref: string; tool: string; args: JsonObject }> = []
  const hub = {
    selfId: () => self,
    list: async () => devices,
    call: async (ref: string, tool: string, args: JsonObject): Promise<ToolOutcome> => {
      calls.push({ ref, tool, args })
      const device = devices.find((d) => d.id === ref || d.name === ref)
      return { ok: true, state: 'done', device: device?.name ?? ref, text: '[{"chat":"Family"}]' }
    },
  }
  return { hub: hub as unknown as DeviceToolHub, calls }
}

const SERVER: Device = { id: 'dev_srv', name: 'Box', kind: 'server', online: true, self: true, tools: ['webapp_run', 'webapp_test'] }
const PC: Device = { id: 'dev_pc', name: 'Desk', kind: 'desktop', online: true, self: false, tools: ['webapp_run', 'webapp_test'] }

function setup(self: Device, others: Device[], siteHere: boolean | null) {
  const learned = new LearnedStore(join(dir, 'learned.json'))
  learned.save({ id: 'chat', name: 'Chat', startUrl: 'https://chat.example', about: '', tools: [], trusted: false, updatedAt: 0 })
  const ran: JsonObject[] = []
  const local: Tool = {
    spec: { name: 'webapp_run', description: 'Run one tool', schema: { type: 'object', properties: { app: { type: 'string' } } } },
    run: async (input) => {
      ran.push(input)
      return siteHere === true ? '[{"chat":"Here"}]' : 'Error: Not signed in to chat.example in this browser.'
    },
  }
  const { hub, calls } = fakeHub(self.id, [self, ...others])
  const [tool] = withLearnedRoute([local], () => hub, { learned, selfId: () => self.id, siteHere: async () => siteHere })
  return { learned, tool: tool!, ran, calls }
}

describe('a learned tool runs on the device where its app is signed in', () => {
  it("a helper on the server (its browser cannot tell) runs it in the computer's browser, args and all", async () => {
    const { tool, ran, calls } = setup(SERVER, [PC], null)
    const out = await tool.run({ app: 'Chat', tool: 'list_chats', args: { limit: 5 } }, testContext({ profile: 'general' }))
    expect(calls).toEqual([{ ref: 'dev_pc', tool: 'webapp_run', args: { app: 'Chat', tool: 'list_chats', args: { limit: 5 } } }])
    expect(ran).toEqual([])
    expect(out).toContain('On Desk')
    expect(out).toContain('"Family"')
  })

  it('goes where the app last worked, and never to a device that is offline or lacks the tool', async () => {
    const other: Device = { id: 'dev_lap', name: 'Lap', kind: 'laptop', online: true, self: false, tools: ['webapp_run'] }
    const { learned, tool, calls } = setup(SERVER, [other, PC], false)
    learned.noteDevice('chat', 'dev_pc')
    await tool.run({ app: 'Chat', tool: 'x' }, testContext())
    expect(calls[0]?.ref).toBe('dev_pc')

    const app = learned.find('chat')!
    const offline = await learnedTarget(app, 'webapp_run', testContext(), async () => [SERVER, { ...PC, online: false }], { selfId: () => 'dev_srv' })
    expect(offline).toBeNull()
    const lacking = await learnedTarget(app, 'webapp_run', testContext(), async () => [SERVER, { ...PC, tools: [] }], { selfId: () => 'dev_srv' })
    expect(lacking).toBeNull()
  })

  it("runs here when this browser is signed in, and records this device so the others send it here", async () => {
    const { learned, tool, ran, calls } = setup({ ...PC, self: true }, [{ ...SERVER, self: false }], true)
    expect(await tool.run({ app: 'Chat', tool: 'x' }, testContext())).toBe('[{"chat":"Here"}]')
    expect(calls).toEqual([])
    expect(ran).toHaveLength(1)
    expect(learned.find('chat')?.devices).toEqual(['dev_pc'])
  })

  it('a run that failed here is not recorded', async () => {
    const { learned, tool } = setup({ ...PC, self: true }, [], false)
    await tool.run({ app: 'Chat', tool: 'x' }, testContext())
    expect(learned.find('chat')?.devices).toBeUndefined()
  })

  it('a command that came from another device runs here (it was already routed)', async () => {
    const { tool, ran, calls } = setup(SERVER, [PC], null)
    await tool.run({ app: 'Chat', tool: 'x' }, testContext({ owner: 'device:dev_pc' } as Partial<ToolContext>))
    await tool.run({ app: 'Chat', tool: 'x' }, testContext({ owner: 'device' } as Partial<ToolContext>))
    expect(calls).toEqual([])
    expect(ran).toHaveLength(2)
  })

  it('device names one; here keeps it here', async () => {
    const { tool, ran, calls } = setup({ ...PC, self: true }, [{ ...SERVER, self: false }], true)
    await tool.run({ app: 'Chat', tool: 'x', device: 'Box' }, testContext())
    expect(calls[0]).toMatchObject({ ref: 'Box', args: { app: 'Chat', tool: 'x' } })
    await tool.run({ app: 'Chat', tool: 'x', device: 'here' }, testContext())
    expect(ran).toEqual([{ app: 'Chat', tool: 'x' }])
    expect(JSON.stringify(tool.spec.schema)).toContain('"device"')
  })

  it('a failure here that is not about sign-in is not tried again elsewhere (a send is never doubled)', async () => {
    const learned = new LearnedStore(join(dir, 'learned.json'))
    learned.save({ id: 'chat', name: 'Chat', startUrl: 'https://chat.example', about: '', tools: [{ name: 'send', description: '', params: {}, required: [], js: '', readOnly: false }], trusted: false, updatedAt: 0 })
    learned.noteDevice('chat', 'dev_pc')
    const local: Tool = { spec: { name: 'webapp_run', description: '', schema: { type: 'object', properties: {} } }, run: async () => 'Error: The message box was not found.' }
    const { hub, calls } = fakeHub('dev_pc', [{ ...PC, self: true }, { ...SERVER, id: 'dev_lap', name: 'Lap', self: false, kind: 'laptop' }])
    const [tool] = withLearnedRoute([local], () => hub, { learned, selfId: () => 'dev_pc', siteHere: async () => true })
    expect(await tool!.run({ app: 'Chat', tool: 'send' }, testContext())).toBe('Error: The message box was not found.')
    expect(calls).toEqual([])
  })

  it("a device shares webapp_run with the others as a browser tool, so they can run it there", () => {
    expect(groupOf('webapp_run')).toBe('browser')
    expect(groupOf('webapp_test')).toBe('browser')
    const shared = catalogueOf([{ spec: { name: 'webapp_run', description: '', schema: { type: 'object' } }, run: async () => '' }], shareOf({}))
    expect(shared.map((t) => t.name)).toEqual(['webapp_run'])
  })
})

describe('with no device named, it finds the browser that is signed in (23 Oct 2026)', () => {
  const ROW = { platform: 'linux', urls: [], fp: '', facts: {}, pairedAt: 1, revoked: false, roles: ['brain', 'hands'] }
  const OFFERS = [{ name: 'webapp_run', description: '', params: { type: 'object' }, group: 'browser', readOnly: false }]

  function chatApp(learned: LearnedStore, devices: string[]): void {
    learned.save({
      id: 'chat',
      name: 'Chat',
      startUrl: 'https://chat.example',
      about: '',
      tools: [{ name: 'list_chats', description: '', params: {}, required: [], js: '', readOnly: true }],
      trusted: false,
      updatedAt: 0,
      ...(devices.length === 0 ? {} : { devices }),
    })
  }

  const NOT_HERE = 'Error: Chat is not signed in or still loading. Open chat.example in the agent browser.'

  it('a helper on a server routes to the computer that dials in to it (no link from the server side)', async () => {
    const store = new Store(':memory:')
    const now = Date.now()
    await store.upsert('device', { ...ROW, id: 'dev_srv', name: 'Box', kind: 'server', priority: 1, lastSeen: now, tools: OFFERS })
    // The computer reaches the server, the server cannot dial it back: no RPC session, no replication link from here.
    await store.upsert('device', { ...ROW, id: 'dev_pc', name: 'Desk', kind: 'desktop', priority: 0, lastSeen: now - 20_000, tools: OFFERS })
    const hub = new Hub({ store, selfId: () => 'dev_srv', noteBack: () => undefined })
    const calls: string[] = []
    hub.call = async (ref: string) => {
      calls.push(ref)
      return { ok: true, state: 'done', device: 'Desk', text: '[{"chat":"Family"}]' }
    }
    expect((await hub.list()).find((d) => d.id === 'dev_pc')?.online).toBe(true)

    const learned = new LearnedStore(join(dir, 'learned.json'))
    chatApp(learned, ['dev_pc'])
    const ran: JsonObject[] = []
    const local: Tool = { spec: { name: 'webapp_run', description: '', schema: { type: 'object', properties: {} } }, run: async (i) => (ran.push(i), NOT_HERE) }
    const [tool] = withLearnedRoute([local], () => hub, { learned, selfId: () => 'dev_srv' })
    const out = await tool!.run({ app: 'Chat', tool: 'list_chats', args: { limit: 3 } }, testContext({ owner: 'helper:h1' } as Partial<ToolContext>))
    expect(calls).toEqual(['dev_pc'])
    expect(ran).toEqual([])
    expect(out).toBe('On Desk (its browser is where Chat is signed in): [{"chat":"Family"}]')

    // Not heard from for minutes: offline, and the answer says so.
    await store.upsert('device', { id: 'dev_pc', lastSeen: now - 10 * 60_000 } as never)
    expect((await hub.list()).find((d) => d.id === 'dev_pc')?.online).toBe(false)
    store.close()
  })

  it('a run here that is not signed in falls over to the linked device that is', async () => {
    const learned = new LearnedStore(join(dir, 'learned.json'))
    // This device once ran it (a stale record), so it is tried here first.
    chatApp(learned, ['dev_pc'])
    const ran: JsonObject[] = []
    const local: Tool = { spec: { name: 'webapp_run', description: '', schema: { type: 'object', properties: {} } }, run: async (i) => (ran.push(i), NOT_HERE) }
    const LAP: Device = { id: 'dev_lap', name: 'Lap', kind: 'laptop', online: true, self: false, tools: ['webapp_run'] }
    const { hub, calls } = fakeHub('dev_pc', [{ ...PC, self: true }, { ...SERVER, self: false }, LAP])
    const [tool] = withLearnedRoute([local], () => hub, { learned, selfId: () => 'dev_pc', siteHere: async () => null })
    const out = await tool!.run({ app: 'Chat', tool: 'list_chats' }, testContext())
    expect(ran).toHaveLength(1)
    expect(calls.map((c) => c.ref)).toEqual(['dev_lap'])
    expect(out).toContain('On Lap')
    expect(out).toContain('"Family"')
    expect(learned.find('chat')?.devices).toContain('dev_lap')
  })

  it('signed in nowhere: the error names every device it checked', async () => {
    const learned = new LearnedStore(join(dir, 'learned.json'))
    chatApp(learned, [])
    const local: Tool = { spec: { name: 'webapp_run', description: '', schema: { type: 'object', properties: {} } }, run: async () => NOT_HERE }
    const LAP: Device = { id: 'dev_lap', name: 'Lap', kind: 'laptop', online: false, self: false, tools: ['webapp_run'] }
    const devices = [SERVER, PC, LAP]
    const asked: string[] = []
    const hub = {
      selfId: () => 'dev_srv',
      list: async () => devices,
      call: async (ref: string): Promise<ToolOutcome> => {
        asked.push(ref)
        return { ok: true, state: 'done', device: 'Desk', text: 'Error: Chat is not signed in. Scan the QR code.' }
      },
    } as unknown as DeviceToolHub
    const [tool] = withLearnedRoute([local], () => hub, { learned, selfId: () => 'dev_srv', siteHere: async () => null })
    const out = await tool!.run({ app: 'Chat', tool: 'list_chats' }, testContext())
    expect(asked).toEqual(['dev_pc'])
    expect(out).toMatch(/^Error: Chat is not signed in on any device that could run it \(chat\.example\)\. Checked: /)
    expect(out).toContain('Desk: Error: Chat is not signed in')
    expect(out).toContain('Box (here): Error: Chat is not signed in or still loading')
    expect(out).toContain('Lap: offline')
  })
})
