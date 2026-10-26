// Markdown in a chat card must always read as stacked, full-width blocks.
//
// The bug (26 Oct 2026): a MarkDownRenderer('Dear ...,\n\n<para>\n\n<para>\n\nKind regards,...', 'sunk') was drawn as a
// two-column grid, so a letter read like a table. Its box carried the bare class `md`, which is also the class of a
// page layout (`.md{display:grid;grid-template-columns:...}` for the tasks and memory pages). Any CSS rule written for
// something else (a page layout, a card's children, a generic `> *`) can do the same to a markdown block.
//
// So this test renders every markdown host the chat has (MarkDownRenderer in each variant, TextContent in each size,
// prose beside a card, a report's prose) with every block kind the markdown makes, then checks EVERY rule in the
// renderer's CSS against the rendered elements: none may lay the markdown box out as a grid or a flex row, none may
// put its paragraphs, lists, headings or code blocks into columns, and the box must say `display:block` itself.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import postcss, { type Rule } from 'postcss'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OpenUiBlock } from '../src/renderer/openui/OpenUiView'
import { Markdown } from '../src/renderer/ui/Markdown'

const here = path.dirname(fileURLToPath(import.meta.url))
const stylesDir = path.join(here, '../src/renderer/styles')

// ---------- a tiny DOM from React's static markup ----------
interface El {
  tag: string
  classes: Set<string>
  parent: El | null
  children: El[]
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'col', 'wbr'])

function dom(html: string): El {
  const root: El = { tag: '#root', classes: new Set(), parent: null, children: [] }
  let cur = root
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const [, close, rawTag, attrs, selfClose] = m
    const tag = (rawTag ?? '').toLowerCase()
    if (close === '/') {
      if (cur.parent !== null) cur = cur.parent
      continue
    }
    const cls = /\sclass="([^"]*)"/.exec(attrs ?? '')?.[1] ?? ''
    const el: El = { tag, classes: new Set(cls.split(/\s+/).filter(Boolean)), parent: cur, children: [] }
    cur.children.push(el)
    if (selfClose !== '/' && !VOID.has(tag)) cur = el
  }
  return root
}

function all(el: El): El[] {
  return [el, ...el.children.flatMap(all)]
}

// ---------- the renderer's CSS ----------
interface Compound {
  tag: string | null
  classes: string[]
}
interface CssRule {
  file: string
  selector: string
  /** Right-most compound first. */
  compounds: Compound[]
  decls: Map<string, string>
}

