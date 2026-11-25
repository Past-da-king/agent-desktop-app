import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Script } from 'node:vm'
import { DEFAULT_SETTINGS, type ToolContext } from '@agent/core'
import { Store } from '../src/main/db'
import { PrGate, prGateFor } from '../src/main/runtime/pr-gate'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
import { testContext } from './support'
const folders: string[] = [],
  stores: Store[] = []
afterEach(() => {
  vi.restoreAllMocks()
  stores.splice(0).forEach((store) => store.close())
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }))
})
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-r7-'))
  folders.push(dir)
  return dir
}
function database(offset = 0) {
  const store = new Store(':memory:', () => Date.now() + offset)
  stores.push(store)
  return store
}
const settings = () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true })
it.each([
  "$b = @'\nIt's ready.\n'@\n# post it\ngh pr ready 19",
  '$b = @"\nan unmatched " and # hash\n"@\n# post it\ngh pr merge 1',
  "ls 'C:\\Users\\'\ngh pr merge 1",
  '# a \\\ngh pr merge 1',
  "Write-Host '<#' ; gh pr merge 1 ; Write-Host '#>'",
  'echo "use <<EOF for docs"\ngh pr merge 1\nEOF',
  "cat <<A <<B\nbody\nA\nIt's ready\nB\n# post\ngh pr ready 19",
  "bash <<< $'gh pr merge 1'",
  'bash <<< gh\\ pr\\ merge\\ 1',
  'bash -c "$(echo gh pr merge 1)"',
  'powershell gh pr merge 1',
  'powershell "gh pr merge 1"',
  'powershell -nop "gh pr merge 1"',
  'git push origin HEAD',
  'curl https://api.github.com/graphql --data @payload.json',
  'unknown --unknown github.com/o/r',
])('R7 fail-closed opaque shell: %s', (command) => {
  expect(reviewableCall('shell_run', { command })).toBe(true)
  expect(reviewableCall('PowerShell', { command })).toBe(true)
})
it.each([
  '-co',
  '-com',
  '-comm',
  '-comma',
  '-comman',
  '-cwa',
  '-w hidden -c',
  '-if text -c',
  '-of text -c',
  '-configurationfile x -c',
  '-token x -c',
  '-Unknown x -c',
])(
  'R7-M1 ordered PowerShell option or unresolved sensitive invocation holds: %s',
  (prefix) =>
    expect(
      reviewableCall('shell_run', {
        command: `pwsh ${prefix} "gh pr merge 1"`,
      }),
    ).toBe(true),
)
it('R7-B2 PowerShell script files fail closed with here-string data', () => {
  const cwd = folder()
  writeFileSync(
    join(cwd, 'publish.ps1'),
    "$b = @'\nIt's ready # hash\n'@\n# publish\ngh pr ready 19",
  )
  expect(
    reviewableCall('shell_run', { command: 'pwsh -File publish.ps1', cwd }),
  ).toBe(true)
})
it.each([
  'git status',
  'git pull --ff-only',
  'git commit -m "Fix preferences"',
  'git diff --check',
  'git fetch origin',
  'git log --oneline -5',
  'npm ci',
  'npm run typecheck',
  'npm test -- --runInBand',
  'npm run build',
  'pnpm install --frozen-lockfile',
  'pnpm test',
  'pnpm -r build',
  '~/bin/build-slot npm run build',
  'ssh impetix hostname',
  'ssh impetix "cd /tmp && pwd"',
  'python3 /tmp/convert.py',
  'node scripts/build-headless.mjs',
  'ls -la',
  'pwd',
  'Get-ChildItem',
  'Get-Content package.json',
  'pwsh -NoProfile -c "Write-Output hello"',
  'bash -lc "npm run build"',
  'git branch --show-current',
  'gh pr list --state open',
  'gh pr view 19 --json headRefOid,isDraft',
  'gh issue view 7',
  'gh pr checks 19',
  'gh pr review 19 --approve',
  'gh pr ready 19 --undo',
  'command -v gh',
  'which gh',
  'pwsh -co "gh pr view 19"',
  'powershell -w hidden -c "gh pr list"',
  'gh api repos/o/r/pulls',
  'gh pr create --draft --title "Work in progress" --body "Draft only"',
  'echo "gh pr merge 1"',
])(
  'R7 everyday development and proven-safe gh commands pass: %s',
  (command) => {
    expect(reviewableCall('shell_run', { command })).toBe(false)
  },
)
it('R7-B1 unknown authority sender rejects its page before a caller can advance its cursor', async () => {
  const host = database(),
    joined = database()
  await host.upsert('device', {
    id: host.deviceId,
    roles: ['brain'],
    prGatePublicKey: 'host-key',
  })
  const changes = host.changesAfter(0).changes
  await expect(joined.applyRemote(changes, host.deviceId)).rejects.toThrow(
    'not bootstrapped',
  )
  expect(joined.logSeq()).toBe(0)
  await joined.upsert('device', { id: host.deviceId, roles: ['brain'] })
  await joined.applyRemote(changes, host.deviceId)
  expect((await joined.get('device', host.deviceId))?.prGatePublicKey).toBe(
    'host-key',
  )
})
it('R7-m5 concurrent rename/order and signing-key publication merge across two replicas', async () => {
  const a = database(),
    b = database(5000),
    id = 'brain'
  await a.upsert('device', {
    id,
    roles: ['brain'],
    name: 'Before',
    priority: 1,
  })
  await b.applyRemote(a.changesAfter(0).changes)
  const aStart = a.logSeq(),
    bStart = b.logSeq()
  await a.upsert('device', { id, prGatePublicKey: 'new-key' })
  await b.upsert('device', { id, name: 'After', priority: 7, roles: ['hands'] })
  const fromA = a.changesAfter(aStart).changes,
    fromB = b.changesAfter(bStart).changes
  await a.applyRemote(fromB)
  await b.applyRemote(fromA)
  for (const store of [a, b]) {
    expect(await store.get('device', id)).toMatchObject({
      name: 'After',
      priority: 7,
      roles: ['hands'],
      prGatePublicKey: 'new-key',
    })
  }
})
it('R7-m6 rotation requires explicit consent and audits decline and success', async () => {
  const store = database(),
    secretValues = new Map<string, string>()
  const secret = {
    get: (key: string) => secretValues.get(key) ?? null,
    set: (key: string, value: string) => {
      secretValues.set(key, value)
    },
  }
  await store.upsert('device', { id: 'brain', roles: ['brain'] })
  const gate = prGateFor(store, settings, secret, () => 'brain')
  await gate.signingKey()
  const before = new Map(secretValues),
    rotate = gate
      .tools()
      .find((tool) => tool.spec.name === 'pr_gate_rotate_key')!
  const refuse = vi.fn(async () => false)
  expect(await rotate.run({}, testContext({ approve: refuse }))).toContain(
    'declined',
  )
  expect(refuse).toHaveBeenCalledOnce()
  expect(secretValues).toEqual(before)
  const approve = vi.fn(async () => true)
  expect(await rotate.run({}, testContext({ approve }))).toContain('rotated')
  expect(approve).toHaveBeenCalledOnce()
  expect(secretValues).not.toEqual(before)
  const audits = (await store.list('chat_item')).filter(
    (row) => row.kind === 'pr_gate' && row.meta?.includes('pr_gate_rotate_key'),
  )
  expect(audits).toHaveLength(2)
})
function child(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  stdin = '',
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const process = spawn('/bin/bash', ['-c', command], {
        env,
        cwd,
        stdio: 'pipe',
      })
      let stdout = '',
        stderr = ''
      process.stdout.on('data', (chunk) => (stdout += chunk))
      process.stderr.on('data', (chunk) => (stderr += chunk))
      process.once('error', reject)
      process.once('close', (code) => resolve({ code, stdout, stderr }))
      process.stdin.end(stdin)
    },
  )
}
it('R7 execution program compiles as standalone child JavaScript', async () => {
  const { GH_EXEC_PROGRAM } = await import('../src/main/runtime/pr-gate-exec')
  expect(() => new Script(GH_EXEC_PROGRAM)).not.toThrow()
})
it
  .skipIf(process.platform === 'win32')
  .each(['bash --noprofile --norc -c', 'bash --noprofile --norc -lc'])(
  'R7 shim checks a computed wrapper at execution time before real gh: %s',
  async (wrapper) => {
    const { withGhExecution, ghExecutionEnv } =
      await import('../src/main/runtime/pr-gate-exec')
    const cwd = folder(),
      marker = join(cwd, 'ran')
    writeFileSync(join(cwd, 'gh'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o700,
    })
    const gate = new PrGate(database(), settings),
      check = vi
        .spyOn(gate, 'check')
        .mockResolvedValue('HELD BY EXECUTION GATE')
    const env = {
      HOME: cwd,
      GH_CONFIG_DIR: cwd,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      PATH: cwd + ':/usr/bin:/bin',
    }
    const result = await withGhExecution(gate, testContext(), () =>
      child(`${wrapper} "$(echo gh pr merge 1)"`, ghExecutionEnv(env), cwd),
    )
    expect(check).toHaveBeenCalledWith(
      'shell_run',
      expect.objectContaining({ command: 'gh pr merge 1', cwd }),
      expect.anything(),
    )
    expect(result.code).toBe(75)
    expect(result.stderr).toContain('HELD BY EXECUTION GATE')
    expect(existsSync(marker)).toBe(false)
  },
)
it.skipIf(process.platform === 'win32')(
  'R7 shim forwards stdin, stdout and real gh exit code without recursive lookup',
  async () => {
    const { withGhExecution, ghExecutionEnv } =
      await import('../src/main/runtime/pr-gate-exec')
    const cwd = folder()
    writeFileSync(
      join(cwd, 'gh'),
      '#!/bin/sh\nprintf "args:%s:%s\\n" "$1" "$2"\n/bin/cat\nexit 23\n',
      { mode: 0o700 },
    )
    const gate = new PrGate(database(), settings)
    vi.spyOn(gate, 'check').mockResolvedValue(null)
    const result = await withGhExecution(gate, testContext(), () =>
      child(
        'gh pr view',
        ghExecutionEnv({
          HOME: cwd,
          GH_CONFIG_DIR: cwd,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          PATH: cwd + ':/usr/bin:/bin',
        }),
        cwd,
        'stdin bytes\n',
      ),
    )
    expect(result).toEqual({
      code: 23,
      stdout: 'args:pr:view\nstdin bytes\n',
      stderr: '',
    })
  },
)

