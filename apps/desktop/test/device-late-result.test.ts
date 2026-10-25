/**
 * A device call queued while its device was offline (25 Oct 2026): when the device came back, its result landed in the
 * MAIN chat as a bare "[Device result: files_list on ...]" message, not with the helper that made the call, and the
 * same result arrived twice. Now a late result goes only to the run that asked for it, exactly once, and a helper that
 * has ended gets a short line on its card instead (it is never started again for it).
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, schema, type DeviceCommandRow, type DeviceRow, type Tool } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { DeviceToolHub, routeLate } from '../src/main/devices/device-tools'
import type { DeviceTool } from '../src/main/devices/types'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { HelperManager } from '../src/main/runtime/helpers'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { facts, startTestHost, type TestHost } from './devices-host'
import { secretsView, settingsView, testContext } from './support'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

const PC_TOOLS: DeviceTool[] = [{ name: 'files_list', description: 'List a folder', params: { type: 'object', properties: { path: { type: 'string' } } }, group: 'files', readOnly: true }]
const base = { platform: 'windows', urls: [], fp: '', facts: {}, pairedAt: 1, lastSeen: 1, revoked: false }

/** This brain (a server) and a PC that is offline, whose tools are known from when it was last connected. */
async function offlinePc(noteBack: (chat: string, text: string, owner?: string) => void | Promise<void>) {
  const store = new Store(':memory:')
  const host: TestHost = await startTestHost('dev_server')
  await store.upsert('device', { ...base, platform: 'linux', id: 'dev_server', name: 'Server', kind: 'server', roles: ['brain'], priority: 1 })
  await store.upsert('device', { ...base, id: 'dev_pc', name: 'Office PC', kind: 'desktop', roles: ['brain'], priority: 0 })
  await store.upsert('device', { id: 'dev_pc', tools: PC_TOOLS } as Partial<DeviceRow> & { id: string })
  host.facts.set('dev_pc', { ...facts('Office PC', { kind: 'desktop', platform: 'windows' }), tools: PC_TOOLS })
  const hub = new DeviceToolHub({ store, selfId: () => 'dev_server', noteBack, waitMs: 300 })
  hub.attach(host)
  cleanups.push(async () => {
    hub.stop()
    await host.close()
    store.close()
  })
  /** The PC connects and answers every command it is sent. */
  const comeBack = async (): Promise<void> => {
    let seen = 0
    const timer = setInterval(() => {
      const sent = host.events.filter((e) => e.name === 'device.command' && e.deviceId === 'dev_pc')
      for (const event of sent.slice(seen)) {
        const payload = event.payload as { id: string; args: { path?: string } }
        void host.rpc.get('device.result')?.('dev_pc', [payload.id, true, `LISTING of ${payload.args.path ?? ''}`])
      }
      seen = sent.length
    }, 10)
    cleanups.push(() => clearInterval(timer))
    host.connected.add('dev_pc')
    await hub.deliverQueued()
  }
  return { store, host, hub, comeBack }
}

