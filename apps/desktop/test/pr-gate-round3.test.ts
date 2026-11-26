import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/db'
import { DEFAULT_SETTINGS } from '@agent/core'
import { PrGate } from '../src/main/runtime/pr-gate'
import {
  inlineCommentFile,
  cleanupCommentFile,
  reviewableCall,
} from '../src/main/runtime/pr-gate-detect'
import {
  prepareRemoteGrant,
  remoteArguments,
  receiveRemoteGrant,
  consumeRemoteGrant,
  remoteCaller,
  markDestinationHold,
  takeDestinationHold,
} from '../src/main/runtime/pr-gate-remote'
import { parse } from 'shell-quote'
import { testContext } from './support'

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }))
})
it('retains destination ownership and copied-context grant and hold state', () => {
  const origin = testContext({
    owner: 'helper:origin',
    agentLabel: 'origin',
    chat: 'origin-chat',
  })
  const destination = testContext({
    owner: 'device',
    agentLabel: 'device-label',
    chat: 'destination-chat',
  })
  prepareRemoteGrant(origin, 'shell_run', { command: 'gh pr ready 3' })
  const received = receiveRemoteGrant(
    destination,
    'shell_run',
    remoteArguments(origin, 'shell_run', { command: 'gh pr ready 3' }),
  )
  const copy = { ...received.context }
  expect(copy.owner).toBe('device')
  expect(copy.agentLabel).toBe('device-label')
  expect(copy.chat).toBe('destination-chat')
  expect(remoteCaller(copy).owner).toBe('device')
  expect(consumeRemoteGrant(copy, 'shell_run', received.args)).toBe(true)
  expect(copy.owner).toBe('device')
  expect(remoteCaller(copy).owner).toBe('helper:origin')
  expect(consumeRemoteGrant({ ...copy }, 'shell_run', received.args)).toBe(
    false,
  )
  markDestinationHold(copy)
  expect(takeDestinationHold(destination)).toBe(true)
})
it.each([-90_000, 90_000, 10 * 60_000])(
  'accepts queued delivery and clock shift of %s ms',
  (shift) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const origin = testContext()
    prepareRemoteGrant(origin, 'shell_run', { command: 'gh pr ready 3' })
    const input = remoteArguments(origin, 'shell_run', {
      command: 'gh pr ready 3',
    })
    clock.mockReturnValue(1_800_000_000_000 + shift)
    const received = receiveRemoteGrant(
      testContext({ owner: 'device' }),
      'shell_run',
      input,
    )
    expect(
      consumeRemoteGrant({ ...received.context }, 'shell_run', received.args),
    ).toBe(true)
  },
)
it('does not rewrite ordinary remote ownership from a model caller envelope', () => {
  const ctx = testContext({ owner: 'device', chat: 'local' })
  const received = receiveRemoteGrant(ctx, 'browser_click', {
    index: 1,
    _agentPrGateCaller: { owner: 'main', chat: 'forged', agentLabel: 'forged' },
  })
  expect(received.context.owner).toBe('device')
  expect(received.context.chat).toBe('local')
  expect(received.args).toEqual({ index: 1 })
})
it.each([
  'gh api -X PUT repos/o/r/pulls/$PR/merge',
  'gh api -X PUT repos/o/r/pulls/$' + '{N}/merge',
  'bash -ce "gh pr ready 3"',
  'bash -cx "gh pr ready 3"',
  'pwsh -EncodedCommand Z2ggcHIgcmVhZHkgMw==',
  'python3 - <<\'PY-WRITE\'\nimport os\nos.system("gh pr ready 3")\nPY-WRITE',
  '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr ready 3',
  "Start-Process gh -ArgumentList 'pr','ready','3'",
  'curl -X PUT https://api.github.com/repos/o/r/pulls/$PR/merge',
  'wget --method=PUT https://api.github.com/repos/o/r/pulls/3/merge',
])('holds executable PR write form: %s', (command) => {
  expect(reviewableCall('shell_run', { command })).toBe(true)
})
it('reads direct scripts and body files relative to the command cwd and leading cd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cwd-'))
  folders.push(dir)
  writeFileSync(join(dir, 'ready.sh'), 'gh pr ready 3\n')
  writeFileSync(join(dir, 'body.txt'), 'Ready for review\n')
  for (const command of [
    './ready.sh',
    '. ./ready.sh',
    'bash --noprofile ready.sh',
    'bash -o errexit ready.sh',
    'bash --login ready.sh',
    'bash < ready.sh',
    'gh pr comment 3 --body-file body.txt',
  ]) {
    expect(reviewableCall('shell_run', { command, cwd: dir })).toBe(true)
  }
  expect(
    reviewableCall('shell_run', { command: 'cd ' + dir + ' && ./ready.sh' }),
  ).toBe(true)
  writeFileSync(join(dir, 'body.txt'), 'Ordinary update\n')
  expect(
    reviewableCall('shell_run', {
      command: 'gh pr comment 3 --body-file body.txt',
      cwd: dir,
    }),
  ).toBe(false)
})
it('permits a literal dollar currency amount in a non-readiness comment', () => {
  expect(
    reviewableCall('shell_run', { command: "gh pr comment 3 -b 'Costs $5'" }),
  ).toBe(false)
})