it('R7-n2 an ungated routed learned read keeps its existing execution behavior', async () => {
  const { LearnedStore } = await import('../src/main/apps/store')
  const { withLearnedRoute } = await import('../src/main/devices/learned-route')
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
  const run = vi.fn(async () => 'read completed')
  const routed = withLearnedRoute(
    [{ spec: { name: 'webapp_run', description: 'fixture', schema: {} }, run }],
    () => null,
    { learned, selfId: () => 'hands', siteHere: async () => false },
  )[0]!
  expect(
    await routed.run(
      { app: 'GitHub', tool: 'read' },
      testContext({ owner: 'device:brain' }),
    ),
  ).toBe('read completed')
  expect(run).toHaveBeenCalledOnce()
})

it('R7-n2 an ungated routed learned read keeps its existing execution behavior', async () => {
  const { LearnedStore } = await import('../src/main/apps/store')
  const { withLearnedRoute } = await import('../src/main/devices/learned-route')
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
  const run = vi.fn(async () => 'read completed')
  const routed = withLearnedRoute(
    [{ spec: { name: 'webapp_run', description: 'fixture', schema: {} }, run }],
    () => null,
    { learned, selfId: () => 'hands', siteHere: async () => false },
  )[0]!
  expect(
    await routed.run(
      { app: 'GitHub', tool: 'read' },
      testContext({ owner: 'device:brain' }),
    ),
  ).toBe('read completed')
  expect(run).toHaveBeenCalledOnce()
})

it('R7-n1 authority fields use their plain name and rotation uses the static key module', () => {
  const db = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
  const gate = readFileSync(
    new URL('../src/main/runtime/pr-gate.ts', import.meta.url),
    'utf8',
  )
  expect(db).not.toMatch(/\['rev'\s*\+\s*'oked'\]/)
  expect(gate).not.toContain("await import('./pr-gate-key')")
})
it('R7-n4 one command normalizer handles continuations, Windows invocation and line boundaries', async () => {
  const { commandSource } = await import('../src/main/runtime/pr-gate-detect')
  expect(commandSource('gh pr view 1\\\n --json title')).toBe(
    'gh pr view 1 --json title',
  )
  expect(
    commandSource('& "C:\\bin\\gh.exe" pr comment 1 --body-file body.md'),
  ).toBe('gh pr comment 1 --body-file body.md')
  expect(commandSource('echo x\n# a comment\necho y')).toBe('echo x;;echo y')
})
