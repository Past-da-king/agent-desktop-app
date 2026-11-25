import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Tool, type JsonObject } from '@agent/core'
import { Store } from '../src/main/db'
import {
  PrGate,
  withPrGate,
  ATTESTATION_FIELDS,
} from '../src/main/runtime/pr-gate'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
import {
  prepareRemoteGrant,
  remoteArguments,
  recordRemoteResult,
} from '../src/main/runtime/pr-gate-remote'
import { testContext } from './support'
import { LearnedStore } from '../src/main/apps/store'
import { withLearnedRoute } from '../src/main/devices/learned-route'
import type { DeviceToolHub } from '../src/main/devices/device-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))
function setup(enabled = true) {
  const store = new Store(':memory:')
  stores.push(store)
  return {
    store,
    gate: new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: enabled,
      prGateSkillPages: ['Review policy'],
    })),
    ctx: testContext({ owner: 'helper:author', chat: 'round4' }),
  }
}
function fixture(name: string, run: Tool['run']): Tool {
  return { spec: { name, description: 'fixture', schema: {} }, run }
}
const proof = () =>
  Object.fromEntries(
    ATTESTATION_FIELDS.map((key) => [
      key,
      key === 'reviewerAgentId'
        ? 'independent-reviewer'
        : 'Checked /tmp/round4-proof.md: ' + key,
    ]),
  )
it.each([true, false])(
  'protects policy pages with stray device when gate is %s',
  async (enabled) => {
    const t = setup(enabled)
    const row = await t.store.upsert('memory', {
      title: 'Review policy',
      body: 'rules',
      kind: 'fact',
      topics: 'review',
      pinned: false,
      source: 'user',
    })
    for (const [name, input] of [
      ['memory_update', { id: row.id, body: 'replace', device: 'x' }],
      ['app_action', { method: 'memory.undoTidy', device: 'x' }],
    ] as const) {
      const run = vi.fn(async () => 'unsafe execution')
      const tools = withPrGate([fixture(name, run)], t.gate)
      expect(await tools[0]!.run(input, t.ctx)).toContain('Refused')
      expect(run).not.toHaveBeenCalled()
    }
  },
)
it.each(['here', 'local-id', 'other-device'])(
  'resolves learned app identity with device %s',
  async (device) => {
    const t = setup(),
      run = vi.fn(async () => 'unsafe execution')
    const resolve = vi.fn(async (_name: string, input: JsonObject) => ({
      ...input,
      app: 'GitHub',
    }))
    const tools = withPrGate([fixture('webapp_run', run)], t.gate, resolve)
    expect(
      await tools[0]!.run(
        { app: 'Code', tool: 'squash_and_merge', device },
        t.ctx,
      ),
    ).toContain('NOT RUN')
    expect(resolve).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  },
)
it('carries grants and translates destination-only challenges for automatic learned routing', async () => {
  const t = setup()
  let calls = 0
  let grant: JsonObject = {}
  const run: Tool['run'] = async (input, ctx) => {
    calls++
    grant = remoteArguments(ctx, 'webapp_run', input)
    if (calls === 1) {
      recordRemoteResult(ctx, { prGateHeld: true })
      return 'foreign gate id'
    }
    return 'remote executed'
  }
  const tools = withPrGate([fixture('webapp_run', run)], t.gate)
  const input = { app: 'Code', tool: 'custom_publish' }
  const held = await tools[0]!.run(input, t.ctx)
  expect(held).toContain('NOT RUN')
  const id = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
  await t.gate.attest(id, proof(), t.ctx)
  expect(await tools[0]!.run(input, t.ctx)).toBe('remote executed')
  expect(grant['_agentPrGateGrant']).toBeDefined()
})
it('isolates concurrent device calls from a capsule already attached to the turn', async () => {
  const t = setup()
  // Simulate an earlier native permission call attaching state to the turn.
  prepareRemoteGrant(t.ctx, 'shell_run', { command: 'old call' })
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let firstEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve
  })
  let goodGrant: unknown
  const tool = withPrGate(
    [
      fixture('device_tool', async (input, ctx) => {
        if ((input['args'] as JsonObject)['command'] === 'gh pr ready 4') {
          firstEntered()
          await wait
          goodGrant = remoteArguments(
            ctx,
            'shell_run',
            input['args'] as JsonObject,
          )['_agentPrGateGrant']
          return 'write ran once'
        }
        remoteArguments(ctx, 'shell_run', input['args'] as JsonObject)
        recordRemoteResult(ctx, { prGateHeld: true })
        release()
        return 'other destination held'
      }),
    ],
    t.gate,
  )[0]!
  const good = {
    device: 'other',
    tool: 'shell_run',
    args: { command: 'gh pr ready 4' },
  }
  const held = await tool.run(good, t.ctx)
  await t.gate.attest(held.match(/Gate id: ([a-f0-9-]+)/)![1]!, proof(), t.ctx)
  const first = tool.run(good, t.ctx)
  await entered
  const second = await tool.run(
    {
      device: 'other',
      tool: 'shell_run',
      args: { command: 'ordinary opaque call' },
    },
    t.ctx,
  )
  expect(await first).toBe('write ran once')
  expect(goodGrant).toBeDefined()
  expect(second).toContain('NOT RUN')
})
it.each(['-e', '-en', '-enc', '-enco', '-encodedcommand', '-ec'])(
  'holds encoded PowerShell prefix %s',
  (prefix) => {
    expect(
      reviewableCall('shell_run', {
        command: 'pwsh ' + prefix + ' ZwBoACAAcAByACAAcgBlAGEAZAB5AA==',
      }),
    ).toBe(true)
  },
)

