/**
 * A report reads beside the chat, drawn with OpenUI: markdown tables become Table cards, ```openui-lang blocks are
 * drawn as cards, links open, rules are rules. The browser's mute is remembered across restarts.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { SiteStore } from '../src/main/browser/sites'
import { plainPreview, reportText } from '../src/renderer/lib/report'
import { renderSource } from '../src/renderer/openui/lang'
import { reportParts, tablesToOpenUi } from '../src/renderer/openui/report'
import { ReportBody } from '../src/renderer/openui/ReportBody'
import { usePanel } from '../src/renderer/state/usePanel'
import { Markdown } from '../src/renderer/ui/Markdown'

// The reader opens links and sends follow-ups through the app bridge; here they go nowhere.
vi.mock('../src/renderer/bridge', () => ({
  agent: { shell: { openExternal: async () => undefined } },
  chat: { send: async () => undefined },
}))

// The shape of the TikTok report that came out as raw pipes.
const TIKTOK = [
  '## 1. The reach is enormous, the depth is thin',
  'The two searches returned 30 videos. The top of the pile by plays:',
  '| Video | Creator | Plays | Likes |',
  '|---|---|---|---|',
  '| Install Claude Code for complete beginners | ai.with.ni | 1,200,000 | 50,000 |',
  '| Five things to do when you start using **Claude** | taki.gpt | 905,000 | 40,000 |',
  '',
  '---',
  'Source: [TikTok search](https://www.tiktok.com/search?q=claude%20code)',
].join('\n')

describe('report tables', () => {
  it('turns a markdown table into an OpenUI Table card, numbers as numbers', () => {
    const parts = reportParts(TIKTOK)
    expect(parts.map((part) => part.kind)).toEqual(['prose', 'openui', 'prose'])
    const block = parts[1]
    if (block?.kind !== 'openui') throw new Error('no block')
    const root = renderSource(block.source).root
    expect(root?.type).toBe('Stack')
    const card = (root?.props['children'] as Array<{ type: string; props: Record<string, unknown> }>)[0]
    expect(card?.type).toBe('Card')
    const table = (card?.props['children'] as Array<{ type: string; props: Record<string, unknown> }>)[0]
    expect(table?.type).toBe('Table')
    const cols = table?.props['columns'] as Array<{ props: Record<string, unknown> }>
    expect(cols.map((col) => col.props['label'])).toEqual(['Video', 'Creator', 'Plays', 'Likes'])
    expect(cols[2]?.props['data']).toEqual([1200000, 905000])
    // Bold inside a cell is just the words in a table cell.
    expect(cols[0]?.props['data']).toEqual(['Install Claude Code for complete beginners', 'Five things to do when you start using Claude'])
  })

  it('leaves code and the agent\'s own card blocks alone', () => {
    const md = ['```', '| a | b |', '|---|---|', '```', '```openui-lang', 'root = Stack([c])', '```'].join('\n')
    expect(tablesToOpenUi(md)).toBe(md)
  })

  it('draws the whole report: a real table, no raw pipes, a rule and a link that opens', () => {
    const html = renderToStaticMarkup(createElement(ReportBody, { markdown: TIKTOK }))
    expect(html).toContain('<table class="oui-table"')
    expect(html).toContain('1 200 000')
    expect(html).not.toContain('|---|')
    expect(html).toContain('<hr class="md-hr"/>')
    expect(html).toContain('title="https://www.tiktok.com/search?q=claude%20code"')
    expect(html).toContain('>TikTok search</button>')
  })

  it('draws an openui-lang chart the agent wrote in the report', () => {
    const md = ['Plays by video:', '```openui-lang', 'root = Stack([c])', 'c = Card([h, b])', 'h = CardHeader("Plays")', 'b = BarChart(["A", "B"], [s])', 's = Series("Plays", [12, 9])', '```'].join('\n')
    const html = renderToStaticMarkup(createElement(ReportBody, { markdown: md }))
    expect(html).toContain('Plays by video:')
    expect(html).not.toContain('openui-lang')
    expect(html).not.toContain('oui-raw')
  })

  it('previews the report in plain words, with no pipes or markup', () => {
    const item = { id: 'r1', kind: 'report', text: 'TikTok research', meta: JSON.stringify({ title: 'TikTok research', markdown: TIKTOK }), createdAt: 1, updatedAt: 1 }
    const preview = plainPreview(reportText(item as never).markdown)
    expect(preview).toContain('The reach is enormous')
    expect(preview).not.toContain('|')
    expect(preview).not.toContain('](')
  })

  it('a plain Markdown block without a link handler shows only the words of a link', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: 'See [the page](https://example.com).' }))
    expect(html).toContain('See the page.')
  })
})

describe('the report in the side panel', () => {
  it('takes the helper\'s place, and a helper takes the report\'s', () => {
    usePanel.getState().openHelper('h1')
    usePanel.getState().openReport('r1')
    expect(usePanel.getState()).toMatchObject({ report: 'r1', helper: null })
    usePanel.getState().openHelper('h2')
    expect(usePanel.getState()).toMatchObject({ report: null, helper: 'h2' })
    usePanel.getState().closeHelper()
    usePanel.getState().openReport('r1')
    usePanel.getState().closeReport()
    expect(usePanel.getState().report).toBeNull()
  })
})

describe('the browser mute', () => {
  it('is off by default, remembered across restarts, and turned back on', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sites-')), 'browser-sites.json')
    const store = new SiteStore(file)
    expect(store.muted()).toBe(false)
    store.setMuted(true)
    expect(new SiteStore(file).muted()).toBe(true)
    store.setMuted(false)
    expect(new SiteStore(file).muted()).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))['muted']).toBeUndefined()
  })
})
