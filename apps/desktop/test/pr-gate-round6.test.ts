import { afterEach, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SETTINGS, type Tool, type JsonObject } from '@agent/core'
import { Store } from '../src/main/db'
import {
  PrGate,
  prGateFor,
  withPrGate,
  ATTESTATION_FIELDS,
} from '../src/main/runtime/pr-gate'
import {
  reviewableCall,
  bodyFileSignature,
} from '../src/main/runtime/pr-gate-detect'
import {
  prGateKey,
  publicKey,
  PR_GATE_KEY,
} from '../src/main/runtime/pr-gate-key'
import {
  prepareRemoteGrant,
  remoteArguments,
  receiveRemoteGrant,
  takeDestinationHold,
} from '../src/main/runtime/pr-gate-remote'
import { testContext } from './support'
const stores: Store[] = [],
  folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  stores.splice(0).forEach((s) => s.close())
  folders.splice(0).forEach((f) => rmSync(f, { recursive: true, force: true }))
})
function database(offset = 0) {
  const s = new Store(':memory:', () => Date.now() + offset)
  stores.push(s)
  return s
}
function folder() {
  const f = mkdtempSync(join(tmpdir(), 'pr-r6-'))
  folders.push(f)
  return f
}
const settings = () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true })
const evidence = () =>
  Object.fromEntries(
    ATTESTATION_FIELDS.map((f) => [
      f,
      f === 'reviewerAgentId'
        ? 'independent-reviewer'
        : 'Checked /tmp/pr-r6-proof.md: ' + f,
    ]),
  )
function secrets() {
  const values = new Map<string, string>()
  return {
    get: (n: string) => values.get(n) ?? null,
    set: (n: string, v: string) => {
      values.set(n, v)
    },
  }
}
function tool(name: string, run: Tool['run']): Tool {
  return { spec: { name, description: 'fixture', schema: {} }, run }
}
it('R6-B1 loads the gate module and its transport without duplicate declarations', async () => {
  const gate = await import('../src/main/runtime/pr-gate'),
    remote = await import('../src/main/runtime/pr-gate-remote')
  expect(gate.PrGate).toBeTypeOf('function')
  expect(remote.receiveRemoteGrant).toBeTypeOf('function')
})
it.each(["It's ready.", 'an unbalanced " quote', 'a # hash and " quote'])(
  'R6-B2 heredoc data cannot change trailing shell parsing: %s',
  (body) => {
    const command = `cat > /tmp/body.md <<'EOF'\n${body}\nEOF\n# post it\ngh pr ready 19`
    expect(reviewableCall('shell_run', { command })).toBe(true)
    const file = join(folder(), 'run.sh')
    writeFileSync(file, command)
    expect(reviewableCall('shell_run', { command: `bash ${file}` })).toBe(true)
  },
)
it('R6-B2 heredoc apostrophe cannot hide an in-word URL hash', () =>
  expect(
    reviewableCall('shell_run', {
      command: `cat <<'EOF'\nIt's ready.\nEOF\ngh pr comment https://github.com/o/r/pull/1#issuecomment-1 --body "Ready for review"`,
    }),
  ).toBe(true))
it('R6-B2 ANSI C quoting preserves escaped apostrophes before a later comment', () =>
  expect(
    reviewableCall('shell_run', {
      command: "echo $'it\\'s'\n# c\ngh pr merge 1",
    }),
  ).toBe(true))
