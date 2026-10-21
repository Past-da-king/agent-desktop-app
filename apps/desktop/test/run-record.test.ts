/**
 * What the agent ran is kept with the run: the exact command, stdout and stderr apart, exit code and time, capped
 * with a plain "output trimmed", and redacted the way the logs are. Real child processes and a local fake AI.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type ChatItem, type Settings } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Store } from '../src/main/db'
import { redact, redactSecrets } from '../src/main/logger'
import { runFinished, runStarted, describeRun } from '../src/main/runtime/run-detail'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { codeTools } from '../src/main/tools/code'
import { StreamCapture, takeRun } from '../src/main/tools/run-capture'
import { shellTools } from '../src/main/tools/shell'
import {
  capText,
  foldLines,
  formatMs,
  runFromMeta,
  snippetOf,
  statusText,
  RUN_STREAM_CAP,
  type RunRecord,
} from '../src/shared/run-record'
import { secretsView, settingsView, testContext, toolNamed } from './support'

const linux = process.platform !== 'win32'
const dirs: string[] = []
let store: Store | null = null
let fake: FakeAi | null = null
const runners: Runner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  store?.close()
  store = null
  await fake?.close()
  fake = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-run-'))
  dirs.push(dir)
  return dir
}

describe('run record helpers', () => {
  it('formats durations for a person', () => {
    expect(formatMs(null)).toBe('')
    expect(formatMs(0)).toBe('1 ms')
    expect(formatMs(120)).toBe('120 ms')
    expect(formatMs(4_240)).toBe('4.2 s')
    expect(formatMs(38_400)).toBe('38 s')
    expect(formatMs(125_000)).toBe('2 min 5 s')
    expect(formatMs(120_000)).toBe('2 min')
  })

  it('makes a one-line snippet and marks more lines', () => {
    expect(snippetOf('  git   status  ')).toBe('git status')
    expect(snippetOf('\n\nimport os\nprint(os.getcwd())')).toBe('import os ...')
    expect(snippetOf('')).toBe('')
  })

  it('keeps the start and end of long text and says it was trimmed', () => {
    const long = `START${'x'.repeat(RUN_STREAM_CAP * 2)}END`
    const capped = capText(long)
    expect(capped.trimmed).toBe(true)
    expect(capped.text.startsWith('START')).toBe(true)
    expect(capped.text.endsWith('END')).toBe(true)
    expect(capped.text).toContain('[output trimmed:')
    expect(capped.text.length).toBeLessThan(RUN_STREAM_CAP + 200)
    expect(capText('short')).toEqual({ text: 'short', trimmed: false })
  })

  it('folds long output to its first and last lines', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const folded = foldLines(text)
    expect(folded?.head.split('\n')).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'])
    expect(folded?.tail.split('\n')[5]).toBe('line 40')
    expect(folded?.hidden).toBe(28)
    expect(foldLines('a\nb\nc')).toBeNull()
  })

  it('reads a record back from row meta and refuses junk', () => {
    const run: RunRecord = { kind: 'shell', input: 'ls', label: 'bash', cwd: '/tmp', stdout: 'a', stderr: '', exitCode: 0, ms: 12, state: 'ok', trimmed: false }
    expect(runFromMeta(JSON.parse(JSON.stringify({ run })) as Record<string, unknown>)).toEqual(run)
    expect(runFromMeta({ run: { kind: 'rocket', state: 'ok' } })).toBeNull()
    expect(runFromMeta({})).toBeNull()
    expect(statusText({ ...run, state: 'failed', exitCode: 2 })).toBe('failed, exit 2')
    expect(statusText(run)).toBe('ok')
  })

  it('a stream capture keeps head and a rolling tail', () => {
    const capture = new StreamCapture(20)
    capture.push('0123456789')
    capture.push('abcdefghij')
    capture.push('KLMNOPQRST')
    expect(capture.trimmed()).toBe(true)
    expect(capture.total).toBe(30)
    expect(capture.text()).toBe('0123456789\n[output trimmed: 10 characters left out here]\nKLMNOPQRST')
    const small = new StreamCapture(100)
    small.push('hello ')
    small.push('world')
    expect(small.trimmed()).toBe(false)
    expect(small.text()).toBe('hello world')
  })
})

describe('secrets in commands and output', () => {
  it('redacts credentials but keeps their names and ordinary words', () => {
    const line = redactSecrets(
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnop curl -H "Authorization: Bearer abcdefghijkl.mnop" -H "x-api-key: zzz123" https://bob:hunter22@example.com/x --password p4ss ghp_abcdefghijklmnopqrstuvwxyz0123',
    )
    for (const secret of ['abcdefghijklmnop', 'abcdefghijkl.mnop', 'zzz123', 'hunter22', 'p4ss', 'ghp_abcdefghijklmnopqrstuvwxyz0123']) {
      expect(line).not.toContain(secret)
    }
    expect(line).toContain('OPENAI_API_KEY=')
    expect(line).toContain('https://bob:[redacted]@example.com/x')
    expect(redactSecrets('$env:GITHUB_TOKEN = "abc def"')).toBe('$env:GITHUB_TOKEN = [redacted]')
    expect(redactSecrets('git config user.email sam@example.com')).toBe('git config user.email sam@example.com')
    expect(redactSecrets('npm test -- --run')).toBe('npm test -- --run')
  })

  it('the logs still redact everything they did', () => {
    expect(redact('password: hunter2 and sam@example.com')).toBe('[redacted] and [email]')
  })
})

describe.skipIf(!linux)('shell_run keeps the whole story', () => {
  const shell = (): ReturnType<typeof toolNamed> =>
    toolNamed(shellTools({ settings: settingsView({ shell: 'always' }), platform: 'linux', env: { PATH: process.env['PATH'] ?? '', SHELL: '/bin/sh' }, exists: () => true }), 'shell_run')

  it('records stdout and stderr apart, the exit code, the folder and the time', async () => {
    const folder = temp()
    const input = { command: 'echo out-line; echo err-line 1>&2; exit 3', cwd: folder }
    const result = await shell().run(input, testContext())
    expect(result).toContain('Exit 3')
    const run = takeRun(input)
    expect(run).toMatchObject({ kind: 'shell', input: input.command, cwd: folder, exitCode: 3, state: 'failed', trimmed: false })
    expect(run?.stdout.trim()).toBe('out-line')
    expect(run?.stderr.trim()).toBe('err-line')
    expect(typeof run?.ms).toBe('number')
    expect(takeRun(input)).toBeUndefined()
  })

  it('keeps more than the model gets and says when it trimmed', async () => {
    const input = { command: 'i=0; while [ $i -lt 6000 ]; do echo "line number $i of the long build log"; i=$((i+1)); done' }
    const result = await shell().run(input, testContext())
    expect(result).toContain('...(cut,')
    const run = takeRun(input)
    expect(run?.state).toBe('ok')
    expect(run?.trimmed).toBe(true)
    expect(run?.stdout).toContain('line number 0 of')
    expect(run?.stdout).toContain('line number 5999 of')
    expect(run?.stdout).toContain('[output trimmed:')
  })

  it('records a declined command without running it', async () => {
    const tool = toolNamed(shellTools({ settings: settingsView({ shell: 'ask' }), platform: 'linux', env: { PATH: process.env['PATH'] ?? '' } }), 'shell_run')
    const input = { command: 'touch /tmp/should-not-exist' }
    await tool.run(input, testContext({ approve: async () => false }))
    expect(takeRun(input)).toMatchObject({ state: 'declined', note: 'You did not approve it.' })
  })

  it('run_code records the program, its folder and both streams', async () => {
    const input = { language: 'javascript', code: 'console.log("hi from js"); console.error("warned"); process.exit(1)' }
    const tool = toolNamed(codeTools({ settings: { get: () => ({ shell: 'always' }) }, tempRoot: temp(), findCommand: () => process.execPath }), 'run_code')
    await tool.run(input, testContext())
    const run = takeRun(input)
    expect(run).toMatchObject({ kind: 'code', label: 'javascript', input: input.code, exitCode: 1, state: 'failed' })
    expect(run?.stdout.trim()).toBe('hi from js')
    expect(run?.stderr.trim()).toBe('warned')
    expect(run?.cwd).toMatch(/agent-code-/)
  })
})

describe('the record on the activity row', () => {
  it('reads a file call from its input and result when the tool kept nothing', () => {
    const call = { t: 'call' as const, id: '1', name: 'files_read', input: { path: '/home/sam/notes.md' } }
    expect(runStarted(call)).toMatchObject({ kind: 'file', label: 'Read', input: '/home/sam/notes.md', state: 'running' })
    const done = runFinished(call, '## notes.md (1 KB)\nfirst line\nsecond line', false, 1_000, 1_250)
    expect(done).toMatchObject({ state: 'ok', stdout: 'first line\nsecond line', ms: 250 })
    const missing = runFinished(call, 'There is no file or folder at /home/sam/notes.md.', false, 0, 5)
    expect(missing?.state).toBe('failed')
    expect(describeRun(call)).toBe('Read notes.md')
    const write = { t: 'call' as const, id: '2', name: 'files_write', input: { path: 'C:\\Users\\sam\\out.csv', content: 'a,b\n1,2' } }
    expect(runFinished(write, 'Wrote 7 characters to C:\\Users\\sam\\out.csv.', false, 0, 3)).toMatchObject({ state: 'ok', stdout: 'a,b\n1,2' })
    expect(describeRun(write)).toBe('Wrote out.csv')
    expect(runStarted({ t: 'call', id: '3', name: 'memory_search', input: {} })).toBeNull()
  })

  it('redacts a secret in the command line on the row text', () => {
    const call = { t: 'call' as const, id: '1', name: 'shell_run', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com' } }
    expect(describeRun(call)).not.toContain('abcdefghijklmnop')
    expect(runStarted(call)?.input).not.toContain('abcdefghijklmnop')
  })

  it.skipIf(!linux)('a real run through the runner lands on the row, redacted', async () => {
    const folder = temp()
    const command = `cd ${folder} && echo "API_TOKEN=supersecretvalue1"; echo "done here"; echo "warning: careful" 1>&2; exit 2`
    fake = await startFakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'shell_run', input: { command, cwd: folder } }] } : { text: 'It failed with exit 2.' },
    )
    store = new Store(':memory:')
    const settings: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, shell: 'always' }
    const view = settingsView({ ...DEFAULT_SETTINGS, ...settings })
    const runner = new Runner({
      store,
      settings: view,
      secrets: secretsView('test-key'),
      tools: buildToolset({ store, settings: view }),
      providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
      isFocused: () => true,
      timeZone: 'UTC',
    })
    runners.push(runner)
    await runner.send('Run it')
    const rows: ChatItem[] = await store.list('chat_item')
    const activity = rows.find((row) => row.kind === 'activity')
    expect(activity).toBeDefined()
    const meta = JSON.parse(activity?.meta ?? '{}') as Record<string, unknown>
    const run = runFromMeta(meta)
    expect(run).toMatchObject({ kind: 'shell', exitCode: 2, state: 'failed', cwd: folder })
    expect(run?.input).toContain(`cd ${folder}`)
    expect(run?.stdout).toContain('API_TOKEN=[redacted]')
    expect(run?.stdout).toContain('done here')
    expect(run?.stderr.trim()).toBe('warning: careful')
    expect(run?.ms).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(rows)).not.toContain('supersecretvalue1')
    expect(activity?.text).toMatch(/^Ran cd /)
    // The model still saw the plain result, unchanged by the UI copy.
    expect(JSON.stringify(fake.requests[1]?.body)).toContain('Exit 2')
  }, 30_000)
})
