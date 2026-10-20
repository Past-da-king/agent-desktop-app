// OpenUI in the chat, ported from the phone app's OpenUiSpikeTest, OpenUiButtonsAndPromptTest, OpenUiRealCasesTest,
// ProductRowTest and AskNoTest. The fixtures in test/openui/ are the phone's (answers a real model wrote, with every
// name and amount swapped for demo data).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@agent/core'

import { OPENUI_PROMPT, quietTapNote } from '../src/main/runtime/openui-prompt'
import { buildSystemPrompt } from '../src/main/runtime/prompt'
import { DEMO_TAPPED, openUiDemo } from '../src/renderer/bridge/openui-demo'
import { askProgram } from '../src/renderer/openui/ask'
import { iconForAction, iconForText, navigates } from '../src/renderer/openui/icon-words'
import {
  buttonsLayout,
  factRows,
  factsLayout,
  heroSplit,
  isNode,
  LIBRARY,
  messageFor,
  parse,
  plainText,
  render,
  renderSource,
  splitMessage,
  starKinds,
  tapsIn,
  type UiNode,
} from '../src/renderer/openui/lang'
import { OpenUiBlock, OpenUiProvider } from '../src/renderer/openui/OpenUiView'
import { fit, hasRefusal, NO, withNo } from '../src/shared/ask-options'

const here = path.dirname(fileURLToPath(import.meta.url))
const res = (name: string): string => fs.readFileSync(path.join(here, 'openui', name), 'utf8')
const block = (name: string): string => {
  const part = splitMessage(res(`${name}.md`)).find((p) => p.kind === 'openui')
  if (part === undefined || part.kind !== 'openui') throw new Error(`${name} has no block`)
  return part.source
}
const kids = (n: UiNode | null, key = 'children'): UiNode[] => (Array.isArray(n?.props[key]) ? (n?.props[key] as unknown[]).filter(isNode) : [])
const html = (source: string, handlers = {}): string =>
  renderToStaticMarkup(createElement(OpenUiProvider, { value: handlers }, createElement(OpenUiBlock, { source })))

/** An answer in OpenUI's inline mode: prose, then a fenced program (the phone's OpenUiSpikeTest.ANSWER). */
const ANSWER = `Here's where your money went in **September**. Groceries and transport are most of it.

\`\`\`openui-lang
root = Card([header, chart, split, table, tip, actions], sources)
header = CardHeader("September spending", "R 7 640 across 41 transactions")
chart = BarChart(["Jul", "Aug", "Sep"], [spend, budget])
spend = Series("Spent", [6900, 8120, 7640])
budget = Series("Budget", [7500, 7500, 7500])
split = PieChart(["Groceries", "Transport", "Data", "Eating out"], [2950, 2210, 1180, 1300], "donut")
table = Table([Col("Merchant", ["Checkers", "Bolt", "Vodacom", "Nando's"]), Col("Visits", [9, 14, 2, 4]), Col("Total (R)", [2950, 2210, 1180, 860])])
tip = Callout("warning", "Bolt is up 38% on August", "14 trips, mostly weekday mornings. A monthly MyCiTi pass would cost R 1 400.")
actions = Buttons([setBudget, details])
setBudget = Button("Set a R 7 000 budget", @ToAssistant("Set my monthly budget to R 7 000 and warn me at 80%"))
details = Button("Show every Bolt trip", @ToAssistant("List every Bolt trip in September"), "secondary")
sources = [{ title: "MyBank statement", sourceName: "MyBank", url: "https://mybank.example" }]
\`\`\``