it.each([
  '-NoProfile -NonInteractive -Command',
  '-ExecutionPolicy Bypass -Command',
  '-ConfigurationName x -Command',
  '-ep Bypass -c',
  '/NoProfile --NonInteractive /c',
])('R6-M1 PowerShell option scanner reaches its command: %s', (prefix) =>
  expect(
    reviewableCall('shell_run', {
      command: `powershell ${prefix} "gh pr merge 1"`,
    }),
  ).toBe(true),
)
it.each([
  '-ExecutionPolicy Bypass -File',
  '-ep Bypass -File',
  '-ConfigurationName x -File',
])('R6-M1 PowerShell operand options do not hide files: %s', (prefix) => {
  const cwd = folder()
  writeFileSync(join(cwd, 'x.ps1'), 'gh pr merge 1')
  expect(
    reviewableCall('shell_run', { command: `powershell ${prefix} x.ps1`, cwd }),
  ).toBe(true)
})
it.each([
  ['-NonInteractive', true],
  ['-ExecutionPolicy', false],
  ['-ConfigurationName', false],
  ['-co', true],
  ['-comm', true],
] as const)(
  'R6-M1 ordered prefixes and known non-command operands: %s',
  (flag, held) =>
    expect(
      reviewableCall('shell_run', { command: `pwsh ${flag} "gh pr merge 1"` }),
    ).toBe(held),
)
it('R6-M2 attested local browser call works with Devices off and no device row', async () => {
  const gate = prGateFor(database(), settings, secrets(), () => ''),
    ctx = testContext({ owner: 'helper:author' }),
    run = vi.fn(async () => 'local done')
  const wrapped = withPrGate([tool('browser_click', run)], gate)[0]!,
    input = {
      name: 'Ready for review',
      pageUrl: 'https://github.com/o/r/pull/1',
      _resolvedAction: true,
    }
  const held = await wrapped.run(input, ctx),
    id = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
  expect(await gate.attest(id, evidence(), ctx)).toContain(
    'Attestation recorded',
  )
  expect(await wrapped.run(input, ctx)).toBe('local done')
  expect(run).toHaveBeenCalledOnce()
})
it.each([0, 25 * 60_000])(
  'R6-m1 consumed grant replay answers already ran after %s ms',
  async (elapsed) => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const key = prGateKey(),
      ctx = testContext(),
      args = { command: 'gh pr ready 1' },
      store = database(),
      gate = new PrGate(
        store,
        settings,
        () => now,
        () => key,
      )
    prepareRemoteGrant(ctx, 'shell_run', args, key)
    const wire = remoteArguments(ctx, 'shell_run', args)
    const first = receiveRemoteGrant(testContext(), 'shell_run', wire)
    expect(
      await gate.acceptRemote('shell_run', first.args, first.context),
    ).toBe(true)
    now += elapsed
    const received = receiveRemoteGrant(testContext(), 'shell_run', wire),
      run = vi.fn(async () => 'unsafe')
    expect(
      await withPrGate([tool('shell_run', run)], gate)[0]!.run(
        received.args,
        received.context,
      ),
    ).toContain('already ran once')
    expect(run).not.toHaveBeenCalled()
    expect(takeDestinationHold(received.context)).toBe(false)
  },
)
it('R6-m2 hands peers cannot promote roles or replace a brain verification key through replication', async () => {
  const destination = database(),
    sender = database(10000),
    id = sender.deviceId
  await destination.upsert('device', { id, name: 'hands', roles: ['hands'] })
  await destination.upsert('device', {
    id: 'brain',
    roles: ['brain'],
    prGatePublicKey: 'original',
  })
  await sender.upsert('device', {
    id,
    name: 'hands',
    roles: ['brain'],
    prGatePublicKey: 'forged',
  })
  await sender.upsert('device', {
    id: 'brain',
    roles: ['brain'],
    prGatePublicKey: 'replacement',
  })
  await destination.applyRemote(sender.changesAfter(0).changes, id)
  expect((await destination.get('device', id))!.roles).toEqual(['hands'])
  expect((await destination.get('device', 'brain'))!.prGatePublicKey).toBe(
    'original',
  )
})
it('R6-m2 only brains publish signing keys and key publication preserves concurrent metadata', async () => {
  const db = database(),
    secret = secrets()
  await db.upsert('device', { id: 'self', name: 'hands', roles: ['hands'] })
  const gate = prGateFor(db, settings, secret, () => 'self')
  expect(await gate.signingKey()).toBeUndefined()
  expect(secret.get(PR_GATE_KEY)).toBeNull()
  await db.upsert('device', {
    id: 'self',
    name: 'renamed',
    priority: 7,
    roles: ['brain'],
  })
  expect(await gate.signingKey()).toBeTruthy()
  const row = await db.get('device', 'self')
  expect(row!.name).toBe('renamed')
  expect(row!.priority).toBe(7)
})
it('R6-m3 rotation tool republishes a key and the hands verifier rejects old grants', async () => {
  const brain = database(),
    hands = database(),
    secret = secrets()
  await brain.upsert('device', { id: 'brain', roles: ['brain'] })
  const origin = prGateFor(brain, settings, secret, () => 'brain'),
    destination = prGateFor(hands, settings, secrets(), () => 'hands')
  const old = (await origin.signingKey())!,
    args = { command: 'gh pr ready 1' },
    ctx = testContext()
  prepareRemoteGrant(ctx, 'shell_run', args, old)
  const oldWire = remoteArguments(ctx, 'shell_run', args)
  const rotate = origin
    .tools()
    .find((t) => t.spec.name === 'pr_gate_rotate_key')!
  expect(
    await rotate.run({}, testContext({ ...ctx, approve: async () => true })),
  ).toContain('rotated and public key published')
  const row = (await brain.get('device', 'brain'))!
  await hands.upsert('device', row)
  expect(row.prGatePublicKey).not.toBe(publicKey(old))
  const rejected = receiveRemoteGrant(testContext(), 'shell_run', oldWire)
  expect(
    await destination.acceptRemote(
      'shell_run',
      rejected.args,
      rejected.context,
    ),
  ).toBe(false)
  prepareRemoteGrant(ctx, 'shell_run', args, secret.get(PR_GATE_KEY)!)
  const accepted = receiveRemoteGrant(
    testContext(),
    'shell_run',
    remoteArguments(ctx, 'shell_run', args),
  )
  expect(
    await destination.acceptRemote(
      'shell_run',
      accepted.args,
      accepted.context,
    ),
  ).toBe(true)
})
it.each(['<# note #> gh pr merge 1', 'pwsh -c "<# note #> gh pr ready 1"'])(
  'R6-m5 inline PowerShell block comments retain following operations: %s',
  (command) => expect(reviewableCall('PowerShell', { command })).toBe(true),
)
it('R6-m6 native comment-body signature covers a commented command and changes with the file', () => {
  const cwd = folder(),
    file = join(cwd, 'b.md'),
    input = { command: '# note\ngh pr comment 1 --body-file b.md', cwd }
  writeFileSync(file, 'Ready for review first')
  const first = bodyFileSignature(input)
  writeFileSync(file, 'Ready for review changed')
  expect(bodyFileSignature(input)).not.toBe(first)
  expect(first).toHaveLength(64)
})

