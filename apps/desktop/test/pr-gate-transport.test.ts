import { guardTools } from '../src/main/vault/guard'
import { VaultStore } from '../src/main/vault/store'
import { Secrets } from '../src/main/secrets'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type JsonObject } from '@agent/core'
import { Store } from '../src/main/db'
import { withOrigin, buildWorkerToolset } from '../src/main/runtime/toolset'
import {
  PrGate,
  ATTESTATION_FIELDS,
  withPrGate,
  gateForTools,
} from '../src/main/runtime/pr-gate'
import { DeviceToolHost } from '../src/main/devices/device-tool-host'
import {
  remoteArguments,
  recordRemoteResult,
} from '../src/main/runtime/pr-gate-remote'
import { testContext, toolNamed } from './support'

const tab = vi.hoisted(() => ({
  url: 'https://github.com/o/r/pull/3',
  entries: new Map<
    string,
    {
      url: string
      method: string
      postData: string | null
      hasPostData: boolean
    }
  >(),
}))
vi.mock('../src/main/browser/devtools', async (original) => ({
  ...(await original<typeof import('../src/main/browser/devtools')>()),
  devtoolsOf: async () => ({
    url: () => tab.url,
    network: { get: (id: string) => tab.entries.get(id) ?? null },
    evaluate: async () => ({ ok: true, value: {} }),
    requestBody: async () => null,
  }),
}))
function transportResult(
  ctx: import('@agent/core').ToolContext,
  result: Awaited<ReturnType<DeviceToolHost['run']>>,
): string {
  if (result.ok) recordRemoteResult(ctx, result.value)
  return JSON.stringify(result)
}
const stores: Store[] = []
const wrapperDirs: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  wrapperDirs
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }))
  tab.url = 'https://github.com/o/r/pull/3'
})
const proof = () =>
  Object.fromEntries(
    ATTESTATION_FIELDS.map((key) => [
      key,
      key === 'reviewerAgentId'
        ? 'other-reviewer'
        : 'Evidence /tmp/proof.md checked for ' + key,
    ]),
  )
function setup() {
  const store = new Store(':memory:')
  stores.push(store)
  const settings = {
    ...DEFAULT_SETTINGS,
    prGateEnabled: true,
    shell: 'always' as const,
  }
  return {
    store,
    settings,
    ctx: testContext({
      owner: 'helper:origin',
      agentLabel: 'real-origin',
      chat: 'project-42',
    }),
  }
}
it('uses actual browser origin and replay metadata, never model supplied internal fields', async () => {
  const t = setup(),
    tools = buildWorkerToolset({
      store: t.store,
      settings: { get: () => t.settings },
    })
  const act = toolNamed(tools, 'browser_act'),
    click = toolNamed(tools, 'browser_click'),
    fetch = toolNamed(tools, 'browser_fetch')
  expect(
    await act.run(
      {
        action: 'click',
        name: 'Squash and merge',
        pageUrl: 'https://example.com',
      },
      t.ctx,
    ),
  ).toContain('NOT RUN')
  expect(await click.run({ index: 3 }, t.ctx)).toContain('NOT RUN')
  tab.entries.set('patch', {
    url: 'https://api.github.com/repos/o/r/pulls/3',
    method: 'PATCH',
    postData: '{"draft":false}',
    hasPostData: true,
  })
  tab.entries.set('get', {
    url: 'https://api.github.com/repos/o/r/pulls/3',
    method: 'GET',
    postData: null,
    hasPostData: false,
  })
  expect(
    await fetch.run({ from: 'patch', _resolvedReplay: true }, t.ctx),
  ).toContain('NOT RUN')
  expect(await fetch.run({ from: 'get' }, t.ctx)).not.toContain('NOT RUN')
  expect(
    await fetch.run({ from: 'missing', _resolvedReplay: true }, t.ctx),
  ).toContain('NOT RUN')
  tab.url = 'https://example.com/'
  expect(
    await act.run({ action: 'click', name: 'Squash and merge' }, t.ctx),
  ).not.toContain('NOT RUN')
})
it('attests a device call at origin, carries real identity and consumes exactly once at destination', async () => {
  const origin = setup(),
    destination = setup()
  const sourceGate = new PrGate(origin.store, () => origin.settings),
    targetGate = new PrGate(destination.store, () => destination.settings)
  const executed = vi.fn(async () => 'fake gh ran')
  const destinationTools = productionWrapped(
    withPrGate(
      [
        {
          spec: { name: 'shell_run', description: 'fixture', schema: {} },
          run: executed,
        },
      ],
      targetGate,
    ),
  )
  const host = new DeviceToolHost({
    tools: () => destinationTools,
    context: (signal) =>
      testContext({ signal, owner: 'device', agentLabel: 'device' }),
    shared: () => ({
      browser: true,
      files: true,
      notifications: true,
      approval: true,
      shell: true,
    }),
    inbox: '/tmp',
  })
  let envelope: JsonObject = {}
  const tools = withPrGate(
    [
      {
        spec: { name: 'device_tool', description: 'fixture', schema: {} },
        run: async (input, ctx) => {
          envelope = remoteArguments(
            ctx,
            String(input['tool']),
            input['args'] as JsonObject,
          )
          return transportResult(
            ctx,
            await host.run({
              kind: 'tool',
              id: 'fixture-command',
              tool: input['tool'],
              args: envelope,
              chatId: ctx.chat,
              deadlineMs: 1000,
            }),
          )
        },
      },
    ],
    sourceGate,
  )
  const input = {
    device: 'other-device',
    tool: 'shell_run',
    args: { command: 'gh pr ready 3' },
  }
  const held = await tools[0]!.run(input, origin.ctx)
  expect(held).toContain('NOT RUN')
  expect(executed).not.toHaveBeenCalled()
  const id = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
  await sourceGate.attest(id, proof(), origin.ctx)
  expect(await tools[0]!.run(input, origin.ctx)).toContain('fake gh ran')
  expect(executed).toHaveBeenCalledTimes(1)
  const events = await destination.store.listWhere('chat_item', {
    chat: 'pr-gate-audit',
    kind: 'pr_gate',
  })
  expect(
    events.some(
      (row) => JSON.parse(row.meta).actor === 'helper:origin:project-42',
    ),
  ).toBe(true)
  const replay = await host.run({
    kind: 'tool',
    id: 'replayed',
    tool: 'shell_run',
    args: envelope,
    chatId: 'project-42',
    deadlineMs: 1000,
  })
  // A replay of the same command answers from the durable receipt (round 10) and never runs it again.
  expect(JSON.stringify(replay)).toContain('already ran once')
  expect(executed).toHaveBeenCalledTimes(1)
  expect(await tools[0]!.run(input, origin.ctx)).toContain('NOT RUN')
})

