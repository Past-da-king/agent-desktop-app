/**
 * Every example in the OpenUI system prompt is a real program: it goes through the same parser and renderer the
 * chat uses, every name is used, every component is one the renderer draws with its arguments in the right
 * shape, and together the examples show every component there is.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OPENUI_PROMPT } from '../src/main/runtime/openui-prompt'
import { hasOpenUi, isAction, isNode, LIBRARY, parse, render, splitMessage, type UiNode, type V } from '../src/renderer/openui/lang'
import { OpenUiBlock, OpenUiProvider } from '../src/renderer/openui/OpenUiView'

const examples = [...OPENUI_PROMPT.matchAll(/```openui-lang\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')

function refsIn(value: V, out: Set<string>): void {
  switch (value.t) {
    case 'ref':
      out.add(value.name)
      return
    case 'arr':
      value.items.forEach((item) => refsIn(item, out))
      return
    case 'obj':
      value.fields.forEach((field) => refsIn(field, out))
      return
    case 'call':
    case 'fn':
      value.args.forEach((arg) => refsIn(arg, out))
      return
    default:
      return
  }
}

const primitive = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number'
const nodesOf = (n: UiNode, key: string): UiNode[] => (Array.isArray(n.props[key]) ? (n.props[key] as unknown[]).filter(isNode) : [])
const listOf = (n: UiNode, key: string): unknown[] => (Array.isArray(n.props[key]) ? (n.props[key] as unknown[]) : [])

/** The shape rules the renderer relies on, so an example cannot parse fine and still draw wrong. */
function problems(root: UiNode): string[] {
  const out: string[] = []
  const walk = (n: UiNode, parent: string | null): void => {
    if (!(n.type in LIBRARY)) out.push(`unknown ${n.type}`)
    switch (n.type) {
      case 'Stack':
        if (parent !== null) out.push('Stack is only the root')
        if (!nodesOf(n, 'children').every((k) => k.type === 'Card' || k.type === 'Product')) out.push('Stack holds Cards or Products')
        break
      case 'Card':
        if (nodesOf(n, 'children').some((k) => k.type === 'Stack' || k.type === 'Card' || k.type === 'Product')) out.push('Card inside Card')
        for (const s of listOf(n, 'sources')) {
          const src = s as Record<string, unknown>
          if (typeof src['title'] !== 'string' || typeof src['url'] !== 'string') out.push('source needs title and url')
        }
        break
      case 'Table': {
        const cols = nodesOf(n, 'columns')
        if (cols.length === 0 || !cols.every((c) => c.type === 'Col')) out.push('Table holds Cols')
        const lengths = new Set(cols.map((c) => listOf(c, 'data').length))
        if (lengths.size !== 1) out.push('Cols differ in length')
        if (!cols.every((c) => listOf(c, 'data').every(primitive))) out.push('Col cells are plain values')
        break
      }
      case 'BarChart':
      case 'LineChart': {
        const labels = listOf(n, 'labels')
        const series = nodesOf(n, 'series')
        if (series.length === 0 || !series.every((s) => s.type === 'Series')) out.push(`${n.type} holds Series`)
        if (!series.every((s) => listOf(s, 'values').length === labels.length && listOf(s, 'values').every((v) => typeof v === 'number'))) out.push('Series values match labels')
        break
      }
      case 'PieChart':
        if (listOf(n, 'labels').length !== listOf(n, 'values').length) out.push('Pie labels and values differ')
        break
      case 'ListBlock':
        if (!nodesOf(n, 'items').every((k) => k.type === 'ListItem')) out.push('ListBlock holds ListItems')
        break
      case 'ListItem': {
        const action = n.props['action']
        if (action !== undefined && !isAction(action) && !(Array.isArray(action) && action.every(isAction))) out.push('ListItem action is an action')
        break
      }
      case 'Steps':
        if (!nodesOf(n, 'items').every((k) => k.type === 'StepsItem')) out.push('Steps holds StepsItems')
        break
      case 'Buttons':
        if (!nodesOf(n, 'buttons').every((k) => k.type === 'Button')) out.push('Buttons holds Buttons')
        break
      case 'Button': {
        const action = n.props['action']
        if (action !== undefined && !isAction(action) && !Array.isArray(action)) out.push('Button action is an action')
        break
      }
      case 'FollowUpBlock':
        if (!nodesOf(n, 'items').every((k) => k.type === 'FollowUpItem')) out.push('FollowUpBlock holds FollowUpItems')
        break
      case 'EntityList':
        for (const row of listOf(n, 'rows')) {
          const r = row as Record<string, unknown>
          if (typeof r['left'] !== 'string' || typeof r['right'] !== 'string') out.push('EntityList rows are {left, right}')
        }
        break
      case 'ImageBlock':
      case 'Image':
        if (typeof n.props['src'] !== 'string' || !String(n.props['src']).startsWith('https://')) out.push('pictures are https')
        break
      default:
        break
    }
    for (const value of Object.values(n.props)) {
      const items = Array.isArray(value) ? value : [value]
      for (const item of items) if (isNode(item)) walk(item, n.type)
    }
  }
  walk(root, null)
  return out
}