function splitSelectors(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Null when the selector styles a pseudo-element (not the element's own box). */
function compoundsOf(selector: string): Compound[] | null {
  if (/::?(before|after|marker|placeholder|selection|-webkit-[\w-]+)\b/.test(selector)) return null
  // Drop functional pseudo-classes and attribute tests: matching them loosely only makes the check stricter.
  let s = selector
  for (let guard = 0; guard < 5 && /:[\w-]+\(/.test(s); guard++) s = s.replace(/:[\w-]+\([^()]*\)/g, '')
  s = s.replace(/\[[^\]]*\]/g, '').replace(/:[\w-]+/g, '')
  const parts = s
    .replace(/\s*([>+~])\s*/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const compounds = parts.map((p) => {
    const tag = /^([a-zA-Z][\w-]*|\*)/.exec(p)?.[1] ?? null
    const classes = [...p.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((x) => x[1] ?? '')
    return { tag: tag === '*' ? null : tag?.toLowerCase() ?? null, classes }
  })
  return compounds.reverse()
}

function loadCss(): CssRule[] {
  const rules: CssRule[] = []
  for (const file of fs.readdirSync(stylesDir).filter((f) => f.endsWith('.css'))) {
    const root = postcss.parse(fs.readFileSync(path.join(stylesDir, file), 'utf8'))
    root.walkRules((rule: Rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes/.test((rule.parent as { name?: string }).name ?? '')) return
      const decls = new Map<string, string>()
      rule.walkDecls((d) => {
        decls.set(d.prop.toLowerCase(), d.value.toLowerCase().replace(/\s*!important/, '').trim())
      })
      for (const selector of splitSelectors(rule.selector)) {
        const compounds = compoundsOf(selector)
        if (compounds !== null && compounds.length > 0) rules.push({ file, selector, compounds, decls })
      }
    })
  }
  return rules
}

const matchesCompound = (el: El, c: Compound): boolean =>
  (c.tag === null || c.tag === el.tag) && c.classes.every((k) => el.classes.has(k))

/**
 * Whether a rule can reach this element. The right-most part must match the element itself and the parts to its left
 * must match ancestors in order. Child (`>`) and sibling combinators are read as "any ancestor", which can only make
 * the check stricter. The element is rendered inside the real page around a chat (WHERE below), so a page rule that
 * reaches into the chat is seen, and one for another page is not.
 */
function reaches(rule: CssRule, el: El): boolean {
  const [own, ...rest] = rule.compounds
  if (own === undefined || !matchesCompound(el, own)) return false
  let node = el.parent
  for (const c of rest) {
    while (node !== null && !matchesCompound(node, c)) node = node.parent
    if (node === null) return false
    node = node.parent
  }
  return true
}

/**
 * Where markdown is drawn in the app, outermost first, read from the built app's DOM (26 Oct 2026): the main chat,
 * a project chat in the side panel, the report beside the chat and the report reader dialog.
 */
const WHERE: Record<string, string[]> = {
  'the main chat': ['html.native', 'body', 'div', 'div.win', 'div.stage', 'div.shell.panel', 'main.sheet.own-scroll', 'div.chat', 'div.thread', 'div.thread-in', 'div.a-msg-wrap'],
  'a chat in the side panel': ['html.native', 'body', 'div', 'div.win', 'div.stage', 'div.shell.panel', 'aside.panel-w.panel-helper', 'div.chat', 'div.thread', 'div.thread-in', 'div.a-msg-wrap'],
  'the report beside the chat': ['html.native', 'body', 'div', 'div.win', 'div.stage', 'div.shell.panel', 'aside.panel-w.panel-helper', 'div.hp-stage.rp-stage', 'div.hp-stage-body', 'div.rp-col'],
  'the report reader': ['html.native', 'body', 'div', 'div.scrim', 'div.dialog', 'div.reader'],
}

/** Puts rendered markup inside one of the chains above. */
function placed(html: string, where: string[]): El {
  const open = where.map((w) => {
    const [tag, ...cls] = w.split('.')
    return `<${tag}${cls.length > 0 ? ` class="${cls.join(' ')}"` : ''}>`
  })
  const close = [...where].reverse().map((w) => `</${w.split('.')[0]}>`)
  return dom(open.join('') + html + close.join(''))
}

const CSS = loadCss()

const GRIDISH = /^(inline-)?grid$|^(inline-)?flex$|^table|^contents$|^inline-block$/
const COLUMNS = ['grid-template-columns', 'grid-template', 'grid', 'grid-template-areas', 'columns', 'column-count', 'column-width']

/** Everything wrong with how the CSS lays out one markdown box and the blocks in it. */
function layoutProblems(host: El): string[] {
  const problems: string[] = []
  const say = (el: El, r: CssRule, what: string): void => {
    problems.push(`${el.tag}.${[...el.classes].join('.')} <- ${r.file}: ${r.selector} (${what})`)
  }
  let explicitBlock = false
  for (const r of CSS) {
    if (!reaches(r, host)) continue
    const display = r.decls.get('display')
    if (display === 'block') explicitBlock = true
    else if (display !== undefined && display !== 'none' && GRIDISH.test(display)) say(host, r, `display:${display}`)
    for (const p of COLUMNS) if (r.decls.has(p)) say(host, r, p)
  }
  if (!explicitBlock) problems.push(`${[...host.classes].join('.')}: no rule makes the markdown box display:block`)

  // Its blocks: paragraphs, lists, headings, code, rules. A list may be a flex COLUMN (stacked items); nothing may be
  // a grid, a flex row, a float or a multi-column box, and none may claim a grid column or a narrow fixed width.
  for (const block of host.children) {
    for (const el of [block, ...block.children.filter((c) => c.tag === 'li')]) {
      for (const r of CSS) {
        if (!reaches(r, el)) continue
        const display = r.decls.get('display')
        if (display !== undefined && /^(inline-)?grid$/.test(display)) say(el, r, `display:${display}`)
        if (display !== undefined && /^(inline-)?flex$/.test(display)) {
          const dir = r.decls.get('flex-direction') ?? r.decls.get('flex-flow') ?? ''
          if (!dir.startsWith('column')) say(el, r, 'flex row')
        }
        const float = r.decls.get('float')
        if (float !== undefined && float !== 'none') say(el, r, `float:${float}`)
        for (const p of COLUMNS) if (r.decls.has(p)) say(el, r, p)
        if (el === block && (r.decls.has('grid-column') || r.decls.has('grid-area'))) say(el, r, 'grid-column')
      }
    }
  }
  return problems
}

// ---------- what gets rendered ----------
const LETTER =
  'Dear Özcan,\n\nThank you for the follow-up. We have gone through your offer, and there are a few things we would like to talk over with you.\n\nWould you be comfortable with a short call this week? We are based in South Africa (SAST, one hour behind Türkiye), so please suggest a time that suits you and we will work around it.\n\nKind regards,\nAyanda Phaketsi\nStrat Edge Solutions'

const EVERY_BLOCK = [
  '# A heading',
  'A paragraph with a [link](https://example.com/a/very/long/path) and **bold** and `code`.',
  'After a single line break\nright here, then a long word: Supercalifragilisticexpialidociousandthensomemoreletters.',
  '## Bullets',
  '- one',
  '- two, a longer item that wraps over more than one line when the card is narrow',
  '### Numbers',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '---',
  '',
  'Last paragraph.',
].join('\n')

const q = (s: string): string => JSON.stringify(s)

/** The exact program from the bug report, then each variant and size with every block kind. */
const PROGRAMS: Record<string, string> = {
  'the letter (sunk, in a card with header and buttons)': [
    'root = Card([h, m, b])',
    'h = CardHeader("Reply to Özcan", "Draft")',
    `m = MarkDownRenderer(${q(LETTER)}, "sunk")`,
    'b = Buttons([Button("Send", {type: "continue_conversation"}, "primary"), Button("Change it", {type: "continue_conversation"}, "secondary")])',
  ].join('\n'),
  ...Object.fromEntries(
    ['clear', 'card', 'sunk'].flatMap((v) => [
      [`MarkDownRenderer ${v} in a card`, `root = Card([h, m])\nh = CardHeader("Notes")\nm = MarkDownRenderer(${q(EVERY_BLOCK)}, "${v}")`],
      [`MarkDownRenderer ${v} alone`, `root = MarkDownRenderer(${q(LETTER)}, "${v}")`],
      [`MarkDownRenderer ${v} in a stack`, `root = Stack([m, t])\nm = MarkDownRenderer(${q(EVERY_BLOCK)}, "${v}")\nt = TextContent("after")`],
    ]),
  ),
  ...Object.fromEntries(
    ['default', 'small', 'large', 'small-heavy', 'large-heavy'].map((s) => [
      `TextContent ${s}`,
      `root = Card([t, u])\nt = TextContent(${q(EVERY_BLOCK)}, "${s}")\nu = TextContent(${q(LETTER)}, "${s}")`,
    ]),
  ),
}


const isHost = (el: El): boolean => el.classes.has('oui-text') || el.classes.has('a-prose')

/** A card or prose drawn where the app draws it: inside the agent's message, inside one of the WHERE chains. */
function drawn(inner: ReactElement, where: string): El[] {
  const chain = WHERE[where] ?? []
  const message = where.startsWith('the report') ? 'a-msg rich report-body' : 'a-msg rich'
  const html = renderToStaticMarkup(createElement('div', { className: message }, inner))
  return all(placed(html, chain)).filter(isHost)
}

const card = (source: string): ReactElement => createElement(OpenUiBlock, { source })
const prose = (text: string): ReactElement => createElement('div', { className: 'a-prose' }, createElement(Markdown, { text }))

describe('markdown in a chat card reads as stacked, full-width blocks', () => {
  it('reads the CSS it checks', () => {
    expect(CSS.length).toBeGreaterThan(500)
    expect(CSS.some((r) => r.selector.startsWith('.oui-text'))).toBe(true)
  })

  for (const [name, source] of Object.entries(PROGRAMS)) {
    it(name, () => {
      for (const where of Object.keys(WHERE)) {
        const hosts = drawn(card(source), where)
        // Every block is a direct child of the box, in order (nothing wraps paragraphs into columns).
        expect(hosts.some((host) => host.children.length > 1)).toBe(true)
        for (const host of hosts) {
          expect(layoutProblems(host), where).toEqual([])
        }
      }
    })
  }

  it('prose beside a card, and a report, read the same way', () => {
    for (const where of Object.keys(WHERE)) {
      const hosts = drawn(prose(`${LETTER}\n\n${EVERY_BLOCK}`), where)
      expect(hosts).toHaveLength(1)
      for (const host of hosts) expect(layoutProblems(host), where).toEqual([])
    }
  })

  it('the letter keeps its four paragraphs, in order, and the sign-off lines as line breaks', () => {
    const host = drawn(card(PROGRAMS['the letter (sunk, in a card with header and buttons)'] ?? ''), 'the main chat')[0]
    expect(host?.children.map((c) => c.tag)).toEqual(['p', 'p', 'p', 'p'])
    expect(host?.children[3]?.children.filter((c) => c.tag === 'br')).toHaveLength(2)
  })

  it('every block kind is rendered by the markdown it checks', () => {
    const host = drawn(card(PROGRAMS['MarkDownRenderer sunk in a card'] ?? ''), 'the main chat')[0]
    const tags = (host?.children ?? []).map((c) => (c.classes.size > 0 ? `${c.tag}.${[...c.classes][0]}` : c.tag))
    expect(tags).toEqual(['div.md-h', 'p', 'div.md-h', 'ul', 'div.md-h', 'ol', 'div.md-code', 'hr.md-hr', 'p'])
  })

  it('the markdown box never carries a bare generic class a page layout could own', () => {
    for (const source of Object.values(PROGRAMS)) {
      for (const host of drawn(card(source), 'the main chat')) {
        for (const k of host.classes) expect(k.startsWith('oui-') || /^[sv]-/.test(k), k).toBe(true)
      }
    }
  })

  it('the checker sees the bug it guards against', () => {
    const host = drawn(card(PROGRAMS['MarkDownRenderer sunk in a card'] ?? ''), 'the main chat')[0]
    expect(host).toBeDefined()
    if (host === undefined) return
    const fake = (selector: string, decls: [string, string][]): CssRule => ({
      file: 'fake.css',
      selector,
      compounds: compoundsOf(selector) ?? [],
      decls: new Map(decls),
    })
    // A page layout's grid landing on the box (what happened), and a generic `> *` rule turning its blocks into columns.
    const cases: [CssRule, RegExp][] = [
      [fake('.oui-text', [['display', 'grid'], ['grid-template-columns', 'minmax(300px,420px) minmax(0,1fr)']]), /display:grid/],
      [fake('.thread-in .oui-card-in>*>*', [['display', 'flex']]), /flex row/],
      [fake('.chat .oui-text>*', [['grid-column', '2']]), /grid-column/],
      [fake('.sheet p', [['float', 'left']]), /float:left/],
    ]
    for (const [rule, expected] of cases) {
      CSS.push(rule)
      try {
        expect(layoutProblems(host).join('\n')).toMatch(expected)
      } finally {
        CSS.pop()
      }
    }
    // And a rule for another page does not reach the chat.
    CSS.push(fake('.learned-tools .oui-text', [['display', 'grid']]))
    try {
      expect(layoutProblems(host)).toEqual([])
    } finally {
      CSS.pop()
    }
  })
})

// The same class of bug for every component: OpenUI drew its markdown box with the bare class `md`, its numbered
// steps with `steps` (onboarding's panel and its 24 px number circles for every <b>) and a small list with `small`
// (the app's 12 px caption). A class OpenUI draws that is not its own (`oui-...`) may only be styled inside OpenUI.
describe("OpenUI's classes never pick up the rest of the app's styles", () => {
  /** Classes shared with the app on purpose, the same thing everywhere: the figure style, the app's icon and its copy button. */
  const SHARED = new Set(['num', 'ico', 'copy-btn'])

  it('no rule outside OpenUI can land on an element OpenUI draws', () => {
    const sources = [...Object.values(PROGRAMS)]
    for (const f of fs.readdirSync(path.join(here, 'openui'))) {
      const t = fs.readFileSync(path.join(here, 'openui', f), 'utf8')
      for (const m of t.matchAll(/```openui-lang\n([\s\S]*?)```/g)) sources.push(m[1] ?? '')
    }
    sources.push(
      [
        'root = Card([l, s, g])',
        'l = ListBlock([ListItem("One", "the **first**"), ListItem("Two", "second")], "number", "small")',
        's = Steps([StepsItem("Do **this**", "then that"), StepsItem("Then this", "and done")])',
        'g = TagBlock([Tag("small tag", null, "sm", "info"), Tag("md tag", null, "md", "warning"), Tag("lg tag", null, "lg", "success")])',
      ].join('\n'),
    )
    expect(sources.length).toBeGreaterThan(20)
    const drawnClasses = new Set<string>()
    const tags = new Set<string>()
    for (const source of sources) {
      for (const el of all(dom(renderToStaticMarkup(card(source))))) {
        tags.add(el.tag)
        for (const k of el.classes) drawnClasses.add(k)
      }
    }
    // What can sit around an OpenUI element: what it draws itself and the page around a chat.
    const around = new Set([...drawnClasses, ...Object.values(WHERE).flatMap((chain) => chain.flatMap((w) => w.split('.').slice(1))), 'a-msg', 'rich', 'report-body'])
    const foreign = [...drawnClasses].filter((k) => k !== 'oui' && !k.startsWith('oui-') && !k.startsWith('md-') && !SHARED.has(k))
    const leaks: string[] = []
    for (const r of CSS) {
      const [own, ...rest] = r.compounds
      if (own === undefined || own.classes.length === 0) continue
      if (own.tag !== null && !tags.has(own.tag)) continue
      if (!own.classes.every((k) => drawnClasses.has(k))) continue
      if (!rest.every((c) => c.classes.every((k) => around.has(k)))) continue
      const scoped = [own, ...rest].some((c) => c.classes.some((k) => k === 'oui' || k.startsWith('oui-') || k.startsWith('md-')))
      if (!scoped && own.classes.some((k) => foreign.includes(k))) leaks.push(`${r.file}: ${r.selector}`)
    }
    expect(leaks).toEqual([])
    expect(drawnClasses.has('oui-steps') && drawnClasses.has('oui-list-small')).toBe(true)
  })
})