it('R6-m3 public key publishes at startup before the first gated call', async () => {
  const db = database(),
    secret = secrets()
  await db.upsert('device', { id: 'brain', roles: ['brain'] })
  prGateFor(db, settings, secret, () => 'brain')
  await vi.waitFor(async () =>
    expect((await db.get('device', 'brain'))!.prGatePublicKey).toContain(
      'PUBLIC KEY',
    ),
  )
})

it('R6-n6 sign-in preflight marks a structured refusal before a verified gated learned tool runs', async () => {
  const { LearnedStore } = await import('../src/main/apps/store')
  const { withLearnedRoute } = await import('../src/main/devices/learned-route')
  const { takeNotSignedIn } = await import('../src/main/runtime/pr-gate-remote')
  const learned = new LearnedStore(join(folder(), 'apps.json'))
  learned.save({
    id: 'github',
    name: 'GitHub',
    startUrl: 'https://github.com',
    about: '',
    tools: [],
    trusted: false,
    updatedAt: 0,
  })
  const key = prGateKey(),
    args = { app: 'GitHub', tool: 'merge' }
  const origin = testContext({ owner: 'helper:author' })
  prepareRemoteGrant(origin, 'webapp_run', args, key)
  const received = receiveRemoteGrant(
    testContext({ owner: 'device:brain' }),
    'webapp_run',
    remoteArguments(origin, 'webapp_run', args),
  )
  const gate = new PrGate(database(), settings, Date.now, () => key)
  expect(
    await gate.acceptRemote('webapp_run', received.args, received.context),
  ).toBe(true)
  const run = vi.fn(async () => 'unsafe')
  const routed = withLearnedRoute([tool('webapp_run', run)], () => null, {
    learned,
    selfId: () => 'hands',
    siteHere: async () => false,
  })[0]!
  expect(await routed.run(args, received.context)).toContain(
    'Error: Not signed in',
  )
  expect(run).not.toHaveBeenCalled()
  expect(takeNotSignedIn(received.context)).toBe(true)
})

it('R6-m2 a trusted brain can demote a row while its old public key is retained', async () => {
  const destination = database(),
    sender = database(10000),
    id = sender.deviceId
  await destination.upsert('device', { id, roles: ['brain'] })
  await destination.upsert('device', {
    id: 'other',
    roles: ['brain'],
    prGatePublicKey: 'old',
  })
  await sender.upsert('device', {
    id: 'other',
    roles: ['hands'],
    prGatePublicKey: 'old',
  })
  await destination.applyRemote(sender.changesAfter(0).changes, id)
  expect((await destination.get('device', 'other'))!.roles).toEqual(['hands'])
})