function typesIn(root: UiNode): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (isNode(v)) {
      out.add(v.type)
      Object.values(v.props).forEach(walk)
    }
  }
  walk(root)
  return out
}

describe('the OpenUI prompt examples', () => {
  it('has one example block per shape', () => {
    expect(examples.length).toBeGreaterThanOrEqual(10)
  })

  it.each(examples.map((source, index) => [index + 1, source] as const))('example %i parses, uses every name and renders', (_n, source) => {
    const program = parse(source)
    expect(program.errors).toEqual([])
    expect(program.incomplete).toBe(false)
    expect(program.order[0]).toBe('root')

    // Rule 5: every name but root is used by something.
    const used = new Set<string>()
    program.statements.forEach((statement) => refsIn(statement.value, used))
    expect(program.order.filter((name) => name !== 'root' && !used.has(name))).toEqual([])

    const tree = render(program)
    expect(tree.errors).toEqual([])
    expect([...tree.unresolved]).toEqual([])
    expect(tree.root?.type).toBe('Stack')
    if (tree.root === null) return
    expect(problems(tree.root)).toEqual([])

    const html = renderToStaticMarkup(createElement(OpenUiProvider, { value: {} }, createElement(OpenUiBlock, { source })))
    expect(html).not.toContain('oui-raw')
    expect(html).toMatch(/class="oui"/)
  })

  it('together they show every component the renderer draws', () => {
    const shown = new Set<string>()
    for (const source of examples) {
      const root = render(parse(source)).root
      if (root !== null) typesIn(root).forEach((type) => shown.add(type))
    }
    expect(Object.keys(LIBRARY).filter((type) => !shown.has(type))).toEqual([])
  })

  it('teaches a signature for every component, and only real ones', () => {
    const signatures = new Set([...OPENUI_PROMPT.matchAll(/^([A-Z][A-Za-z]+)\(/gm)].map((m) => m[1] ?? ''))
    expect([...signatures].filter((s) => !(s in LIBRARY))).toEqual([])
    expect(Object.keys(LIBRARY).filter((s) => !signatures.has(s))).toEqual([])
  })

  it('a reply with an example reads as prose plus one block, as the chat splits it', () => {
    const reply = `Three ways to get there, cheapest last.\n\n\`\`\`openui-lang\n${examples[0] ?? ''}\`\`\``
    const parts = splitMessage(reply)
    expect(parts.map((p) => p.kind)).toEqual(['prose', 'openui'])
  })

  it('makes the agent choose a shape before it writes, and keeps chat replies plain', () => {
    for (const phrase of ['Choose on purpose, every reply', 'name its shape', 'Never a wall of text', 'Plain text, no block', 'Options to choose from', 'Status of several things', 'Progress', 'Files or folders on this computer']) {
      expect(OPENUI_PROMPT).toContain(phrase)
    }
    // Col data is one plain value per row: the old {id, values} teaching drew "[object Object]".
    expect(OPENUI_PROMPT).not.toContain('{ id, values }')
    expect(OPENUI_PROMPT).not.toMatch(/[—–]/)
  })
})

/**
 * Replies a real model (Claude Sonnet through Claude Code, 21 Oct 2026) wrote with the new system prompt and no
 * tools, saved as they came back. The structured asks came back as cards that render; the greeting stayed plain.
 */
describe('real replies written with the new prompt', () => {
  const read = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'openui', `live-${name}.md`), 'utf8')

  it.each(['hosting', 'day', 'projects', 'weekend'])('%s is one short line and a card that renders', (name) => {
    const parts = splitMessage(read(name))
    expect(parts[0]?.kind).toBe('prose')
    const blocks = parts.filter((part) => part.kind === 'openui')
    expect(blocks).toHaveLength(1)
    const source = blocks[0]?.kind === 'openui' ? blocks[0].source : ''
    const tree = render(parse(source))
    expect(tree.errors).toEqual([])
    expect([...tree.unresolved]).toEqual([])
    expect(tree.root).not.toBeNull()
    if (tree.root !== null) expect(problems(tree.root)).toEqual([])
    const html = renderToStaticMarkup(createElement(OpenUiProvider, { value: {} }, createElement(OpenUiBlock, { source })))
    expect(html).not.toContain('oui-raw')
  })

  it('a greeting stays plain words', () => {
    const reply = read('hello')
    expect(hasOpenUi(reply)).toBe(false)
    expect(reply.trim().split('\n')).toHaveLength(1)
  })
})
