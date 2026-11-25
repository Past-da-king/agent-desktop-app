import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  DEFAULT_SETTINGS,
  SyncClient,
  type Tool,
  type JsonObject,
} from '@agent/core'
import { Store } from '../src/main/db'
import {
  PrGate,
  withPrGate,
  ATTESTATION_FIELDS,
} from '../src/main/runtime/pr-gate'
import {
  withGhExecution,
  ghExecutionEnv,
} from '../src/main/runtime/pr-gate-exec'
import { planPermission } from '../src/main/runtime/cli-host'
import {
  reviewableCall,
  scriptReadNotes,
} from '../src/main/runtime/pr-gate-detect'
import {
  bootstrapPeerAuthority,
  registerSyncRoutes,
} from '../src/main/devices/replicate'
import type { DevicesHost, DevicesRoute } from '../src/main/devices/types'
import { testContext } from './support'
const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
})
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-r10-')),
    marker = join(cwd, 'calls')
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, 'repo'))
  writeFileSync(
    join(cwd, 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "' + marker + '"\n',
    { mode: 0o700 },
  )
  const store = new Store(':memory:')
  cleanup.push(() => store.close())
  return {
    cwd,
    marker,
    gate: new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: true,
    })),
    ctx: testContext({
      commandFallback: { cwd, timeoutSec: 30, outputChars: 10000 },
    }),
  }
}
function child(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd,
      env: ghExecutionEnv({
        HOME: cwd,
        GH_CONFIG_DIR: cwd,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        PATH: cwd + ':/usr/bin:/bin',
      }),
      stdio: 'pipe',
    })
    let output = ''
    proc.stdout.on('data', (chunk) => (output += chunk))
    proc.stderr.on('data', (chunk) => (output += chunk))
    proc.once('error', reject)
    proc.once('close', (code) => resolve('exit:' + code + ' ' + output))
    proc.stdin.end()
  })
}
async function attest(
  gate: PrGate,
  held: string,
  ctx: ReturnType<typeof testContext>,
) {
  const id = held.match(/Gate id: ([a-f0-9-]+)/)?.[1]
  expect(id).toBeTruthy()
  const evidence = Object.fromEntries(
    ATTESTATION_FIELDS.map((field) => [
      field,
      field === 'reviewerAgentId'
        ? 'independent-r10-reviewer'
        : field === 'testProof'
          ? '/tmp/isolated/r10-proof.txt'
          : 'Specific isolated regression evidence for ' + field,
    ]),
  )
  expect(await gate.attest(id!, evidence, ctx)).toContain(
    'Attestation recorded',
  )
}
it
  .skipIf(process.platform === 'win32')
  .each([
    'gh  pr comment 19 --body "Ready for review"',
    'cd repo && gh pr merge 19',
    'gh pr ready 19 && gh pr merge 19',
  ])(
  'R10 B1 end-to-end hold, attest, shim execution once: %s',
  async (command) => {
    const f = fixture()
    const tool: Tool = {
      spec: {
        name: 'shell_run',
        description: 'Fake shell',
        schema: { type: 'object', properties: {} },
      },
      run: async (input) => child(String(input['command']), f.cwd),
    }
    const wrapped = withPrGate([tool], f.gate)[0]!,
      input = { command, cwd: f.cwd }
    const held = await wrapped.run(input, f.ctx)
    await attest(f.gate, held, f.ctx)
    expect(await wrapped.run(input, f.ctx)).toContain('exit:0')
    const recorded = readFileSync(f.marker, 'utf8')
    expect(recorded).toContain('19')
    expect(await wrapped.run(input, f.ctx)).toContain('NOT RUN')
    expect(readFileSync(f.marker, 'utf8')).toBe(recorded)
  },
)
it.skipIf(process.platform === 'win32')(
  'R10 B1 native Bash permission reserves without spending, execution spends once',
  async () => {
    const f = fixture(),
      command = 'gh pr review 19 --approve --body "LGTM, ship it"'
    const tools = withPrGate(
      [
        {
          spec: {
            name: 'shell_run',
            description: 'Fixture',
            schema: { type: 'object', properties: {} },
          },
          run: async () => '',
        },
      ],
      f.gate,
    )
    const permission = planPermission(
      { tools, context: f.ctx, folder: f.cwd },
      () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
      async () => ({ allow: true }),
    )
    const run = () =>
      withGhExecution(f.gate, f.ctx, async () => {
        const decision = await permission('Bash', { command })
        return decision.allow
          ? child(command, f.cwd)
          : (decision.message ?? 'held')
      })
    const held = await run()
    await attest(f.gate, held, f.ctx)
    expect(await run()).toContain('exit:0')
    expect(readFileSync(f.marker, 'utf8')).toContain('LGTM, ship it')
    expect(await run()).toContain('NOT RUN')
  },
)
it.skipIf(process.platform === 'win32')(
  'R10 B1 run_code gh subprocess consumes the same operation grant',
  async () => {
    const f = fixture(),
      code =
        "require('node:child_process').execFileSync('gh', ['pr','merge','19'], {stdio:'inherit'})"
    const tool: Tool = {
      spec: {
        name: 'run_code',
        description: 'Fixture code',
        schema: { type: 'object', properties: {} },
      },
      run: async () => child('node -e ' + JSON.stringify(code), f.cwd),
    }
    const wrapped = withPrGate([tool], f.gate)[0]!,
      input = { code, language: 'javascript' }
    await attest(f.gate, await wrapped.run(input, f.ctx), f.ctx)
    expect(await wrapped.run(input, f.ctx)).toContain('exit:0')
    expect(await wrapped.run(input, f.ctx)).toContain('NOT RUN')
  },
)
it.each([
  [
    'apps_run',
    {
      slug: 'GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST',
      arguments: { event: 'APPROVE' },
    },
  ],
  [
    'browser_act',
    {
      action: 'click',
      name: 'Approve',
      pageUrl: 'https://github.com/o/r/pull/1/files',
    },
  ],
  [
    'browser_click',
    {
      name: 'Submit review',
      pageUrl: 'https://github.com/o/r/pull/1/files',
      _resolvedAction: true,
    },
  ],
  ['webapp_run', { app: 'GitHub', tool: 'approve_pr' }],
  [
    'webapp_run',
    { app: 'GitHub', tool: 'submit_review', args: { event: 'APPROVE' } },
  ],
  ['webapp_run', { app: 'GitHub', tool: 'add_reviewer' }],
  ['shell_run', { command: 'gh pr review 19 -a' }],
  ['shell_run', { command: 'gh pr create --draft --reviewer bob' }],
  ['shell_run', { command: 'gh pr create -d -r bob' }],
] as Array<[string, JsonObject]>)(
  'R10 approvals and draft reviewer notifications hold: %s %j',
  (tool, input) => expect(reviewableCall(tool, input)).toBe(true),
)
it.each([
  'ssh impetix "cd ~/repos/x && git push"',
  'wsl -d Ubuntu -- bash -lc "cd ~/repo && git push"',
  'git -C /does-not-exist push',
  'git push --tags',
])('R10 unresolved feature pushes and tag-only pushes pass: %s', (command) => {
  expect(reviewableCall('shell_run', { command, cwd: '/does-not-exist' })).toBe(
    false,
  )
  if (!command.includes('--tags'))
    expect(
      scriptReadNotes({ command, cwd: '/does-not-exist' }).length,
    ).toBeGreaterThan(0)
})
it('R10 bootstrap reads past the old 100-page cap', async () => {
  const store = new Store(':memory:')
  cleanup.push(() => store.close())
  const source = new Store(':memory:')
  cleanup.push(() => source.close())
  await source.upsert('device', {
    id: source.deviceId,
    fp: 'pin',
    roles: ['brain'],
  })
  const own = source.changesAfter(0).changes[0]!,
    client = new SyncClient('https://peer', 'test-only-pass')
  vi.spyOn(client, 'pull').mockImplementation(async (since) => ({
    changes:
      since < 101
        ? [{ ...own, entity: 'memory', id: 'unrelated' + since }]
        : since === 101
          ? [own]
          : [],
    cursor: since < 102 ? since + 1 : 102,
  }))
  await bootstrapPeerAuthority(store, client, {
    id: source.deviceId,
    name: 'Peer',
    fp: 'pin',
    urls: ['https://peer'],
  })
  expect(await store.get('device', source.deviceId)).not.toBeNull()
})
it('R10 reset host accepts only authenticated self authority with retained pairing roles', async () => {
  const host = new Store(':memory:'),
    joiner = new Store(':memory:')
  cleanup.push(
    () => host.close(),
    () => joiner.close(),
  )
  await joiner.upsert('device', {
    id: joiner.deviceId,
    fp: 'pin',
    roles: ['brain'],
    prGatePublicKey: 'cannot-promote',
  })
  const routes: DevicesRoute[] = []
  registerSyncRoutes(
    {
      addRoute: (route: DevicesRoute) => routes.push(route),
      pairedRoles: () => ['hands'],
    } as unknown as DevicesHost,
    host,
  )
  const route = routes.find((route) => route.method === 'POST')!
  const req = {
    deviceId: joiner.deviceId,
    body: { changes: joiner.changesAfter(0).changes },
    params: {},
    query: new URLSearchParams(),
    signal: new AbortController().signal,
  }
  // A known peer without a row is accepted (an older client, mid-upgrade); only a row it sends is kept.
  const first = await route.handle({ ...req, body: { changes: [] } } as never)
  expect(first.status).toBe(200)
  expect(await host.get('device', joiner.deviceId)).toBeNull()
  const second = await route.handle(req as never)
  expect(second.status).toBe(200)
  expect(await host.get('device', joiner.deviceId)).toMatchObject({
    roles: ['hands'],
  })
  expect(
    (await host.get('device', joiner.deviceId))?.prGatePublicKey,
  ).toBeUndefined()
})

it.each([
  [
    'node',
    'publish.js',
    "require('node:child_process').execFileSync('gh',['pr','merge','19'])",
  ],
  [
    'python3',
    'publish.py',
    "import subprocess\nsubprocess.run(['git','push','origin','HEAD:main'])",
  ],
  [
    'node',
    'publish.js',
    "fetch('https://api.github.com/repos/o/r/pulls/1/reviews',{method:'POST',body:JSON.stringify({event:'APPROVE'})})",
  ],
  [
    'python3',
    'publish.py',
    "import requests\nrequests.post('https://api.github.com/repos/o/r/pulls/1/reviews',json={'event':'APPROVE'})",
  ],
  [
    'npx tsx',
    'publish.ts',
    "octokit.pulls.merge({owner:'o',repo:'r',pull_number:19})",
  ],
] as string[][])(
  'R10 literal script write is inspected: %s %s',
  (exe, file, code) => {
    const f = fixture()
    writeFileSync(join(f.cwd, file!), code!)
    expect(
      reviewableCall('shell_run', { command: exe + ' ' + file, cwd: f.cwd }),
    ).toBe(true)
  },
)
