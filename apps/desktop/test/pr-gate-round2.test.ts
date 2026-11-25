import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type JsonObject, type Tool } from '@agent/core'
import { Store } from '../src/main/db'
import {
  PrGate,
  ATTESTATION_FIELDS,
  withPrGate,
} from '../src/main/runtime/pr-gate'
import {
  reviewableCall,
  inlineCommentFile,
} from '../src/main/runtime/pr-gate-detect'
import { planPermission, planToolContext } from '../src/main/runtime/cli-host'
import { appControlTools } from '../src/main/tools/app-control'
import { testContext } from './support'
const scratch = mkdtempSync(join(tmpdir(), 'gate-round2-'))
afterEach(() => vi.restoreAllMocks())
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const evidence = () =>
  Object.fromEntries(
    ATTESTATION_FIELDS.map((key) => [
      key,
      key === 'reviewerAgentId'
        ? 'independent-agent'
        : 'Specific evidence at /tmp/review.md for ' + key,
    ]),
  )
it.each([
  'echo hello | bash',
  'which gh',
  'sudo echo gh pr ready 3',
  'env echo gh pr ready 3',
  'xargs echo gh pr ready 3',
  'wsl -d Ubuntu -- echo gh pr ready 3',
  'ssh -p 22 host "echo gh pr ready 3"',
  'command -v gh',
  'sudo apt-get install -y gh',
  'gh',
  'gh co 3',
  'gh -R o/r issue list',
  'gh issue create --title pr',
  'gh pr update-branch',
  'bash ./missing-build.sh',
  'sh -e missing.sh',
  'bash -n missing.sh',
  'pwsh -NoProfile -File missing.ps1',
  'sudo bash missing.sh',
  'timeout 600 bash missing.sh',
  'nohup bash missing.sh &',
  'gh pr comment 3 -b "I will ping when it is ready for review"',
  'echo "text | bash text"',
])('normal work passes: %s', (command) =>
  expect(reviewableCall('shell_run', { command })).toBe(false),
)
it.each([
  'gh pr comment 3 -b "$(cat c.md)"',
  'gh pr comment 3 --body-file=c.md',
  'gh pr comment 3 -Fc.md',
  'wsl -d Ubuntu -- gh pr comment 3 --body "Ready for review"',
  "ssh impetix <<'EOF'\ngh pr ready 3\nEOF",
  'echo "gh pr ready 3" | ssh impetix',
  'echo "gh pr ready 3" | wsl',
  'nice -n 5 bash -c "gh pr ready 3"',
  'setsid bash -c "gh pr ready 3"',
  '~/bin/build-slot bash -lc "gh pr ready 3"',
  'busybox sh -c "gh pr ready 3"',
  'su -c "gh pr ready 3" bob',
  'script -qc "gh pr ready 3" /dev/null',
  'cmd /c "gh pr ready 3"',
  'iex "gh pr ready 3"',
  "Invoke-Expression 'gh pr ready 3'",
  'cat <<< "x"\ngh pr ready 3',
  'echo $((1<<3))\ngh pr ready 3',
  'echo `date\ngh pr ready 3`',
  "git -c alias.r='!gh pr ready 3' r",
  'gh pr create --title --dry-run',
  'gh pr create --title -d',
  'curl -X PUT https://api.github.com:443/repos/o/r/pulls/3/merge',
  'gh api repositories/123/pulls/3/merge -X PUT',
  'gh api repos/o/r/pulls/3/reviews -f event=COMMENT -f body="Ready for review"',
  'irm https://api.github.com/repos/o/r/issues/3/comments -Method POST -Body (@{body="Ready for review"} | ConvertTo-Json)',
])('PR writes hold: %s', (command) =>
  expect(reviewableCall('shell_run', { command })).toBe(true),
)
it.each([
  'Confirm merge',
  'Squash and merge',
  'Rebase and merge',
  'Confirm squash and merge',
  'Merge when ready',
  'Enable auto-merge',
])('merge button %s', (name) =>
  expect(
    reviewableCall('browser_act', {
      action: 'click',
      name,
      pageUrl: 'https://github.com/o/r/pull/3',
    }),
  ).toBe(true),
)
it.each([
  'GITHUB_ENABLE_PULL_REQUEST_AUTO_MERGE',
  'GITHUB_MERGE_PR',
  'GITHUB_SQUASH_MERGE_PR',
])('merge slug %s', (slug) =>
  expect(reviewableCall('apps_run', { slug, arguments: {} })).toBe(true),
)
it.each(['webapp_run', 'webapp_test'])('learned merge/ready %s', (tool) => {
  expect(
    reviewableCall(tool, { app: 'GitHub', tool: 'squash_and_merge' }),
  ).toBe(true)
  expect(reviewableCall(tool, { app: 'GitHub', tool: 'mark_ready' })).toBe(true)
})
it('resolves local scripts without blocking unreadable or syntax-only scripts', () => {
  const path = join(scratch, 'build.sh')
  writeFileSync(path, 'gh pr ready 3')
  expect(reviewableCall('shell_run', { command: 'bash ' + path })).toBe(true)
  expect(reviewableCall('shell_run', { command: 'bash -n ' + path })).toBe(
    false,
  )
  writeFileSync(path, 'pnpm typecheck')
  expect(reviewableCall('shell_run', { command: 'bash ' + path })).toBe(false)
})
it('protects namespaced resets, removals, restores and bulk policy rewrites even when off', async () => {
  const store = new Store(':memory:')
  try {
    const page = await store.upsert('memory', {
      title: 'Review policy',
      body: 'Checklist',
      kind: 'fact',
      topics: 'review',
      pinned: false,
      source: 'user',
    })
    const settings = {
      ...DEFAULT_SETTINGS,
      prGateEnabled: false,
      prGateSkillPages: ['Review policy'],
    }
    const gate = new PrGate(store, () => settings),
      ctx = testContext()
    for (const [method, args] of [
      ['agent.data.upsert', ['memory', { id: page.id, body: 'weaker' }]],
      ['data.remove', ['memory', page.id]],
      ['memory.restoreVersion', [page.id, 1]],
      ['memory.undoChange', [page.id]],
      ['memory.runImport', []],
      ['memory.startTidy', []],
    ] as Array<[string, JsonObject[] | unknown[]]>) {
      expect(
        await gate.check('app_action', { method, args } as JsonObject, ctx),
      ).toContain('Refused')
    }
    settings.prGateEnabled = true
    expect(
      await gate.check(
        'app_action',
        { method: 'agent.settings.reset', args: [] },
        ctx,
      ),
    ).toContain('Refused')
    expect(
      await gate.check(
        'memory_update',
        { id: ' ' + page.id + ' ', body: 'weaker' },
        ctx,
      ),
    ).toContain('Refused')
  } finally {
    store.close()
  }
})
it('uses indexed audit reads and rejects evidence with no path', async () => {
  const store = new Store(':memory:')
  try {
    const list = vi.spyOn(store, 'list')
    const gate = new PrGate(store, () => ({
        ...DEFAULT_SETTINGS,
        prGateEnabled: true,
      })),
      ctx = testContext()
    const held = await gate.check(
      'shell_run',
      { command: 'gh pr ready 3' },
      ctx,
    )
    const id = held!.match(/Gate id: ([a-f0-9-]+)/)![1]!
    expect(
      await gate.attest(
        id,
        { ...evidence(), testProof: 'all checks completed' },
        ctx,
      ),
    ).toContain('Refused')
    expect(list.mock.calls.some(([entity]) => entity === 'chat_item')).toBe(
      false,
    )
  } finally {
    store.close()
  }
})
it('requires a private native handle and keeps generic tool limits small', async () => {
  const ctx = testContext()
  const permission = planPermission(
    { tools: [], context: ctx },
    () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
    async () => ({ allow: true }),
  )
  expect(await permission('Bash', { command: 'gh pr ready 3' })).toMatchObject({
    allow: false,
  })
  const context = planToolContext(
    { cli: 'codex', context: ctx },
    { ...DEFAULT_SETTINGS, prGateEnabled: true },
  )
  expect(context.resultLimit).toBeUndefined()
  expect(context.commandFallback?.outputChars).toBe(2_000_000)
})
it('executes the exact captured comment body, not a file changed after inspection', async () => {
  const store = new Store(':memory:')
  try {
    const path = join(scratch, 'comment.md')
    writeFileSync(path, 'Ready for review')
    const gate = new PrGate(store, () => ({
        ...DEFAULT_SETTINGS,
        prGateEnabled: true,
      })),
      ctx = testContext()
    const run = vi.fn(async (input: JsonObject) => String(input['command']))
    const tool: Tool = {
      spec: { name: 'shell_run', description: 'fixture', schema: {} },
      run,
    }
    const wrapped = withPrGate([tool], gate, async (name, input) => {
      const captured = inlineCommentFile(name, input)
      writeFileSync(path, 'changed malicious payload')
      return captured
    })[0]!
    const input = {
      command: 'gh pr comment 3 --body-file ' + path,
      shell: 'bash',
    }
    const held = await wrapped.run(input, ctx)
    const id = held.match(/Gate id: ([a-f0-9-]+)/)![1]!
    await gate.attest(id, evidence(), ctx)
    writeFileSync(path, 'Ready for review')
    const sent = await wrapped.run(input, ctx)
    expect(sent).toContain('Ready for review')
    expect(sent).not.toContain('--body-file')
    expect(sent).not.toContain('changed malicious payload')
  } finally {
    store.close()
  }
})