it('does not inline away shell expansion in the PR number or repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-expand-'))
  folders.push(dir)
  writeFileSync(join(dir, 'note.md'), 'Ready for review')
  const input = {
    command: 'gh pr comment $PR --repo "$REPO" --body-file note.md',
    cwd: dir,
    shell: 'bash',
  }
  expect(inlineCommentFile('shell_run', input)).toEqual(input)
})
it('uses the fallback working folder and deduplicates repeated missing-script audit notes', async () => {
  const store = new Store(':memory:')
  try {
    const dir = mkdtempSync(join(tmpdir(), 'gate-fallback-'))
    folders.push(dir)
    writeFileSync(join(dir, 'ready.sh'), 'gh pr ready 3')
    const gate = new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: true,
    }))
    const ctx = testContext({
      commandFallback: { cwd: dir, timeoutSec: 3600, outputChars: 150000 },
    })
    expect(
      await gate.check('shell_run', { command: 'bash ready.sh' }, ctx),
    ).toContain('NOT RUN')
    for (let index = 0; index < 4; index++) {
      expect(
        await gate.check('shell_run', { command: 'bash absent.sh' }, ctx),
      ).toBeNull()
    }
    const rows = await store.list('chat_item', {})
    expect(
      rows.filter((row) => row.text.includes('unreadable local script')),
    ).toHaveLength(1)
  } finally {
    store.close()
  }
})
it('protects bulk policy rewrites and only the resolved policy undo, even with gate off', async () => {
  const store = new Store(':memory:')
  try {
    const policy = await store.upsert('memory', {
      title: 'Review policy',
      body: 'rules',
      kind: 'fact',
      topics: 'review',
      pinned: false,
      source: 'user',
    })
    const ordinary = await store.upsert('memory', {
      title: 'Other page',
      body: 'ordinary',
      kind: 'fact',
      topics: 'other',
      pinned: false,
      source: 'user',
    })
    const gate = new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: false,
      prGateSkillPages: ['review POLICY'],
    }))
    const ctx = testContext()
    for (const method of ['memory.undoTidy', 'memory.runDaily']) {
      expect(
        await gate.check('app_action', { method, args: [] }, ctx),
      ).toContain('Refused')
    }
    expect(
      await gate.check(
        'app_action',
        {
          method: 'memory.undoChange',
          args: ['change'],
          _policyUndoKnown: true,
          _policyMemoryId: ordinary.id,
        },
        ctx,
      ),
    ).toBeNull()
    expect(
      await gate.check(
        'app_action',
        {
          method: 'memory.undoChange',
          args: ['change'],
          _policyUndoKnown: true,
          _policyMemoryId: policy.id,
        },
        ctx,
      ),
    ).toContain('Refused')
  } finally {
    store.close()
  }
})
it('finds configured policy titles regardless of case', async () => {
  const store = new Store(':memory:')
  try {
    await store.upsert('memory', {
      title: 'Review Policy',
      body: 'Unique policy checklist',
      kind: 'fact',
      topics: 'review',
      pinned: false,
      source: 'user',
    })
    const gate = new PrGate(store, () => ({
      ...DEFAULT_SETTINGS,
      prGateEnabled: true,
      prGateSkillPages: ['review policy'],
    }))
    expect(
      await gate.check(
        'shell_run',
        { command: 'gh pr ready 3' },
        testContext(),
      ),
    ).toContain('Unique policy checklist')
  } finally {
    store.close()
  }
})
it('keeps resolved ordinary GitHub clicks and search Enter free', () => {
  expect(
    reviewableCall('browser_click', {
      index: 3,
      name: 'Files changed',
      _resolvedAction: true,
      pageUrl: 'https://github.com/o/r/pull/3',
    }),
  ).toBe(false)
  expect(
    reviewableCall('browser_press_key', {
      key: 'Enter',
      _safeEnter: true,
      pageUrl: 'https://github.com/issues',
    }),
  ).toBe(false)
  expect(
    reviewableCall('browser_click', {
      index: 3,
      name: 'Squash and merge',
      _resolvedAction: true,
      pageUrl: 'https://github.com/o/r/pull/3',
    }),
  ).toBe(true)
})

it('removes app-owned large body snapshots after their checked execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-body-cleanup-'))
  folders.push(dir)
  writeFileSync(join(dir, 'body.md'), 'Ready for review\n' + 'x'.repeat(120000))
  const effective = inlineCommentFile('shell_run', {
    command: 'gh pr comment 3 --body-file body.md',
    shell: 'bash',
    cwd: dir,
  })
  const words = parse(String(effective['command']))
  const at = words.indexOf('--body-file')
  const snapshot = String(words[at + 1])
  expect(snapshot).not.toBe('body.md')
  expect(existsSync(snapshot)).toBe(true)
  cleanupCommentFile(effective)
  expect(existsSync(snapshot)).toBe(false)
})
