/**
 * What the agent ran is kept with the run: the exact command, stdout and stderr apart, exit code and time, capped
 * with a plain "output trimmed", and redacted the way the logs are. Real child processes and a local fake AI.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type ChatItem, type Settings } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Store } from '../src/main/db'
import { redact, redactSecrets } from '../src/main/logger'
import { expandPersisted, runFinished, runStarted, describeRun } from '../src/main/runtime/run-detail'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { codeTools } from '../src/main/tools/code'
import { markReleased, StreamCapture, takeRun } from '../src/main/tools/run-capture'
import { shellTools } from '../src/main/tools/shell'
import {
  capText,
  foldLines,
  formatMs,
  runFromMeta,
  snippetOf,
  statusText,
  RUN_STREAM_CAP,
  TOOL_STREAM_CAP,
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

  it('runs in the home folder when the agent names no folder', async () => {
    const home = temp()
    const tool = toolNamed(shellTools({ settings: settingsView({ shell: 'always' }), platform: 'linux', env: { PATH: process.env['PATH'] ?? '' }, home: () => home }), 'shell_run')
    const input = { command: 'pwd' }
    const result = await tool.run(input, testContext())
    expect(result).toContain(home)
    expect(takeRun(input)?.cwd).toBe(home)
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
    expect(describeRun({ t: 'call', id: '3', name: 'memory_search', input: {} })).toBeNull()
  })

  it('keeps any other tool call: what it was given and what came back, secrets hidden and long results capped', () => {
    const script = "const rows = $$('tr')\nreturn rows.length"
    const evalCall = { t: 'call' as const, id: '4', name: 'browser_eval', input: { js: script } }
    expect(runStarted(evalCall)).toMatchObject({ kind: 'tool', label: 'browser eval', input: script, state: 'running', ms: null })
    expect(runFinished(evalCall, '12', false, 1_000, 1_340)).toMatchObject({ state: 'ok', stdout: '12', stderr: '', ms: 340 })
    const failed = runFinished(evalCall, 'TypeError: rows is undefined', true, 0, 5)
    expect(failed).toMatchObject({ state: 'failed', stdout: '', stderr: 'TypeError: rows is undefined' })

    const search = { t: 'call' as const, id: '5', name: 'memory_search', input: { query: 'VAT number', limit: 5 } }
    expect(runStarted(search)?.input).toBe('query: VAT number\nlimit: 5')
    expect(runStarted({ t: 'call', id: '6', name: 'mcp__other__os_status', input: {} })).toMatchObject({ label: 'os status', input: '' })

    const fill = { t: 'call' as const, id: '7', name: 'browser_fill', input: { selector: 'input[type=password]', value: 'hunter2hunter2' } }
    expect(runStarted(fill)?.input).toBe('selector: input[type=password]\nvalue: [hidden]')
    const login = { t: 'call' as const, id: '8', name: 'connect', input: { user: 'sam', api_key: 'abc', password: 'xyz' } }
    const shown = runStarted(login)?.input ?? ''
    expect(shown).toMatch(/^user: sam\napi_key: \[(hidden|redacted)\]\npassword: \[(hidden|redacted)\]$/)

    const big = runFinished(evalCall, 'x'.repeat(TOOL_STREAM_CAP * 3), false, 0, 1)
    expect(big?.trimmed).toBe(true)
    expect((big?.stdout.length ?? 0) < TOOL_STREAM_CAP + 200).toBe(true)
    expect(runFinished(evalCall, 'You did not approve that.', false, 0, 1)?.state).toBe('declined')
    expect(runFinished(evalCall, 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', false, 0, 1)?.stdout).not.toContain('abcdefghijklmnop')
  })

  it("reads Claude Code's own Bash, Write and Edit calls on the person's plan", () => {
    // The tool_result texts are exactly what Claude Code 2.1 returned on this box.
    const failing = { t: 'call' as const, id: 'a', name: 'Bash', input: { command: 'echo out-line; echo err-line 1>&2; exit 3', description: 'x' } }
    expect(describeRun(failing)).toBe('Ran echo out-line; echo err-line 1>&2; exit 3')
    expect(runFinished(failing, 'Exit code 3\nout-line\nerr-line', true, 0, 80)).toMatchObject({
      kind: 'shell',
      label: 'Bash',
      exitCode: 3,
      state: 'failed',
      stdout: 'out-line\nerr-line',
      merged: true,
      ms: 80,
    })
    const passing = { ...failing, id: 'b', input: { command: 'echo out-line; echo err-line 1>&2' } }
    expect(runFinished(passing, 'out-line\nerr-line', false, 0, 5)).toMatchObject({ exitCode: 0, state: 'ok', stdout: 'out-line\nerr-line' })
    expect(runFinished(passing, 'The user declined this command. Do not run it; find another way or ask.', true, 0, 5)?.state).toBe('declined')
    const write = { t: 'call' as const, id: 'c', name: 'Write', input: { file_path: '/home/sam/a.txt', content: 'hello' } }
    expect(runFinished(write, 'File created successfully at: /home/sam/a.txt', false, 0, 2)).toMatchObject({ kind: 'file', label: 'Write', stdout: 'hello', state: 'ok' })
    const edit = { t: 'call' as const, id: 'd', name: 'Edit', input: { file_path: '/home/sam/a.txt', old_string: 'hello', new_string: 'hi' } }
    expect(runFinished(edit, 'The file has been updated.', false, 0, 2)?.stdout).toBe('Replaced:\nhello\n\nWith:\nhi')
    expect(describeRun(edit)).toBe('Edited a.txt')
  })

  it('on the plan, the wait for approval is not counted as running time', () => {
    const call = { t: 'call' as const, id: 'toolu_wait', name: 'Bash', input: { command: 'npm test' } }
    // Written at 0, the person approved at 260 s, it finished at 264.2 s.
    markReleased('toolu_wait', 260_000)
    const run = runFinished(call, 'ok', false, 0, 264_200)
    expect(run?.ms).toBe(4_200)
    expect(run?.waitedMs).toBe(260_000)
    // No approval needed: the clock runs from the call.
    expect(runFinished({ ...call, id: 'toolu_none' }, 'ok', false, 0, 900)?.ms).toBe(900)
  })

  it('reads back output Claude Code saved to a file, only from its own folder', async () => {
    const root = temp()
    const folder = join(root, 'projects', 'x', 'tool-results')
    mkdirSync(folder, { recursive: true })
    const saved = join(folder, 'be1dvscm1.txt')
    const full = Array.from({ length: 3_000 }, (_, i) => String(i + 1)).join('\n')
    writeFileSync(saved, full)
    // The marker exactly as Claude Code 2.1 wrote it on this box.
    const marker = (path: string): string =>
      `<persisted-output>\nOutput too large (59.5KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n1\n2\n3\n...\n</persisted-output>`
    const read = await expandPersisted(marker(saved), [join(root)])
    expect(read).toEqual({ text: full, persisted: true })
    const outside = await expandPersisted(marker(saved), [join(root, 'elsewhere')])
    expect(outside.text).toBe('1\n2\n3\n...')
    expect(outside.note).toMatch(/outside the Claude folder/)
    const missing = await expandPersisted(marker(join(root, 'gone.txt')), [root])
    expect(missing.note).toMatch(/could not be read/)
    expect(await expandPersisted('plain output', [root])).toEqual({ text: 'plain output', persisted: false })
    // A huge saved file keeps its start and end only.
    writeFileSync(saved, `START${'x'.repeat(200_000)}END`)
    const big = await expandPersisted(marker(saved), [root])
    expect(big.text.startsWith('START')).toBe(true)
    expect(big.text.endsWith('END')).toBe(true)
    expect(big.text).toContain('[output trimmed:')
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

describe('the run in the chat', () => {
  const failing: RunRecord = {
    kind: 'shell',
    input: 'npm test -- --run\n  --reporter=verbose',
    label: 'PowerShell 7',
    cwd: 'C:\\Users\\sam\\shop',
    stdout: Array.from({ length: 40 }, (_, i) => `  line ${i + 1}`).join('\n'),
    stderr: 'npm ERR! Test failed.',
    exitCode: 1,
    ms: 38_420,
    state: 'failed',
    trimmed: true,
  }

  it('is one line: tag, snippet, how it ended and how long it took', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { RunStep } = await import('../src/renderer/views/RunStep')
    const html = renderToStaticMarkup(createElement(RunStep, { run: failing, status: 'done' }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('>Shell<')
    expect(html).toContain('npm test -- --run ...')
    expect(html).toContain('failed, exit 1')
    expect(html).toContain('38 s')
    const interrupted = renderToStaticMarkup(createElement(RunStep, { run: { ...failing, state: 'running', ms: null }, status: 'error' }))
    expect(interrupted).toContain('stopped')
  })

  it('a tool call row shows its own words and opens to what it was given and what came back', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { RunStep, RunDetail } = await import('../src/renderer/views/RunStep')
    const call: RunRecord = { kind: 'tool', label: 'memory search', input: 'query: VAT', stdout: 'm_1 VAT is 15%', stderr: '', exitCode: null, ms: 80, state: 'ok', trimmed: false }
    const row = renderToStaticMarkup(createElement(RunStep, { run: call, status: 'done', summary: 'Searched memory for "VAT"' }))
    expect(row).toContain('>memory search<')
    expect(row).toContain('Searched memory for &quot;VAT&quot;')
    expect(row).toContain('aria-expanded="false"')
    const bare = renderToStaticMarkup(createElement(RunStep, { run: { ...call, label: 'browser eval', input: 'document.title' }, status: 'done', summary: 'browser eval' }))
    expect(bare).toContain('document.title')
    const detail = renderToStaticMarkup(createElement(RunDetail, { run: call, id: 'y' }))
    expect(detail).toContain('What it was given')
    expect(detail).toContain('What came back')
    expect(detail).toContain('m_1 VAT is 15%')
    expect(detail).toContain('aria-label="Copy input"')
  })

  it('opens to the exact command, folder, exit, folded output, marked stderr and copy buttons', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { RunDetail } = await import('../src/renderer/views/RunStep')
    const html = renderToStaticMarkup(createElement(RunDetail, { run: failing, id: 'x' }))
    expect(html).toContain('npm test -- --run\n  --reporter=verbose</pre>')
    expect(html).toContain('C:\\Users\\sam\\shop')
    expect(html).toContain('exit 1')
    expect(html).toContain('Show all 40 lines (28 hidden)')
    expect(html).toContain('  line 1\n')
    expect(html).toContain('  line 40</pre>')
    expect(html).not.toContain('line 20\n')
    expect(html).toContain('Errors (stderr)')
    expect(html).toContain('run-sec err')
    expect(html).toContain('aria-label="Copy command"')
    expect(html).toContain('aria-label="Copy output"')
    expect(html).toContain('Output trimmed')
  })
})
