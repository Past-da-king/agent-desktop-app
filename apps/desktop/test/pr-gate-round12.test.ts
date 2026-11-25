import { afterEach, expect, it } from 'vitest'
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
import { DEFAULT_SETTINGS } from '@agent/core'
import { Store } from '../src/main/db'
import {
  PrGate,
  withPrGate,
  ATTESTATION_FIELDS,
} from '../src/main/runtime/pr-gate'
import {
  ghExecutionEnv,
  withGhExecution,
} from '../src/main/runtime/pr-gate-exec'
import { planPermission } from '../src/main/runtime/cli-host'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
import { codeTools } from '../src/main/tools/code'
import { SecretPassTable, hashPass } from '../src/main/devices/passes'
import { PairingOffers, handlePair } from '../src/main/devices/pairing'
import { BundleKeeper, parseBundle } from '../src/main/devices/bundle'
import { testContext } from './support'
import { prGateHelpers } from './support-pr-gate'
const { cleanup, fixture, attest, child } = prGateHelpers('r12')

it.skipIf(process.platform === 'win32').each([
  [
    'javascript',
    "import { execSync } from 'node:child_process'; const n=19; execSync('gh pr merge '+n, {stdio:'inherit'})",
  ],
  [
    'python',
    "import subprocess\nn=19\nsubprocess.run(['gh','pr','merge',str(n)],check=True)",
  ],
  [
    'python',
    "import subprocess\nsubprocess.run('gh pr merge 19',shell=True,check=True)",
  ],
])(
  'R12 m4 computed gh explicitly directs without pretending to run: %s',
  async (language, code) => {
    const f = fixture()
    const wrapped = withPrGate(
      codeTools({
        tempRoot: f.cwd,
        env: f.env,
        findCommand: (name) =>
          name === 'node'
            ? process.execPath
            : name === 'python3'
              ? '/usr/bin/python3'
              : null,
        settings: { get: () => ({ shell: 'always' }) },
      }),
      f.gate,
    )[0]!
    const result = await wrapped.run({ language, code }, f.ctx)
    expect(result).toContain('Use shell_run')
    expect(result).not.toContain('Gate id:')
    expect(() => readFileSync(f.marker, 'utf8')).toThrow()
  },
)
it.skipIf(process.platform === 'win32')(
  'R12 m4 nonliteral check_call reaches the real scratch shim and converges',
  async () => {
    const f = fixture()
    const wrapped = withPrGate(
      codeTools({
        tempRoot: f.cwd,
        env: f.env,
        findCommand: (name) => (name === 'python3' ? '/usr/bin/python3' : null),
        settings: { get: () => ({ shell: 'always' }) },
      }),
      f.gate,
    )[0]!
    // This dynamically built executable evades only the static outer detector.
    // The real subprocess must hit the execution shim on both attempts.
    const input = {
      language: 'python',
      code: "import subprocess\nexe='g'+'h'\nn=19\nsubprocess.check_call([exe,'pr','merge',str(n)])",
    }
    const held = await wrapped.run(input, f.ctx)
    expect(held).not.toContain('Use shell_run')
    await attest(f, held)
    const result = await wrapped.run(input, f.ctx)
    expect(result).not.toContain('Gate id:')
    expect(result).not.toContain('NOT RUN')
    const recorded = readFileSync(f.marker, 'utf8')
    expect(recorded).toContain('agent-code-')
    expect(recorded).toContain('19')
    expect(await wrapped.run(input, f.ctx)).toContain('Gate id:')
    expect(readFileSync(f.marker, 'utf8')).toBe(recorded)
  },
)
it
  .skipIf(process.platform === 'win32')
  .each(['python3 publish.py', 'cd repo && python3 publish.py'])(
  'R12 m1 native local script binds one execution grant: %s',
  async (command) => {
    const f = fixture()
    const code =
      "import subprocess\nsubprocess.run(['gh','pr','merge','19'],check=True)"
    writeFileSync(join(f.cwd, 'publish.py'), code)
    writeFileSync(join(f.cwd, 'repo', 'publish.py'), code)
    const tools = withPrGate(
      [
        {
          spec: {
            name: 'shell_run',
            description: 'fixture',
            schema: { type: 'object', properties: {} },
          },
          run: async () => '',
        },
      ],
      f.gate,
    )
    const request = { tools, context: f.ctx, workDir: f.cwd }
    const permission = planPermission(
      request,
      () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
      async () => ({ allow: true }),
    )
    const run = () =>
      withGhExecution(f.gate, f.ctx, async () => {
        const decision = await permission('Bash', { command })
        return decision.allow
          ? child(command, f.cwd, f.env)
          : (decision.message ?? 'held')
      })
    await attest(f, await run())
    expect(await run()).toContain('exit:0')
    const recorded = readFileSync(f.marker, 'utf8')
    expect(recorded).toContain('19')
    expect(await run()).toContain('NOT RUN')
    expect(readFileSync(f.marker, 'utf8')).toBe(recorded)
  },
)
it.each([
  "const gh = new Octokit(); gh.pulls.merge({owner:'o',repo:'r',pull_number:19})",
  "# not gh\nimport requests\nrequests.put('https://api.github.com/repos/o/r/pulls/19/merge')",
])(
  'R12 m2 HTTP code with a gh variable or comment can attest: %s',
  async (code) => {
    const f = fixture()
    const held = await f.gate.check(
      'run_code',
      { code, language: 'javascript' },
      f.ctx,
    )
    expect(held).toContain('Gate id:')
    expect(held).not.toContain('Use shell_run')
    await attest(f, held!)
    expect(
      await f.gate.check('run_code', { code, language: 'javascript' }, f.ctx),
    ).toBeNull()
  },
)
it('R12 n1 attached reviewer shorthand is held while draft title values pass', () => {
  expect(
    reviewableCall('shell_run', { command: 'gh pr create -d -rbob' }),
  ).toBe(true)
  expect(
    reviewableCall('shell_run', { command: 'gh pr create -d --title "-rbob"' }),
  ).toBe(false)
})
function memoryPasses() {
  const data = new Map<string, string>()
  let writes = 0
  const table = new SecretPassTable({
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      writes++
      data.set(key, value)
    },
    delete: (key) => {
      writes++
      data.delete(key)
    },
  })
  return { table, writes: () => writes }
}
it('R12 M1 authority versions travel through bundle parsing and reject stale re-pair', () => {
  const a = memoryPasses(),
    b = memoryPasses(),
    id = 'dev_repair_computer'
  a.table.set(id, hashPass('old-pass'), 100)
  a.table.rememberRoles(id, ['brain'], 100)
  a.table.remove(id, 200)
  const oldSnapshot = { ...b.table.all(), [id]: hashPass('old-pass') }
  // A legacy/stale bundle cannot restore the old pass after a deny.
  a.table.replaceAll(oldSnapshot)
  expect(a.table.deviceFor('old-pass')).toBeNull()
  b.table.set(id, hashPass('new-pass'), 300)
  b.table.rememberRoles(id, ['brain'], 300)
  const authority =
    (
      b.table as unknown as { authority?: () => Record<string, unknown> }
    ).authority?.() ?? {}
  const bundle = parseBundle({
    version: 'v',
    changedAt: 400,
    settings: {},
    profiles: [],
    learned: [],
    connected: [],
    secrets: { keys: {}, passes: b.table.all(), pairingAuthority: authority },
  })
  expect(bundle).not.toBeNull()
  expect(bundle!.secrets).toHaveProperty('pairingAuthority')
  a.table.replaceAll(
    bundle!.secrets!.passes,
    (bundle!.secrets as unknown as { pairingAuthority: never })
      .pairingAuthority,
  )
  expect(a.table.deviceFor('new-pass')).toBe(id)
  expect(a.table.rolesFor(id)).toEqual(['brain'])
  expect(a.table.deviceFor('old-pass')).toBeNull()
  a.table.remove(id, 500)
  a.table.replaceAll(
    bundle!.secrets!.passes,
    (bundle!.secrets as unknown as { pairingAuthority: never })
      .pairingAuthority,
  )
  expect(a.table.deviceFor('new-pass')).toBeNull()
})
it('R12 n2 repeated deny observations do not rewrite pass secrets', () => {
  const f = memoryPasses()
  f.table.set('dev_repeat', hashPass('test-pass'), 100)
  f.table.remove('dev_repeat', 200)
  const before = f.writes()
  f.table.remove('dev_repeat', 200)
  f.table.remove('dev_repeat')
  expect(f.writes()).toBe(before)
})
it('R12 n3 pairing saves the active row before issuing the new hash', async () => {
  const f = memoryPasses(),
    id = 'dev_repair_computer'
  f.table.set(id, hashPass('old-pass'), 100)
  f.table.remove(id, 200)
  const offers = new PairingOffers(() => 300),
    offer = offers.create()
  let persisted = false
  const result = await handlePair(
    {
      code: offer.secret,
      nodeId: id,
      wantRoles: ['brain'],
      device: {
        kind: 'desktop',
        platform: 'linux',
        fingerprint: 'f'.repeat(43),
      },
    },
    {
      offers,
      passes: f.table,
      meshId: 'mesh_fixture',
      node: { id: 'dev_host', name: 'Host' },
      now: () => 300,
      nextPriority: async () => 1,
      brains: async () => [],
      saveDevice: async (row) => {
        // A delayed reload of the old taken-out row occurs during the await.
        f.table.remove(id, 200)
        persisted = true
        expect(f.table.all()[id]).toBeUndefined()
        f.table.rememberRoles(id, row.roles, row.pairedAt)
      },
    },
  )
  expect(result.status).toBe(200)
  expect(persisted).toBe(true)
  if (result.status !== 200) throw new Error('pair failed')
  expect(f.table.deviceFor(result.json.pass)).toBe(id)
})

