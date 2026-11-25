import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { DEFAULT_SETTINGS, type Tool, type JsonObject } from '@agent/core'
import { Store } from '../src/main/db'
import {
  ATTESTATION_FIELDS,
  PrGate,
  prGateFor,
  withPrGate,
} from '../src/main/runtime/pr-gate'
import {
  prGateKey,
  PR_GATE_KEY,
  publicKey,
  keyId,
} from '../src/main/runtime/pr-gate-key'
import {
  prepareRemoteGrant,
  remoteArguments,
  receiveRemoteGrant,
  consumeRemoteGrant,
  retryRemoteGrant,
} from '../src/main/runtime/pr-gate-remote'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
import { BundleKeeper } from '../src/main/devices/bundle'
import { testContext } from './support'
const stores: Store[] = [],
  dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function store(path = ':memory:') {
  const s = new Store(path)
  stores.push(s)
  return s
}
function dir(home = false) {
  const d = mkdtempSync(join(home ? homedir() : tmpdir(), '.pr-r5-'))
  dirs.push(d)
  return d
}
const settings = () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true })
function secrets() {
  const m = new Map<string, string>()
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => {
      m.set(k, v)
    },
    delete: (k: string) => {
      m.delete(k)
    },
  }
}
function fixture(run: Tool['run']): Tool {
  return {
    spec: { name: 'shell_run', description: 'fixture', schema: {} },
    run,
  }
}
it.each([
  '# note\ngh pr merge 1',
  '#!/bin/bash\ngh pr merge 1',
  'ls # x; harmless\ngh pr merge 1',
  'ls # x; gh pr merge 1\ngh pr ready 2',
])('proof4 comments stop at the newline: %s', (command) =>
  expect(reviewableCall('shell_run', { command })).toBe(true),
)
it('proof4 same-line shell comment includes the rest of that line', () =>
  expect(
    reviewableCall('shell_run', { command: 'ls # x; gh pr merge 1' }),
  ).toBe(false))
it.each(['echo "# gh pr merge 1"', "echo 'a#b gh pr ready 1'", 'echo a#b'])(
  'proof4 quoted and in-word hashes stay literal: %s',
  (command) => expect(reviewableCall('shell_run', { command })).toBe(false),
)
it('proof4 shebang script reader inspects commands after comments', () => {
  const d = dir()
  writeFileSync(join(d, 'x.sh'), '#!/bin/bash\n# note\ngh pr ready 1\n')
  expect(reviewableCall('shell_run', { command: 'bash x.sh', cwd: d })).toBe(
    true,
  )
  expect(reviewableCall('shell_run', { command: './x.sh', cwd: d })).toBe(true)
})
it.each(['/c', '--command', '/enc', '--enc', '/e', '--encodedcommand'])(
  'R5-m3 normalizes PowerShell switch %s',
  (flag) => {
    const encoded = flag.includes('enc') || flag === '/e'
    const payload = encoded
      ? Buffer.from('gh pr merge 1', 'utf16le').toString('base64')
      : '"gh pr merge 1"'
    expect(
      reviewableCall('shell_run', { command: `powershell ${flag} ${payload}` }),
    ).toBe(true)
  },
)
it('proof4 here-string executes its supplied command', () =>
  expect(
    reviewableCall('shell_run', { command: 'bash <<< "gh pr ready 3"' }),
  ).toBe(true))