it.each(['device_tool', 'browser_click'])(
  'propagates destination-only hits through %s with production wrappers',
  async (route) => {
    const origin = setup(),
      destination = setup()
    const gate = new PrGate(origin.store, () => origin.settings),
      target = new PrGate(destination.store, () => destination.settings)
    const tools = withPrGate(
      [
        {
          spec: { name: route, description: 'fixture', schema: {} },
          run: async (input, ctx) => {
            const args = remoteArguments(
              ctx,
              'browser_click',
              route === 'device_tool'
                ? (input['args'] as JsonObject)
                : { index: input['index'] },
            )
            const host = new DeviceToolHost({
              tools: () =>
                productionWrapped(
                  withPrGate(
                    [
                      {
                        spec: {
                          name: 'browser_click',
                          description: 'fixture',
                          schema: {},
                        },
                        run: async () => 'clicked',
                      },
                    ],
                    target,
                    async (_name, value) => ({
                      ...value,
                      pageUrl: 'https://github.com/o/r/pull/3',
                    }),
                  ),
                ),
              context: (signal) => testContext({ signal, owner: 'device' }),
              shared: () => ({
                browser: true,
                files: true,
                notifications: true,
                approval: true,
                shell: true,
              }),
              inbox: '/tmp',
            })
            return transportResult(
              ctx,
              await host.run({
                kind: 'tool',
                id: 'browser',
                tool: 'browser_click',
                args,
                chatId: ctx.chat,
                deadlineMs: 1000,
              }),
            )
          },
        },
      ],
      gate,
    )
    const input =
      route === 'device_tool'
        ? { device: 'target', tool: 'browser_click', args: { index: 3 } }
        : { device: 'target', index: 3 }
    const held = await tools[0]!.run(input, origin.ctx)
    const id = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
    expect(await gate.attest(id, proof(), origin.ctx)).toContain('recorded')
    expect(await tools[0]!.run(input, origin.ctx)).toContain('clicked')
    expect(await tools[0]!.run(input, origin.ctx)).toContain('NOT RUN')
  },
)

function productionWrapped(
  tools: import('@agent/core').Tool[],
): import('@agent/core').Tool[] {
  const folder = mkdtempSync(join(tmpdir(), 'gate-wrapper-'))
  const vault = new VaultStore(
    new Secrets(
      join(folder, 'secrets'),
      new FileKeyCipher(join(folder, 'key')),
    ),
  )
  wrapperDirs.push(folder)
  return guardTools(withOrigin(tools), vault)
}
