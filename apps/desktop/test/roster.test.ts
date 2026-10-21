/**
 * Helpers run on a list of models (Ayanda, 21 Oct 2026): per project or the main thread's, first = the default; the
 * main agent names one per job and is told what each is good for.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SETTINGS,
  GOOD_FOR_MAX,
  MAX_ROSTER,
  defaultGoodFor,
  findRosterEntry,
  mainPickOf,
  mainRosterOf,
  resolvePick,
  resolveRoster,
  rosterName,
  type AiAccount,
  type AiPicks,
  type LlmProvider,
  type Settings,
} from '@agent/core'

import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { helperModelLines } from '../src/main/runtime/prompt'
import { SettingsStore } from '../src/main/settings'

vi.mock('../src/renderer/bridge', () => ({ agent: { settings: { accounts: { listModels: async () => ({ ok: true, models: [], message: '' }) } } } }))

const { AiPickRows, ownRoster, withRoster } = await import('../src/renderer/ui/AiPickRows')

const ACCOUNTS: AiAccount[] = [
  { id: 'claude', label: 'Claude plan', kind: 'claude', model: 'opus', hasKey: false },
  { id: 'go', label: 'OpenCode Go', kind: 'api', provider: 'opencode_go', model: 'deepseek-v4.1-flash', hasKey: true },
]

function settings(ai: Partial<AiPicks> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    grantedFolders: [],
    accounts: ACCOUNTS,
    ai: { main: { account: 'claude', model: 'fable' }, helpers: { account: 'go', model: '' }, ...ai },
  }
}

const ROSTER = [
  { account: 'claude', model: 'opus', goodFor: 'research and careful writing' },
  { account: 'claude', model: 'sonnet', goodFor: '' },
  { account: 'go', model: 'deepseek-v4.1-flash', goodFor: 'quick lookups' },
]

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const each of stores.splice(0)) each.close()
  for (const each of dirs.splice(0)) rmSync(each, { recursive: true, force: true })
})

describe('the list of helper models', () => {
  it('is the one helpers pick until someone adds a second model, and follows the agent when that is empty', () => {
    expect(mainRosterOf(settings())).toEqual([{ account: 'go', model: '', goodFor: '' }])
    expect(mainRosterOf(settings({ helpers: { account: '', model: '' } }))).toEqual([{ account: 'claude', model: 'fable', goodFor: '' }])
  })

  it('makes its first model the helpers pick everywhere that still reads one', () => {
    const with3 = settings({ roster: ROSTER })
    expect(mainPickOf(with3, 'helpers')).toEqual({ account: 'claude', model: 'opus' })
    expect(resolvePick(with3, { main: { account: '', model: '' }, helpers: { account: '', model: '' }, roster: [ROSTER[2]!] }, 'helpers')).toEqual({ account: 'go', model: 'deepseek-v4.1-flash' })
  })

  it("a project's: its own list, else its one helpers pick, else its agent's, else the main thread's", () => {
    const base = settings({ roster: ROSTER })
    const none = { account: '', model: '' }
    expect(resolveRoster(base, { main: none, helpers: none, roster: [ROSTER[1]!] }).map((e) => e.model)).toEqual(['sonnet'])
    expect(resolveRoster(base, { main: none, helpers: { account: 'go', model: '' } })).toEqual([{ account: 'go', model: '', goodFor: '' }])
    expect(resolveRoster(base, { main: { account: 'claude', model: 'haiku' }, helpers: none })).toEqual([{ account: 'claude', model: 'haiku', goodFor: '' }])
    expect(resolveRoster(base, { main: none, helpers: none }).map((e) => e.model)).toEqual(['opus', 'sonnet', 'deepseek-v4.1-flash'])
    expect(resolveRoster(base, undefined)).toHaveLength(3)
  })

  it('is kept tidy when saved: at most 8, short notes, no repeats, only accounts that exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-'))
    dirs.push(dir)
    const store = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'pc' })
    const many = Array.from({ length: 12 }, (_, i) => ({ account: 'claude', model: `m${i}`, goodFor: 'x'.repeat(200) }))
    store.save({ accounts: ACCOUNTS, ai: { main: { account: 'claude', model: '' }, helpers: { account: '', model: '' }, roster: [{ account: 'gone', model: 'x', goodFor: '' }, ROSTER[0]!, ROSTER[0]!, ...many] } })
    const saved = store.get().ai.roster ?? []
    expect(saved).toHaveLength(MAX_ROSTER - 1)
    expect(saved.some((entry) => entry.account === 'gone')).toBe(false)
    expect(saved.filter((entry) => entry.model === 'opus')).toHaveLength(1)
    expect(Math.max(...saved.map((entry) => entry.goodFor.length))).toBe(GOOD_FOR_MAX)
    // The one helpers pick mirrors the first model.
    expect(store.get().ai.helpers).toEqual({ account: 'claude', model: 'opus' })
  })
})

describe('the agent names one per job', () => {
  const s = settings({ roster: ROSTER })
  it('by its full name, its model, its account when only one is on it, or a unique part', () => {
    const name = (wanted: string | undefined): string => {
      const found = findRosterEntry(s, ROSTER, wanted)
      return 'entry' in found ? found.entry.model : `error: ${found.error}`
    }
    expect(name(undefined)).toBe('opus')
    expect(name('Claude plan · sonnet')).toBe('sonnet')
    expect(name('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    expect(name('OpenCode Go')).toBe('deepseek-v4.1-flash')
    expect(name('sonn')).toBe('sonnet')
    expect(name('Claude plan')).toMatch(/matches more than one/)
    expect(name('gpt-9')).toMatch(/No helper model called "gpt-9". Use one of: "Claude plan · opus", "Claude plan · sonnet", "OpenCode Go · deepseek-v4.1-flash"/)
  })

  it('delegate starts each job on the model it names; an unknown name starts nothing', async () => {
    const store = new Store(':memory:')
    stores.push(store)
    const stub = { complete: async () => ({ message: { role: 'ASSISTANT', blocks: [] }, stopReason: 'end' }) } as unknown as LlmProvider
    const manager = new HelperManager({
      store,
      settings: { get: () => ({ ...settings({ roster: [{ account: 'go', model: 'deepseek-v4.1-flash', goodFor: '' }, { account: 'go', model: 'kimi-k3', goodFor: 'long writing' }] }) }) },
      secrets: { get: () => 'test-key' },
      providerFactory: () => stub,
      workerTools: [],
      deliver: () => undefined,
      platform: 'linux',
      timeZone: 'UTC',
      // Nothing runs: only what each job was started on matters here.
      maxConcurrent: 0,
    })
    const out = await manager.delegate([
      { label: 'Find prices', brief: 'Find the prices.' },
      { label: 'Write it up', brief: 'Write the report.', model: 'kimi' },
    ])
    expect(out).toMatch(/Started: .*Find prices.* on OpenCode Go · deepseek-v4\.1-flash.*Write it up.* on OpenCode Go · kimi-k3/)
    const rows = (await store.list('chat_item')).filter((row) => row.kind === 'helper')
    const metas = rows.map((row) => JSON.parse(row.meta) as Record<string, unknown>)
    expect(metas.map((meta) => meta['model']).sort()).toEqual(['deepseek-v4.1-flash', 'kimi-k3'])
    expect(metas.find((meta) => meta['model'] === 'kimi-k3')?.['pick']).toEqual({ account: 'go', model: 'kimi-k3' })
    const before = rows.length
    expect(await manager.delegate([{ label: 'X', brief: 'Do x.', model: 'opus-9' }])).toMatch(/No helper model called "opus-9".*Nothing was started/)
    expect((await store.list('chat_item')).filter((row) => row.kind === 'helper')).toHaveLength(before)
  })
})

describe('the prompt', () => {
  it('lists the models with what each is good for, and how to pick', () => {
    const s = settings({ roster: ROSTER })
    const lines = helperModelLines(
      ROSTER.map((entry) => ({ name: rosterName(s, entry), goodFor: entry.goodFor || defaultGoodFor(entry.model) })),
      '',
    ).join('\n')
    expect(lines).toContain('HELPER MODELS')
    expect(lines).toContain('"Claude plan · opus" (default): research and careful writing')
    expect(lines).toContain('"Claude plan · sonnet": balanced: most jobs')
    expect(lines).toContain('"OpenCode Go · deepseek-v4.1-flash": quick lookups')
    expect(lines).toContain('Do not mention which model you picked unless the user asks')
  })

  it('one model needs no choosing', () => {
    expect(helperModelLines([{ name: 'OpenCode Go · deepseek-v4.1-flash', goodFor: 'x' }], '').join('\n')).toBe('- Every helper runs on OpenCode Go · deepseek-v4.1-flash with the working tools. Leave `model` out of a brief.')
  })

  it('guesses what an unnamed model is good for from its name', () => {
    expect(defaultGoodFor('claude-opus-5-5')).toMatch(/strongest/)
    expect(defaultGoodFor('claude-haiku-5-5')).toMatch(/fast and cheap/)
    expect(defaultGoodFor('fable')).toMatch(/balanced/)
  })
})

describe('the helpers row', () => {
  it('shows each model as a card with what it is good for, the default first, and Add a model', () => {
    const s = settings({ roster: ROSTER })
    const html = renderToStaticMarkup(createElement(AiPickRows, { settings: s, picks: s.ai, onChange: () => undefined }))
    expect(html).not.toContain('<select')
    expect(html.match(/class="rost-row/g)).toHaveLength(3)
    expect(html).toContain('Default</span>')
    expect(html).toContain('value="research and careful writing"')
    expect(html).toContain('Make Claude plan · sonnet the default')
    expect(html).toContain('Remove OpenCode Go · deepseek-v4.1-flash')
    expect(html).toContain('Add a model')
  })

  it("in a project with none of its own: follows the main thread's list, read-only, until it chooses", () => {
    const s = settings({ roster: ROSTER })
    const none = { account: '', model: '' }
    const html = renderToStaticMarkup(createElement(AiPickRows, { settings: s, picks: { main: none, helpers: none }, inherit: s.ai, onChange: () => undefined }))
    expect(html).toContain('Same as the main thread</b>')
    expect(html).toContain('opus · sonnet · deepseek-v4.1-flash')
    expect(html).toContain('Choose for this project')
    expect(html).not.toContain('class="rost-row')
  })

  it('writes a list with the first as the helpers pick, and reads one back', () => {
    const s = settings()
    const next = withRoster(s.ai, [ROSTER[2]!, ROSTER[0]!])
    expect(next.helpers).toEqual({ account: 'go', model: 'deepseek-v4.1-flash' })
    expect(ownRoster(s, next).map((entry) => entry.model)).toEqual(['deepseek-v4.1-flash', 'opus'])
    expect(withRoster(s.ai, []).helpers).toEqual({ account: '', model: '' })
  })
})
