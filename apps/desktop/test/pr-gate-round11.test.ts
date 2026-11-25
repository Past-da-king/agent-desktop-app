import { afterEach, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DEFAULT_SETTINGS, type Tool } from '@agent/core'
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
import {
  ghOperations,
  ghExecutionKey,
} from '../src/main/runtime/pr-gate-execution-key'
import { planPermission } from '../src/main/runtime/cli-host'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
import { codeTools } from '../src/main/tools/code'
import * as execution from '../src/main/runtime/pr-gate-exec'
import { testContext } from './support'
import { prGateHelpers } from './support-pr-gate'
const { cleanup, fixture, attest, child } = prGateHelpers('r11')
it
  .skipIf(process.platform === 'win32')
  .each([
    'gh pr merge 19 2>&1',
    'gh pr merge 19 2>/dev/null',
    'GH_REPO=o/r gh pr merge 19',
    'env GH_REPO=o/r gh pr merge 19',
    'timeout 60 gh pr merge 19',
  ])(
  'N1 native turn without a project folder passes once: %s',
  async (command) => {
    const f = fixture()
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
    // Real engine private work directory, rather than the app process cwd.
    const request = { tools, context: f.ctx, workDir: f.cwd }
    const permission = planPermission(
      request,
      () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
      async () => ({ allow: true }),
    )
    const run = () =>
      withGhExecution(f.gate, f.ctx, async () => {
        const decision = await permission('Bash', { command })
        // Earlier successful cd in the persistent engine shell.
        return decision.allow
          ? child(command, join(f.cwd, 'repo'), f.env)
          : (decision.message ?? 'held')
      })
    await attest(f, await run())
    expect(await run()).toContain('exit:0')
    const recorded = readFileSync(f.marker, 'utf8')
    expect(recorded).toContain(join(f.cwd, 'repo'))
    expect(await run()).toContain('NOT RUN')
    expect(readFileSync(f.marker, 'utf8')).toBe(recorded)
  },
)
it.each([
  'gh pr merge 19 2>&1',
  'gh pr merge 19 2>/dev/null',
  'VAR=x gh pr merge 19',
  'env X=y gh pr merge 19',
  'timeout 60 gh pr merge 19',
  'sudo gh pr merge 19',
  'nohup gh pr merge 19',
])('N1 parses the same executed argv: %s', (command) => {
  expect(ghOperations('shell_run', { command, cwd: '/tmp' }, '/tmp')).toEqual([
    ghExecutionKey(['pr', 'merge', '19'], '/tmp'),
  ])
})
it.skipIf(process.platform === 'win32')(
  'm5 execution keys canonicalize symlinks without changing argv',
  () => {
    const f = fixture(),
      alias = join(f.cwd, 'alias')
    symlinkSync(join(f.cwd, 'repo'), alias, 'dir')
    expect(
      ghOperations(
        'shell_run',
        { command: 'cd alias && gh pr merge 19', cwd: f.cwd },
        f.cwd,
      ),
    ).toEqual([ghExecutionKey(['pr', 'merge', '19'], join(f.cwd, 'repo'))])
    expect(ghExecutionKey(['pr', 'merge', '19'], alias)).toBe(
      ghExecutionKey(['pr', 'merge', '19'], join(f.cwd, 'repo')),
    )
  },
)
it.skipIf(process.platform === 'win32').each([
  [
    'javascript',
    "import { execFileSync } from 'node:child_process'; execFileSync('gh',['pr','merge','19'], {stdio:'inherit'})",
  ],
  [
    'python',
    "import subprocess\nsubprocess.run(['gh','pr','merge','19'],check=True)",
  ],
])(
  'm1 m5 real scratch run_code converges across fresh cwd: %s %s',
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
    const input = { language, code }
    // Every case in this table must execute through the real scratch shim.
    let output = await wrapped.run(input, f.ctx)
    expect(output).not.toContain('Use shell_run')
    for (
      let attempt = 0;
      output.includes('Gate id:') && attempt < 2;
      attempt++
    ) {
      await attest(f, output)
      output = await wrapped.run(input, f.ctx)
    }
    expect(output).not.toContain('Gate id:')
    expect(output).not.toContain('NOT RUN')
    expect(readFileSync(f.marker, 'utf8')).toContain('19')
    expect(readFileSync(f.marker, 'utf8')).toContain('agent-code-')
    const recorded = readFileSync(f.marker, 'utf8')
    expect(await wrapped.run(input, f.ctx)).toContain('Gate id:')
    expect(readFileSync(f.marker, 'utf8')).toBe(recorded)
  },
)
it.skipIf(process.platform === 'win32')(
  'm3 unexecuted gh reservation ends with its shell call',
  async () => {
    const f = fixture()
    const tool: Tool = {
      spec: {
        name: 'shell_run',
        description: 'Fixture',
        schema: { type: 'object', properties: {} },
      },
      run: async () => 'shell ended before gh',
    }
    const wrapped = withPrGate([tool], f.gate)[0]!,
      input = { command: 'gh pr merge 19', cwd: f.cwd }
    await attest(f, await wrapped.run(input, f.ctx))
    expect(await wrapped.run(input, f.ctx)).toBe('shell ended before gh')
    expect(await wrapped.run(input, f.ctx)).toContain('NOT RUN')
  },
)
it('m2 holds submitting an APPROVE review but passes a comment submission', () => {
  const slug = 'GITHUB_SUBMIT_A_REVIEW_FOR_A_PULL_REQUEST'
  expect(
    reviewableCall('apps_run', { slug, arguments: { event: 'APPROVE' } }),
  ).toBe(true)
  expect(
    reviewableCall('apps_run', {
      slug,
      arguments: { event: 'COMMENT', body: 'Thanks' },
    }),
  ).toBe(false)
})
it.each([
  'gh pr create --draft --title "-rc1"',
  'gh pr create --draft --body "-r flag example"',
])('n2 draft flag values pass: %s', (command) => {
  expect(reviewableCall('shell_run', { command })).toBe(false)
})
it('n2 draft reviewer flag still holds', () => {
  expect(
    reviewableCall('shell_run', {
      command: 'gh pr create --draft -r reviewer',
    }),
  ).toBe(true)
})

it.skipIf(process.platform === 'win32')(
  'm3 native completion spends only its own unfinished reservation',
  async () => {
    const f = fixture()
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
    const request = { tools, context: f.ctx, workDir: f.cwd }
    const permission = planPermission(
      request,
      () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
      async () => ({ allow: true }),
    )
    for (const command of ['gh pr ready 19', 'gh pr merge 19']) {
      const verdict = await permission('Bash', { command })
      await attest(f, verdict.allow ? 'unexpected pass' : verdict.message)
    }
    await withGhExecution(f.gate, f.ctx, async () => {
      expect(
        (await permission('Bash', { command: 'gh pr ready 19' })).allow,
      ).toBe(true)
      expect(
        (await permission('Bash', { command: 'gh pr merge 19' })).allow,
      ).toBe(true)
      // The completed first command did not reach gh. Another call is still in flight.
      const finish = (
        execution as unknown as {
          finishGhExecution?: (tool: string, input: { command: string }) => void
        }
      ).finishGhExecution
      finish?.('Bash', { command: 'gh pr ready 19' })
      expect(await child('gh pr merge 19', f.cwd, f.env)).toContain('exit:0')
      expect(
        (await permission('Bash', { command: 'gh pr ready 19' })).allow,
      ).toBe(false)
    })
  },
)