describe('a queued device result goes only to the run that asked, once', () => {
  it('a helper\'s call: one result, for that helper, even when the finished row arrives again', async () => {
    const notes: Array<{ chat: string; text: string; owner: string | undefined }> = []
    const { store, hub, comeBack } = await offlinePc((chat, text, owner) => {
      notes.push({ chat, text, owner })
    })
    const ctx = testContext({ owner: 'helper:h-1', chat: 'pc-project' })
    const out = await hub.call('Office PC', 'files_list', { path: 'C:\\temp\\hb' }, 'pc-project', ctx)
    expect(out.state).toBe('waiting')
    expect(out.text).not.toContain('posted to this chat')

    await comeBack()
    await waitFor(() => notes.length >= 1, 3_000)
    // The same finished row comes in again (its own write, then the copy replication brings back).
    const row = (await store.list('device_command'))[0] as DeviceCommandRow
    await store.upsert('device_command', { id: row.id, status: 'done', note: '', result: row.result } as Partial<DeviceCommandRow> & { id: string })
    await store.upsert('device_command', { id: row.id, status: 'done', note: '', result: row.result } as Partial<DeviceCommandRow> & { id: string })
    await hub.deliverQueued()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(notes).toHaveLength(1)
    expect(notes[0]).toEqual({ chat: 'pc-project', owner: 'helper:h-1', text: '[Device result: files_list on Office PC finished: LISTING of C:\\temp\\hb]' })
  })

  it('end to end: the working helper reads it at its next step, the main chat hears nothing; after it ended, it is dropped with a line on its card', async () => {
    const chatNotes: string[] = []
    let manager: HelperManager | null = null
    const { store, host, hub, comeBack } = await offlinePc((chat, text, owner) =>
      routeLate({ deliver: (note) => void chatNotes.push(note), helper: (id, note) => manager!.lateResult(id, note) }, chat, text, owner),
    )

    // A plan helper whose turns wait until released.
    const turns: Array<{ req: CliTurnRequest; release: (text?: string) => void }> = []
    const cli = {
      turn: (req: CliTurnRequest) => new Promise<{ text: string }>((resolve) => turns.push({ req, release: (text = 'done') => resolve({ text }) })),
      forget: () => undefined,
    } as unknown as CliHost
    const ping: Tool = { spec: { name: 'ping', description: 'Answers pong.', schema: schema([], {}) }, run: async () => 'pong' }
    const delivered: string[] = []
    manager = new HelperManager({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, mode: 'subscription', cli: 'claude', notifications: false }),
      secrets: secretsView(''),
      providerFactory: () => null,
      workerTools: [...buildWorkerToolset({ store }), ping],
      cli,
      deliver: (note) => void delivered.push(note),
      platform: 'linux',
      timeZone: 'UTC',
    })
    cleanups.push(() => manager?.shutdown())
    const id = /#([0-9a-f-]{36})/.exec(await manager.delegate([{ label: 'Hidden browser fix', brief: 'Fix it.' }], false, { chat: 'pc-proj' }))?.[1] ?? ''
    await waitFor(() => turns.length === 1, 5_000)

    // It asks the offline PC for a folder listing and moves on.
    const out = await hub.call('Office PC', 'files_list', { path: 'C:\\temp\\hb' }, 'main', testContext({ owner: `helper:${id}` }))
    expect(out.state).toBe('waiting')
    await comeBack()
    // The result reaches the helper with its next tool answer, and nowhere else.
    await waitFor(async () => (await turns[0]!.req.tools.find((t) => t.spec.name === 'ping')!.run({}, testContext())).includes('LISTING of C:\\temp\\hb'), 3_000)
    expect(chatNotes).toEqual([])

    // The PC drops off again. It finishes; a second call it made comes back only afterwards: dropped, with a line on
    // its card.
    host.connected.delete('dev_pc')
    const late = await hub.call('Office PC', 'files_list', { path: 'C:\\temp\\later' }, 'main', testContext({ owner: `helper:${id}` }))
    expect(late.state).toBe('waiting')
    turns[0]!.release('all done')
    await waitFor(async () => JSON.parse((await store.get('chat_item', id))?.meta ?? '{}')['state'] === 'done', 5_000)
    host.connected.add('dev_pc')
    await hub.deliverQueued()
    const droppedLine = async () => (await store.list('chat_item')).find((row) => row.kind === 'activity' && row.text.includes('dropped') && row.text.includes('C:\\temp\\later'))
    await waitFor(async () => (await droppedLine()) !== undefined, 3_000)
    // The line is on the helper's card, in its own (project) chat, not in the main chat.
    expect(JSON.parse((await droppedLine())!.meta)['chat']).toBe('pc-proj')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(chatNotes).toEqual([])
    expect(turns).toHaveLength(1)
    expect(JSON.parse((await store.get('chat_item', id))?.meta ?? '{}')['state']).toBe('done')
    // The main agent heard only the helper's own result.
    expect(delivered.filter((note) => note.includes('[Device result'))).toEqual([])
  }, 30_000)

  it('routes by owner: main and chats to their chat, a routine\'s is dropped, an old row with no owner to its chat', async () => {
    const chats: Array<[string, string]> = []
    const helpers: Array<[string, string]> = []
    const route = { deliver: (text: string, chat: string) => void chats.push([chat, text]), helper: async (id: string, text: string) => (helpers.push([id, text]), 'delivered' as const) }
    expect(await routeLate(route, 'main', 'A', 'main')).toBe('chat')
    expect(await routeLate(route, 'pc-1', 'B', 'chat:pc-1')).toBe('chat')
    expect(await routeLate(route, 'main', 'C', 'routine')).toBe('dropped')
    expect(await routeLate(route, 'main', 'D', 'helper:h-9')).toBe('helper')
    expect(await routeLate(route, 'pc-2', 'E')).toBe('chat')
    expect(chats).toEqual([['main', 'A'], ['pc-1', 'B'], ['pc-2', 'E']])
    expect(helpers).toEqual([['h-9', 'D']])
  })
})