describe('OpenUI Lang parser', () => {
  it('parses the sample into a tree', () => {
    const src = ANSWER.split('```openui-lang')[1]?.split('```')[0] ?? ''
    const r = render(parse(src))
    expect(r.errors).toEqual([])
    expect(r.root?.type).toBe('Card')
    expect(kids(r.root).map((k) => k.type)).toEqual(['CardHeader', 'BarChart', 'PieChart', 'Table', 'Callout', 'Buttons'])
    const btn = kids(kids(r.root).at(-1) ?? null, 'buttons')[0]
    expect(btn?.props['action']).toEqual({ kind: 'assistant', text: 'Set my monthly budget to R 7 000 and warn me at 80%', context: null })
  })

  it('still renders a half-streamed program', () => {
    // Cut mid-string and mid-list: the open string and brackets close themselves, a pending name is just left out.
    const p = parse('root = Card([header, chart])\nheader = CardHeader("Monthly Rev')
    expect(p.incomplete).toBe(true)
    const r = render(p)
    expect(kids(r.root)).toHaveLength(1)
    expect(kids(r.root)[0]?.props['title']).toBe('Monthly Rev')
    expect([...r.unresolved]).toEqual(['chart'])
  })

  it('drops only a broken line', () => {
    const r = render(parse('root = Card([a, b, c])\na = TextContent("ok")\nb = TextContent("bad" ))) oops\nc = Wobble(1)'))
    expect(kids(r.root).map((k) => k.type)).toEqual(['TextContent'])
    expect(r.errors.some((e) => e.includes('unknown-component Wobble'))).toBe(true)
    expect(r.errors.some((e) => e.startsWith('line 3'))).toBe(true)
  })

  it('uses names before they are defined, and a later binding wins', () => {
    const r = render(parse('x = TextContent("first")\nroot = Card([x])\nx = TextContent("second")'))
    expect(kids(r.root)[0]?.props['text']).toBe('second')
  })

  it('splits the fence out of the markdown, and an unclosed fence is still a block', () => {
    const parts = splitMessage(ANSWER)
    expect(parts.map((p) => p.kind)).toEqual(['prose', 'openui'])
    const streaming = splitMessage(ANSWER.slice(0, ANSWER.lastIndexOf('```')))
    expect(streaming.at(-1)).toMatchObject({ kind: 'openui', closed: false })
  })

  it('reads escapes, unicode, comments, negative and exponent numbers', () => {
    const r = render(parse('// a comment\nroot = Card([t, n])\nt = TextContent("a \\"q\\" \\u0041\\nB") // trailing\nn = EntityList([{left: "x", right: -1.5e2}])'))
    expect(r.errors).toEqual([])
    expect(kids(r.root)[0]?.props['text']).toBe('a "q" A\nB')
    expect(factRows(kids(r.root)[1] as UiNode)[0]?.right).toBe('-150')
  })

  it('never throws on garbage, cycles or a missing root', () => {
    for (const junk of ['', ')))', 'root = ', 'root = Card([', '= = =', 'root = [}', '"unterminated', 'a = b\nb = a\nroot = Card([a])']) {
      expect(() => renderSource(junk)).not.toThrow()
    }
    expect(renderSource('a = b\nb = a\nroot = Card([a])').errors.some((e) => e.startsWith('cycle'))).toBe(true)
    expect(renderSource('x = TextContent("no root")').errors).toContain('no-root')
    // With no root statement, the first root-type call is the entry.
    expect(renderSource('main = Stack([c])\nc = Card([])').root?.type).toBe('Stack')
  })

  it('every real model answer parses cleanly', () => {
    for (const name of ['flats', 'flight', 'approval', 'helpers', 'money', 'products']) {
      const r = renderSource(block(name))
      expect(r.root, name).not.toBeNull()
      expect(r.errors, name).toEqual([])
      expect([...r.unresolved], name).toEqual([])
    }
  })
})