it.each([
  'powershell -ExecutionPolicy Bypass -File x.ps1',
  '.\\x.ps1',
  './x.sh',
])('proof4 local script path and parameter operands: %s', (command) => {
  const d = dir()
  for (const f of ['x.ps1', 'x.sh']) writeFileSync(join(d, f), 'gh pr ready 1')
  expect(reviewableCall('shell_run', { command, cwd: d })).toBe(true)
})
it.each(['bare cd', 'cd -', 'popd'])('R5-n4 tracks %s', (mode) => {
  const d = dir(true),
    name = basename(d)
  writeFileSync(join(d, 'x.sh'), 'gh pr merge 1')
  const command =
    mode === 'bare cd'
      ? `cd; bash ${name}/x.sh`
      : mode === 'cd -'
        ? `cd ${d}; cd /tmp; cd -; bash x.sh`
        : `pushd ${d}; pushd /tmp; popd; bash x.sh`
  expect(reviewableCall('shell_run', { command, cwd: tmpdir() })).toBe(true)
})
it('R5-M1 hands-only bundle carries public device rows without a signing secret and executes a brain grant', async () => {
  const brain = store(),
    hands = store(),
    secret = secrets()
  await brain.upsert('device', {
    id: 'brain',
    name: 'brain',
    roles: ['brain'],
    kind: 'desktop',
    platform: 'linux',
  })
  const origin = prGateFor(brain, settings, secret, () => 'brain')
  const privateValue = await origin.signingKey()
  const keeper = new BundleKeeper({
    settings: { get: settings, save: () => {} },
    secrets: secret,
    local: brain,
  })
  const bundle = await keeper.build(false)
  expect(bundle.secrets).toBeUndefined()
  expect(JSON.stringify(bundle)).not.toContain(privateValue)
  // Device rows replicate through the ordinary data channel, independent of private bundles.
  const privateBundle = await keeper.build(true)
  expect(JSON.stringify(privateBundle)).not.toContain(privateValue)
  const row = await brain.get('device', 'brain')
  expect(row?.prGatePublicKey).toBe(publicKey(privateValue))
  await hands.upsert('device', row!)
  const handsSecrets = secrets(),
    destination = prGateFor(hands, settings, handsSecrets, () => 'hands')
  const ctx = testContext({ owner: 'helper:author' }),
    args = { command: 'gh pr ready 1' }
  const run = vi.fn(async () => 'ran')
  const destinationTool = withPrGate([fixture(run)], destination)[0]!
  const remoteTool: Tool = {
    spec: { name: 'device_tool', description: 'fixture', schema: {} },
    run: async (input, call) => {
      const row = await brain.get('device', 'brain')
      await hands.upsert('device', row!)
      const wire = remoteArguments(
        call,
        'shell_run',
        input['args'] as JsonObject,
      )
      const delivery = receiveRemoteGrant(
        testContext({ owner: 'device' }),
        'shell_run',
        wire,
      )
      return destinationTool.run(delivery.args, delivery.context)
    },
  }
  const wrapped = withPrGate([remoteTool], origin)[0]!,
    input = { device: 'hands', tool: 'shell_run', args }
  const held = await wrapped.run(input, ctx)
  expect(held).toContain('NOT RUN')
  const gateId = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
  const proof = Object.fromEntries(
    ATTESTATION_FIELDS.map((field) => [
      field,
      field === 'reviewerAgentId'
        ? 'independent-reviewer'
        : 'Checked /tmp/r5-proof.md: ' + field,
    ]),
  )
  expect(await origin.attest(gateId, proof, ctx)).toContain(
    'Attestation recorded',
  )
  expect(await wrapped.run(input, ctx)).toBe('ran')
  expect(run).toHaveBeenCalledOnce()
  expect(handsSecrets.get(PR_GATE_KEY)).toBeNull()
})
it('R5-m4 rotating one brain public key refuses old grants and accepts new grants', () => {
  const secret = secrets(),
    old = prGateKey(secret),
    args = { command: 'gh pr ready 1' },
    ctx = testContext()
  prepareRemoteGrant(ctx, 'shell_run', args, old)
  const wire = remoteArguments(ctx, 'shell_run', args)
  secret.delete(PR_GATE_KEY)
  const next = prGateKey(secret)
  expect(keyId(publicKey(next))).not.toBe(keyId(publicKey(old)))
  let received = receiveRemoteGrant(testContext(), 'shell_run', wire)
  expect(
    consumeRemoteGrant(
      received.context,
      'shell_run',
      received.args,
      publicKey(next),
    ),
  ).toBe(false)
  prepareRemoteGrant(ctx, 'shell_run', args, next)
  received = receiveRemoteGrant(
    testContext(),
    'shell_run',
    remoteArguments(ctx, 'shell_run', args),
  )
  expect(
    consumeRemoteGrant(
      received.context,
      'shell_run',
      received.args,
      publicKey(next),
    ),
  ).toBe(true)
})
it('R5-m1 a signed-out first hop can re-prepare one grant for the next device', () => {
  const ctx = testContext(),
    args = { app: 'GitHub', tool: 'merge' },
    key = prGateKey()
  prepareRemoteGrant(ctx, 'webapp_run', args, key)
  const first = remoteArguments(ctx, 'webapp_run', args),
    received = receiveRemoteGrant(testContext(), 'webapp_run', first)
  expect(
    consumeRemoteGrant(received.context, 'webapp_run', received.args, key),
  ).toBe(true)
  expect(
    remoteArguments(ctx, 'webapp_run', args)['_agentPrGateGrant'],
  ).toBeUndefined()
  retryRemoteGrant(ctx)
  const second = remoteArguments(ctx, 'webapp_run', args)
  expect((second['_agentPrGateGrant'] as JsonObject)['id']).not.toBe(
    (first['_agentPrGateGrant'] as JsonObject)['id'],
  )
  const next = receiveRemoteGrant(testContext(), 'webapp_run', second)
  expect(consumeRemoteGrant(next.context, 'webapp_run', next.args, key)).toBe(
    true,
  )
})
it('R5-m2 a receipt after database reopen returns already ran without a hold or effect', async () => {
  const path = join(dir(), 'gate.sqlite'),
    key = prGateKey(),
    ctx = testContext(),
    args = { command: 'gh pr ready 1' }
  prepareRemoteGrant(ctx, 'shell_run', args, key)
  const wire = remoteArguments(ctx, 'shell_run', args)
  let database = new Store(path),
    gate = new PrGate(database, settings, Date.now, () => key)
  const first = receiveRemoteGrant(testContext(), 'shell_run', wire)
  expect(await gate.acceptRemote('shell_run', first.args, first.context)).toBe(
    true,
  )
  database.close()
  vi.resetModules()
  const fresh = await import('../src/main/runtime/pr-gate'),
    remote = await import('../src/main/runtime/pr-gate-remote')
  database = store(path)
  gate = new fresh.PrGate(database, settings, Date.now, () => key)
  const replay = remote.receiveRemoteGrant(testContext(), 'shell_run', wire),
    run = vi.fn(async () => 'unsafe')
  expect(
    await fresh
      .withPrGate([fixture(run)], gate)[0]!
      .run(replay.args, replay.context),
  ).toContain('already ran once')
  expect(run).not.toHaveBeenCalled()
  expect(remote.takeDestinationHold(replay.context)).toBe(false)
})
it('R5-n3 repeated review approvals produce one bounded audit note', async () => {
  const database = store(),
    gate = new PrGate(database, settings),
    ctx = testContext()
  for (let i = 0; i < 20; i++)
    expect(
      await gate.check(
        'shell_run',
        { command: 'gh pr review 1 --approve' },
        ctx,
      ),
    ).toBeNull()
  const rows = await database.list('chat_item')
  expect(
    rows.filter((row) => row.text === 'review approval (not gated)'),
  ).toHaveLength(1)
})
