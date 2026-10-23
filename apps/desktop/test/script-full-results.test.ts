/**
 * run_script reads whole results (23 Oct 2026): a connected app's result was cut at 20,000 characters before a script
 * saw it, mid-string ("Unterminated string in JSON at position 20000" on a calendar list). Inside a script every tool
 * that trims for a model hands back all of it, parsed; only the script's own return value is capped for the model.
 * A cut, where one must stay, is a valid object with truncated: true, never broken JSON.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as core from '@agent/core'
import { schema, withScriptTools, type Tool } from '@agent/core'

import { AppsService } from '../src/main/apps/service'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { appTools } from '../src/main/tools/apps'
import { callLearned, type PageRunner } from '../src/main/tools/webapps'
import { testContext, toolNamed } from './support'

// Read loosely so this file also runs (and shows each red) against a build from before these existed.
const loose = core as unknown as { SCRIPT_INNER_RESULT_CAP?: number; clipResult?: (text: string, limit: number) => string }
const SCRIPT_INNER_RESULT_CAP = loose.SCRIPT_INNER_RESULT_CAP ?? 2_000_000
const clipResult = loose.clipResult ?? ((text: string, limit: number): string => text.slice(0, limit))

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-full-results-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 400 calendar events with quotes and line breaks in them: about 90,000 characters of JSON. */
const EVENTS = Array.from({ length: 400 }, (_, i) => ({
  id: `ev${i}`,
  summary: `Meeting "${i}" with the team`,
  description: `Line one\nLine two of meeting ${i}, with a "quote" and a \\ backslash`,
  start: { dateTime: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T09:00:00+02:00` },
}))

function calendarApps(): AppsService {
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/connected_accounts')) {
      return new Response(JSON.stringify({ items: [{ id: 'ca_cal', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' }, user_id: 'u1' }] }), { status: 200 })
    }
    if (url.pathname.includes('/tools/execute/')) {
      return new Response(JSON.stringify({ successful: true, data: { calendars: ['primary'], items: EVENTS } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return new AppsService({
    secrets: { get: (name) => (name === 'composioKey' ? 'ak_test' : null), set: () => undefined, delete: () => undefined },
    file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
    learned: new LearnedStore(join(dir, 'learned.json')),
    openExternal: async () => undefined,
    fetchImpl,
  })
}

function big(name: string, chars: number): Tool {
  return {
    spec: { name, description: name, schema: schema([], {}) },
    run: async () => JSON.stringify({ rows: Array.from({ length: Math.ceil(chars / 20) }, (_, i) => `row-"${i}"-padding`) }),
  }
}

describe('run_script reads whole tool results', () => {
  it('a connected-app result past 20,000 characters reaches the script whole, as parsed JSON', async () => {
    const tools = appTools(calendarApps())
    const run = toolNamed(withScriptTools(tools), 'run_script')
    const code = `const r = await tools.apps_run({ slug: 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', arguments: {} }); return { type: typeof r, count: r.items ? r.items.length : -1, last: r.items ? r.items[399].summary : '' }`
    const out = await run.run({ code }, testContext())
    expect(out).toContain('Result: {"type":"object","count":400,"last":"Meeting \\"399\\" with the team"}')
  })

  it('the same call made by the model directly is cut to 20,000 characters as valid JSON with truncated: true', async () => {
    const out = await toolNamed(appTools(calendarApps()), 'apps_run').run({ slug: 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', arguments: {} }, testContext())
    expect(out.length).toBeLessThanOrEqual(20_000)
    const parsed = JSON.parse(out) as { truncated: boolean; totalChars: number; partial: string }
    expect(parsed.truncated).toBe(true)
    expect(parsed.totalChars).toBeGreaterThan(20_000)
    expect(parsed.partial.startsWith('{"calendars":["primary"]')).toBe(true)
  })

  it('a learned-app tool result is whole inside a script too', async () => {
    const value = { items: EVENTS }
    const runner: PageRunner = { ensure: async () => undefined, run: async () => ({ ok: true, v: value }), evaluate: async () => null }
    const app = { id: 'cal', name: 'Cal', startUrl: 'https://cal.example', about: '', tools: [], trusted: true, updatedAt: 0 }
    const tool = { name: 'list', description: 'list', params: {}, required: [], js: 'return 1', readOnly: true }
    const learned: Tool = { spec: { name: 'webapp_run', description: 'x', schema: schema([], {}) }, run: (_input, ctx) => callLearned(app, tool, {}, ctx, runner) }
    const out = await toolNamed(withScriptTools([learned]), 'run_script').run({ code: `const r = await tools.webapp_run({}); return r.items.length` }, testContext())
    expect(out).toContain('Result: 400')
    const direct = await learned.run({}, testContext())
    expect((JSON.parse(direct) as { truncated: boolean }).truncated).toBe(true)
  })

  it('past the script limit a result is a valid object with truncated: true, never a cut string', async () => {
    const run = toolNamed(withScriptTools([big('huge', SCRIPT_INNER_RESULT_CAP + 50_000)]), 'run_script')
    const out = await run.run({ code: `const r = await tools.huge({}); return { type: typeof r, truncated: r.truncated, total: r.totalChars > ${SCRIPT_INNER_RESULT_CAP} }` }, testContext())
    expect(out).toContain('Result: {"type":"object","truncated":true,"total":true}')
  }, 60_000)

  it('clipResult keeps JSON valid and within the limit, whatever the text holds', () => {
    const text = JSON.stringify({ q: '"'.repeat(30_000), n: '\n'.repeat(30_000) })
    for (const limit of [1_000, 5_000, 20_000]) {
      const cut = clipResult(text, limit)
      expect(cut.length).toBeLessThanOrEqual(limit)
      expect((JSON.parse(cut) as { truncated: boolean }).truncated).toBe(true)
    }
    expect(clipResult('short', 10)).toBe('short')
    expect(clipResult('plain text '.repeat(100), 50)).toMatch(/^plain text .*\n\.\.\.\(cut: 1100 characters in all/s)
  })
})