describe('What a tap sends', () => {
  it('Book viewing asks the agent about that flat only', () => {
    const taps = tapsIn(renderSource(block('flats')).root)
    const book = taps.filter((t) => t.label === 'Book viewing')
    expect(book).toHaveLength(3)
    const msg = book[0]?.message ?? ''
    expect(msg.startsWith('Book a viewing')).toBe(true)
    expect(msg).toContain('RR1000001')
    expect(msg).toContain('R7,200')
    expect(msg).not.toMatch(/RR1000002|RR1000003/)
  })

  it('Open listing only opens the link and sends nothing', () => {
    const open = tapsIn(renderSource(block('flats')).root).find((t) => t.label === 'Open listing')
    expect(open?.actions).toEqual([{ kind: 'url', url: 'https://flats.example/listing/RR1000001' }])
    expect(open?.message).toBeNull()
  })

  it('Details names the job', () => {
    const details = tapsIn(renderSource(block('helpers')).root).filter((t) => t.label === 'Details')
    expect(details[1]?.message).toContain('Lindiwe')
  })

  it('Send only asks the agent, it never sends by itself', () => {
    const send = tapsIn(renderSource(block('approval')).root).find((t) => t.label === 'Send')
    expect(send?.message).toContain('Send the invoice email to Lerato')
    expect(send?.message).toContain('March invoice')
    expect(send?.actions.every((a) => a.kind === 'assistant')).toBe(true)
  })

  it('names the card, item and context once', () => {
    const m = messageFor({ text: 'Research more', context: { listing: 'RR1000001', item: 'R7,200 1-bed' } }, { card: 'Flats in Northcliff', item: 'R7,200 1-bed' })
    expect(m).toBe('Research more\n↳ R7,200 1-bed · Flats in Northcliff · listing: RR1000001')
    expect(messageFor({ text: 'Do it', context: null }, {})).toBe('Do it')
  })

  it('Add to cart names the product it belongs to', () => {
    const add = tapsIn(renderSource(block('products')).root).filter((t) => t.label === 'Add to cart')
    const msg = add[0]?.message ?? ''
    expect(msg.startsWith('Add to cart')).toBe(true)
    expect(msg).toMatch(/Orbit M3/)
    expect(msg).toContain('R899')
    expect(msg).toContain('DM-1001')
    expect(msg).not.toContain('Glide')
  })

  it('a button with no action sends its own label, as the spec says', () => {
    const taps = tapsIn(renderSource('root = Card([Buttons([Button("Tell me more")])])').root)
    expect(taps[0]?.message).toBe('Tell me more')
  })

  it('places that cannot draw cards get titles, not code', () => {
    const t = plainText(res('flats.md'))
    expect(t).not.toMatch(/openui|root =/)
    expect(t.startsWith('Here are three')).toBe(true)
    expect(t).toContain('R7,200 a month')
  })

  it('the model is told a tap was a button tap, not something typed', () => {
    const note = quietTapNote('Add to cart', 'Add to cart\n↳ Orbit M3')
    expect(note).toContain('[The user tapped "Add to cart" on a card you drew.')
    expect(note).toContain("don't quote it back")
    expect(note.endsWith('Add to cart\n↳ Orbit M3')).toBe(true)
  })
})