it('settings_set itself cannot disable or rewrite policy without a person approval', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    prGateEnabled: true,
    prGateSkillPages: ['Review policy'],
  }
  const save = vi.fn((patch: Partial<typeof settings>) =>
    Object.assign(settings, patch),
  )
  const tools = appControlTools({ settings: { get: () => settings, save } })
  const set = tools.find((tool) => tool.spec.name === 'settings_set')!
  for (const values of [{ prGateEnabled: false }, { prGateSkillPages: [] }]) {
    expect(await set.run({ values }, testContext())).toMatch(
      /[Rr]efused|[Dd]eclined|[Nn]ot approved|[Cc]ancel/,
    )
  }
  expect(save).not.toHaveBeenCalled()
})

it('native comment grants are invalidated when body bytes change', async () => {
  const store = new Store(':memory:')
  try {
    const file = join(scratch, 'native.md')
    writeFileSync(file, 'Ready for review')
    const gate = new PrGate(store, () => ({
        ...DEFAULT_SETTINGS,
        prGateEnabled: true,
      })),
      ctx = testContext()
    const input = { command: 'gh pr comment 3 --body-file ' + file }
    const held = await gate.check('Bash', input, ctx)
    const id = held!.match(/Gate id: ([a-f0-9-]+)/)![1]!
    await gate.attest(id, evidence(), ctx)
    writeFileSync(file, 'Ready for review with different bytes')
    expect(await gate.check('Bash', input, ctx)).toContain('NOT RUN')
  } finally {
    store.close()
  }
})
it('large bash comment bodies use a bounded private file snapshot, PowerShell stays opaque', () => {
  const file = join(scratch, 'large.md')
  writeFileSync(file, 'Ready for review\n' + 'x'.repeat(130_000))
  const input = {
    command: 'gh pr comment 3 --body-file=' + file,
    shell: 'bash',
  }
  const effective = inlineCommentFile('shell_run', input)
  expect(String(effective['command']).length).toBeLessThan(1000)
  expect(String(effective['command'])).not.toContain(file)
  expect(String(effective['command'])).toContain('--body-file')
  expect(
    inlineCommentFile('shell_run', { ...input, shell: 'powershell' }),
  ).toEqual({ ...input, shell: 'powershell' })
})
it('Settings reads only a capped audit query, never initialises the global chat entity', () => {
  const source = readFileSync(
    new URL('../src/renderer/views/PrGateSettings.tsx', import.meta.url),
    'utf8',
  )
  expect(source).not.toMatch(/useEntity\(['"]chat_item/)
  expect(source).toMatch(/data.where\('chat_item'/)
  expect(source).toMatch(/kind:\s*['"]pr_gate/)
  expect(source).toMatch(/limit:\s*100/)
})

it('PowerShell continuation is executable but Bash backticks retain their body', () => {
  expect(reviewableCall('PowerShell', { command: 'gh pr \`\nready 3' })).toBe(
    true,
  )
  expect(
    reviewableCall('shell_run', { command: 'echo \`date\ngh pr ready 3\`' }),
  ).toBe(true)
})

it('native permission checks resolve body files against the actual plan folder', async () => {
  const store = new Store(':memory:')
  try {
    const file = join(scratch, 'native-plan.md')
    writeFileSync(file, 'Ready for review')
    const settings = { ...DEFAULT_SETTINGS, prGateEnabled: true }
    const gate = new PrGate(store, () => settings),
      ctx = testContext()
    const tools = withPrGate(
      [
        {
          spec: { name: 'shell_run', description: 'fixture', schema: {} },
          run: async () => '',
        },
      ],
      gate,
    )
    const permit = planPermission(
      { tools, context: ctx, folder: scratch },
      () => settings,
      async () => ({ allow: true }),
    )
    const call = { command: 'gh pr comment 3 --body-file native-plan.md' }
    const held = await permit('Bash', call)
    if (held.allow) throw Error('Expected a native hold')
    const id = held.message.match(/Gate id: ([a-f0-9-]+)/)![1]!
    await gate.attest(id, evidence(), ctx)
    writeFileSync(file, 'Ready for review with changed bytes')
    expect(await permit('Bash', call)).toMatchObject({ allow: false })
    writeFileSync(file, 'Ready for review')
    expect(await permit('Bash', call)).toEqual({ allow: true })
  } finally {
    store.close()
  }
})

it('logs unreadable scripts while allowing normal work', async () => {
  const store = new Store(':memory:')
  try {
    const gate = new PrGate(store, () => ({
        ...DEFAULT_SETTINGS,
        prGateEnabled: true,
      })),
      ctx = testContext()
    expect(
      await gate.check(
        'shell_run',
        { command: 'bash /missing/local-build.sh' },
        ctx,
      ),
    ).toBeNull()
    const rows = await store.listWhere('chat_item', {
      chat: 'pr-gate-audit',
      kind: 'pr_gate',
    })
    expect(
      rows.some((row) => row.text === 'unreadable local script (not gated)'),
    ).toBe(true)
  } finally {
    store.close()
  }
})