it('R12 M1 real bundle build and apply carry deny and later pairing versions', async () => {
  function brain() {
    const data = new Map<string, string>(),
      local = new Map<string, string>()
    const secrets = {
      get: (key: string) => data.get(key) ?? null,
      set: (key: string, value: string) => {
        data.set(key, value)
      },
      delete: (key: string) => {
        data.delete(key)
      },
    }
    const passes = new SecretPassTable(secrets)
    const keeper = new BundleKeeper({
      settings: {
        get: () => ({ ...DEFAULT_SETTINGS }),
        save: (patch) => ({ ...DEFAULT_SETTINGS, ...patch }),
      },
      secrets,
      passes,
      local: {
        localValue: (key) => local.get(key) ?? null,
        setLocalValue: (key, value) => {
          local.set(key, value)
        },
      },
      now: () => 1000,
    })
    cleanup.push(() => keeper.dispose())
    return { passes, keeper }
  }
  const a = brain(),
    b = brain(),
    id = 'dev_bundle_repair'
  a.passes.set(id, hashPass('old-bundle-pass'), 100)
  a.passes.rememberRoles(id, ['brain'], 100)
  a.passes.remove(id, 200)
  expect(b.keeper.apply(await a.keeper.build(true), true)).toBe(true)
  expect(b.passes.isRevoked(id)).toBe(true)
  b.passes.set(id, hashPass('new-bundle-pass'), 300)
  b.passes.rememberRoles(id, ['brain'], 300)
  const repaired = await b.keeper.build(true)
  expect(repaired.secrets).toHaveProperty('pairingAuthority')
  expect(a.keeper.apply(repaired, true)).toBe(true)
  expect(a.passes.deviceFor('new-bundle-pass')).toBe(id)
  expect(a.passes.rolesFor(id)).toEqual(['brain'])
  expect(a.passes.deviceFor('old-bundle-pass')).toBeNull()
})