describe('How the cards are laid out', () => {
  it('a leading amount in a header is the hero figure', () => {
    expect(heroSplit('R7,200 a month')).toEqual(['R7,200', 'a month'])
    expect(heroSplit('R 1 240.50')).toEqual(['R 1 240.50', ''])
    expect(heroSplit('MyBank main account')).toBeNull()
  })

  it('short facts become tiles and skip the amount the header shows; long ones stay a list', () => {
    const flat = kids(kids(renderSource(block('flats')).root)[0] ?? null).find((k) => k.type === 'EntityList') as UiNode
    const tiles = factsLayout(factRows(flat), 'R7,200', true)
    expect(tiles.mode).toBe('tiles')
    expect(tiles.rows.map((r) => r.left)).toEqual(['Bedrooms', 'Size', 'Available'])
    const approval = kids(kids(renderSource(block('approval')).root)[0] ?? null).find((k) => k.type === 'EntityList') as UiNode
    expect(factsLayout(factRows(approval), null, true).mode).toBe('list')
  })

  it('a first money row with no header amount is drawn big', () => {
    const money = kids(kids(renderSource(block('money')).root)[0] ?? null).filter((k) => k.type === 'EntityList')
    const first = factsLayout(factRows(money[0] as UiNode), null, true)
    expect(first.bigFirst).toBe(true)
    expect(first.lines[0]?.map((r) => r.right)).toEqual(['R1,240.50'])
    expect(factsLayout(factRows(money[1] as UiNode), null, false).mode).toBe('list')
  })

  it('two short choices sit side by side, more stack', () => {
    expect(buttonsLayout(['Approve', 'Decline'], undefined)).toBe('row')
    expect(buttonsLayout(['Show every Bolt trip', 'Set a budget'], undefined)).toBe('column')
    expect(buttonsLayout(['Send', 'Edit', 'Not now'], 'row')).toBe('column')
    expect(buttonsLayout(['Go'], undefined)).toBe('single')
  })

  it('icons come from the words, and navigation buttons are quiet', () => {
    expect(iconForText('Bedrooms')).toBe('bed')
    expect(iconForText('Deposit')).toBe('savings')
    expect(iconForText('upload')).toBeNull()
    expect(iconForText('map-pin')).toBe('place')
    expect(iconForAction('Add to cart')).toBe('addCart')
    expect(iconForAction('No')).toBe('close')
    expect(navigates('Open listing')).toBe(true)
    expect(navigates('Book viewing')).toBe(false)
  })

  it('stars: whole, half and empty out of five', () => {
    expect(starKinds(4.6)).toEqual([2, 2, 2, 2, 1])
    expect(starKinds(3.9)).toEqual([2, 2, 2, 2, 0])
    expect(starKinds(0)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('The renderer', () => {
  it('a row of products shows four, with price, old price, tag and stars, and no invented rating', () => {
    const r = renderSource(block('products'))
    expect(kids(r.root).map((k) => k.type)).toEqual(['Product', 'Product', 'Product', 'Product'])
    expect(kids(r.root)[0]?.props['rating']).toBe(4.6)
    expect(kids(r.root)[3]?.props['rating']).toBeUndefined()
    const out = html(block('products'))
    expect(out).toContain('R899')
    expect(out).toContain('R1,099')
    expect(out).toContain('Best value')
    expect(out).toContain('Rated 4.6 out of 5, 1,204 reviews')
    expect(out.match(/Rated /g)).toHaveLength(3)
    expect(out).toContain('oui-swipe products')
  })

  it('draws every real answer without throwing, with icon chips and hero figures', () => {
    for (const name of ['flats', 'flight', 'approval', 'helpers', 'money', 'products']) {
      expect(() => html(block(name)), name).not.toThrow()
    }
    const flats = html(block('flats'))
    expect(flats).toContain('oui-hero-n">R7,200')
    expect(flats).toContain('oui-chip-bg')
    expect(flats).toContain('oui-tile')
    expect(html(block('approval'))).toContain('oui-group')
  })

  it('a tapped button says Sent and cannot be tapped again', () => {
    const out = html(block('products'), { act: () => undefined, tapped: new Set([tapsIn(renderSource(block('products')).root)[0]?.message ?? '']) })
    expect(out.match(/>Sent</g)).toHaveLength(1)
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*?Sent/)
  })

  it('a program that draws nothing keeps its words, and a streaming one shows a placeholder', () => {
    expect(html('this is not a program')).toContain('oui-raw')
    const pending = renderToStaticMarkup(createElement(OpenUiBlock, { source: 'root = Sta', streaming: true }))
    expect(pending).toContain('oui-pending')
  })

  it('the demo thread taps match what a real tap would send', () => {
    const mice = openUiDemo(0).find((item) => item.id === 'ou6')
    const source = splitMessage(mice?.text ?? '').find((p) => p.kind === 'openui')
    const taps = tapsIn(renderSource(source?.kind === 'openui' ? source.source : '').root)
    expect(taps[0]?.message).toBe(DEMO_TAPPED)
    for (const item of openUiDemo(0)) {
      for (const part of splitMessage(item.text)) {
        if (part.kind === 'openui') expect(renderSource(part.source).errors, item.id).toEqual([])
      }
    }
  })
})

describe('Ask cards always have a No', () => {
  it('No is added last when the agent offered none', () => {
    expect(withNo(['Open browser', 'Done', 'Skip'])).toEqual(['Open browser', 'Done', 'Skip', 'No'])
    expect(withNo(['Red', 'Blue'])).toEqual(['Red', 'Blue', 'No'])
  })

  it('an existing way to refuse is left alone', () => {
    for (const o of [['Allow', 'No'], ['Open settings', 'Not now'], ['Approve', 'Decline'], ['Yes', 'No thanks']]) expect(withNo(o)).toEqual(o)
    expect(withNo(withNo(['Open browser', 'Done', 'Skip']))).toEqual(['Open browser', 'Done', 'Skip', 'No'])
    expect(hasRefusal(['Never mind.'])).toBe(true)
  })

  it('a notification keeps No among its three buttons', () => {
    expect(fit(['Open browser', 'Done', 'Skip', 'No'], 3)).toEqual(['Open browser', 'Done', 'No'])
    expect(fit(['Allow', 'Not now'], 3)).toEqual(['Allow', 'Not now'])
  })

  it('the program parses even with quotes and newlines, and shows every button with No last', () => {
    const src = askProgram('Needs you', 'Nova: needs a "code"', 'Can I read your "Gmail"?\nSecond line \\ here', ['Open browser', 'Done'])
    const r = renderSource(src)
    expect(r.errors).toEqual([])
    expect([...r.unresolved]).toEqual([])
    const labels = tapsIn(r.root).map((t) => t.label)
    expect(labels).toEqual(['Open browser', 'Done', NO])
  })

  it('a tap answers the question and posts no message', () => {
    const picked: string[] = []
    const sent: string[] = []
    const src = askProgram('Needs you', null, 'Can I look at your photos?', ['Allow', 'No'])
    // Only one No when the agent already offered one.
    expect(tapsIn(renderSource(src).root).filter((t) => t.label === 'No')).toHaveLength(1)
    const out = html(src, { pick: (t: string) => picked.push(t), send: (t: string) => sent.push(t) })
    expect(out).toContain('Allow')
    // A picking card never says Sent: the button is an answer, not a message.
    expect(out).not.toContain('Sent')
    expect(sent).toEqual([])
  })
})

describe('What the agent is taught', () => {
  const base = {
    settings: { ...DEFAULT_SETTINGS, grantedFolders: [] },
    now: new Date('2026-10-20T14:58:00Z'),
    platform: 'win32',
    memories: [],
    goals: [],
    tasks: [],
    latestUserText: 'find me a flat',
    timeZone: 'Africa/Johannesburg',
  }

  it('teaches only what the app draws, with no dashes and no charts pushed', () => {
    const p = OPENUI_PROMPT
    expect(p.startsWith('GENERATIVE UI')).toBe(true)
    for (const phrase of ['UI BY DEFAULT', 'One Card per item', 'approval flow', 'quietly, marked as a button tap']) expect(p).toContain(phrase)
    expect(p).not.toMatch(/[—–]/)
    const signatures = new Set([...p.matchAll(/^([A-Z][A-Za-z]+)\(/gm)].map((m) => m[1] ?? ''))
    expect(signatures.size).toBeGreaterThanOrEqual(20)
    expect([...signatures].filter((s) => !(s in LIBRARY))).toEqual([])
    expect([...signatures].some((s) => s.endsWith('Chart'))).toBe(false)
  })

  it('teaches products for shopping, without invented numbers', () => {
    expect(OPENUI_PROMPT).toContain('Product(image?: string, name: string, price?: string, rating?: number')
    expect(OPENUI_PROMPT).toContain('one Product per item')
    expect(OPENUI_PROMPT).toContain('never invent numbers')
  })

  it('the main agent and routines get it, helpers do not', () => {
    expect(buildSystemPrompt({ ...base, role: 'main' })).toContain('GENERATIVE UI')
    expect(buildSystemPrompt({ ...base, role: 'routine', routineName: 'Morning brief' })).toContain('GENERATIVE UI')
    expect(buildSystemPrompt({ ...base, role: 'helper', helper: { label: 'Prices', brief: 'check prices' } })).not.toContain('GENERATIVE UI')
  })
})