it('runs a genuinely auto-routed learned call through the origin and destination gates', async () => {
  const t = setup(),
    destination = setup()
  const folder = mkdtempSync(join(tmpdir(), 'pr-gate-round4-'))
  try {
    const learned = new LearnedStore(join(folder, 'apps.json'))
    learned.save({
      id: 'code',
      name: 'Code',
      startUrl: 'https://github.com',
      about: '',
      tools: [],
      trusted: false,
      updatedAt: 0,
    })
    const executed = vi.fn(async () => 'remote mutation completed')
    const target = withPrGate(
      [fixture('webapp_run', executed)],
      destination.gate,
      async (_name, args) => ({ ...args, app: 'GitHub' }),
    )[0]!
    const hub = {
      list: async () => [
        {
          id: 'server',
          name: 'Server',
          kind: 'server',
          self: true,
          online: true,
          tools: ['webapp_run'],
        },
        {
          id: 'desktop',
          name: 'Desktop',
          kind: 'desktop',
          self: false,
          online: true,
          tools: ['webapp_run'],
        },
      ],
      call: async (
        _ref: string,
        name: string,
        args: JsonObject,
        _chat: string,
        ctx: import('@agent/core').ToolContext,
      ) => {
        const sent = remoteArguments(ctx, name, args)
        const { receiveRemoteGrant, takeDestinationHold } =
          await import('../src/main/runtime/pr-gate-remote')
        const received = receiveRemoteGrant(
          testContext({ owner: 'device' }),
          name,
          sent,
        )
        const text = await target.run(received.args, received.context)
        if (takeDestinationHold(received.context))
          recordRemoteResult(ctx, { prGateHeld: true })
        return { ok: true, state: 'done', device: 'Desktop', text }
      },
    } as unknown as DeviceToolHub
    const local = vi.fn(async () => 'Error: Not signed in')
    const routed = withLearnedRoute([fixture('webapp_run', local)], () => hub, {
      learned,
      selfId: () => 'server',
      siteHere: async () => false,
    })
    // The action name is opaque at the origin, and the stored site is known only at destination.
    const origin = withPrGate(routed, t.gate)[0]!
    const input = { app: 'Code', tool: 'squash_and_merge' }
    const held = await origin.run(input, t.ctx)
    expect(held).toContain('NOT RUN')
    expect(executed).not.toHaveBeenCalled()
    const id = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
    expect(await t.gate.attest(id, proof(), t.ctx)).toContain(
      'Attestation recorded',
    )
    expect(await origin.run(input, t.ctx)).toContain(
      'remote mutation completed',
    )
    expect(executed).toHaveBeenCalledOnce()
    expect(local).not.toHaveBeenCalled()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('binds remote grants to canonical tool aliases', async () => {
  const { receiveRemoteGrant, consumeRemoteGrant } =
    await import('../src/main/runtime/pr-gate-remote')
  const origin = testContext(),
    destination = testContext({ owner: 'device' })
  const args = { path: '/tmp/proof.md' }
  prepareRemoteGrant(origin, 'file_send', args)
  const received = receiveRemoteGrant(
    destination,
    'send_file',
    remoteArguments(origin, 'file_send', args),
  )
  expect(consumeRemoteGrant(received.context, 'send_file', received.args)).toBe(
    true,
  )
})
