/**
 * OpenUI Lang 1.0 (the thesysdev/openui spec), the compact line language the agent writes to describe a UI:
 * `root = Stack([card])`, one statement per line, names usable before they are defined.
 *
 * Ported from the phone app's ui/openui/OpenUiLang.kt so both apps read the same programs the same way. Parses
 * literals, arrays, objects, component calls, references, `$state` and `@` actions, closes open brackets and
 * strings so a half-streamed program still renders, and drops only a broken statement. Operators, queries,
 * mutations and forms are not run. Pure TypeScript: no DOM, so it is unit tested directly.
 */

import type { UiIcon } from './icon-words'

export type V =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'arr'; items: V[] }
  | { t: 'obj'; fields: Map<string, V> }
  | { t: 'call'; name: string; args: V[] }
  | { t: 'ref'; name: string }
  | { t: 'fn'; name: string; args: V[] }

const NULL: V = { t: 'null' }

export interface Statement {
  name: string
  value: V
}

export interface Program {
  statements: Map<string, Statement>
  order: string[]
  errors: string[]
  incomplete: boolean
}

/** A rendered component: its type and props by name. */
export interface UiNode {
  type: string
  props: Record<string, unknown>
}

/** What a button or list item does when tapped. */
export type UiAction = { kind: 'assistant'; text: string; context: unknown } | { kind: 'url'; url: string }

class ParseError extends Error {}

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isWord = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c)
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v'

class Parser {
  pos = 0
  incomplete = false
  constructor(readonly s: string) {}

  eof(): boolean {
    return this.pos >= this.s.length
  }
  peek(): string {
    return this.s[this.pos] ?? ''
  }
  private comment(): void {
    if (this.s[this.pos] === '/' && this.s[this.pos + 1] === '/') {
      while (!this.eof() && this.s[this.pos] !== '\n') this.pos += 1
    }
  }
  ws(): void {
    while (!this.eof() && (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\r')) this.pos += 1
    this.comment()
  }
  /** Inside brackets a newline is just whitespace. */
  wsn(): void {
    for (;;) {
      while (!this.eof() && isSpace(this.peek())) this.pos += 1
      const before = this.pos
      this.comment()
      if (this.pos === before) return
    }
  }
  skipBlank(): void {
    this.wsn()
  }
  skipLine(): void {
    let depth = 0
    let inStr = false
    while (!this.eof()) {
      const c = this.peek()
      if (inStr) {
        if (c === '\\') this.pos += 1
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '(' || c === '[' || c === '{') depth += 1
      else if (c === ')' || c === ']' || c === '}') depth -= 1
      else if (c === '\n' && depth <= 0) {
        this.pos += 1
        return
      }
      this.pos += 1
    }
  }
  eat(c: string): boolean {
    if (!this.eof() && this.peek() === c) {
      this.pos += 1
      return true
    }
    return false
  }
  ident(): string | null {
    const st = this.pos
    if (!this.eof() && (this.peek() === '$' || this.peek() === '@')) this.pos += 1
    while (!this.eof() && isWord(this.peek())) this.pos += 1
    const lone = this.pos === st + 1 && (this.s[st] === '$' || this.s[st] === '@')
    if (this.pos > st && !lone) return this.s.slice(st, this.pos)
    this.pos = st
    return null
  }
  expr(): V {
    this.wsn()
    if (this.eof()) {
      // The stream stopped right here.
      this.incomplete = true
      return NULL
    }
    const c = this.peek()
    if (c === '"') return { t: 'str', v: this.string() }
    if (c === '[') {
      this.pos += 1
      return { t: 'arr', items: this.list(']') }
    }
    if (c === '{') {
      this.pos += 1
      return this.obj()
    }
    if (c === '-' || isDigit(c)) return this.num()
    if (c === '(') {
      this.pos += 1
      const v = this.expr()
      this.wsn()
      if (!this.eat(')')) {
        if (this.eof()) this.incomplete = true
        else throw new ParseError('expected )')
      }
      return v
    }
    const id = this.ident()
    if (id === null) throw new ParseError(`unexpected '${c}'`)
    if (id === 'true') return { t: 'bool', v: true }
    if (id === 'false') return { t: 'bool', v: false }
    if (id === 'null') return NULL
    this.ws()
    if (!this.eof() && this.peek() === '(') {
      this.pos += 1
      const args = this.list(')')
      return id.startsWith('@') ? { t: 'fn', name: id.slice(1), args } : { t: 'call', name: id, args }
    }
    // `Head` at the very end may become `Header(...)`: treat it as pending.
    if (this.eof() && /^[A-Z]/.test(id)) this.incomplete = true
    return { t: 'ref', name: id }
  }
  list(close: string): V[] {
    const out: V[] = []
    for (;;) {
      this.wsn()
      if (this.eof()) {
        this.incomplete = true
        return out
      }
      if (this.eat(close)) return out
      const before = this.pos
      out.push(this.expr())
      this.wsn()
      this.eat(',')
      // A stray closing bracket of the wrong kind would loop forever: it is an error, not a value.
      if (this.pos === before) throw new ParseError(`unexpected '${this.peek()}'`)
    }
  }
  obj(): V {
    const out = new Map<string, V>()
    for (;;) {
      this.wsn()
      if (this.eof()) {
        this.incomplete = true
        return { t: 'obj', fields: out }
      }
      if (this.eat('}')) return { t: 'obj', fields: out }
      const key = this.peek() === '"' ? this.string() : this.ident()
      if (key === null) throw new ParseError('expected a key')
      this.wsn()
      if (!this.eat(':')) {
        if (this.eof()) {
          this.incomplete = true
          return { t: 'obj', fields: out }
        }
        throw new ParseError('expected :')
      }
      out.set(key, this.expr())
      this.wsn()
      this.eat(',')
    }
  }
  string(): string {
    this.pos += 1
    let b = ''
    for (;;) {
      if (this.eof()) {
        // Closes itself while streaming.
        this.incomplete = true
        return b
      }
      const c = this.s[this.pos] ?? ''
      this.pos += 1
      if (c === '"') return b
      if (c === '\\') {
        if (this.eof()) {
          this.incomplete = true
          return b
        }
        const e = this.s[this.pos] ?? ''
        this.pos += 1
        if (e === 'n') b += '\n'
        else if (e === 't') b += '\t'
        else if (e === 'r') b += '\r'
        else if (e === 'u') {
          const h = this.s.slice(this.pos, this.pos + 4)
          if (h.length === 4 && /^[0-9a-fA-F]{4}$/.test(h)) {
            b += String.fromCharCode(parseInt(h, 16))
            this.pos += 4
          } else {
            this.incomplete = true
            this.pos = this.s.length
          }
        } else b += e
      } else b += c
    }
  }
  num(): V {
    const st = this.pos
    if (this.peek() === '-') this.pos += 1
    while (!this.eof()) {
      const c = this.peek()
      const prev = this.s[this.pos - 1] ?? ''
      if (isDigit(c) || c === '.' || c === 'e' || c === 'E' || ((c === '+' || c === '-') && (prev === 'e' || prev === 'E'))) this.pos += 1
      else break
    }
    const raw = this.s.slice(st, this.pos)
    const n = Number(raw)
    if (raw === '' || raw === '-' || !Number.isFinite(n)) throw new ParseError('bad number')
    return { t: 'num', v: n }
  }
}

/** The program inside a ```openui-lang fence (or bare). Fence lines and `//` comments are dropped. */
export function parse(src: string): Program {
  const text = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('```'))
    .join('\n')
  const p = new Parser(text)
  const stmts = new Map<string, Statement>()
  const errors: string[] = []
  for (;;) {
    p.skipBlank()
    if (p.eof()) break
    const start = p.pos
    try {
      const name = p.ident()
      if (name === null) throw new ParseError('expected a name')
      p.ws()
      if (!p.eat('=')) throw new ParseError('expected =')
      const value = p.expr()
      p.ws()
      if (!p.eof() && p.peek() !== '\n') throw new ParseError('trailing text')
      // A later binding wins.
      stmts.delete(name)
      stmts.set(name, { name, value })
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      const line = text.slice(0, start).split('\n').length
      errors.push(`line ${line}: ${error.message}`)
      p.pos = start
      p.skipLine()
      if (p.pos === start) p.pos += 1
    }
  }
  return { statements: stmts, order: [...stmts.keys()], errors, incomplete: p.incomplete }
}

/** Prop names by position, from OpenUI's chat library (react-ui 0.18), as the phone app has it. Unknown components are dropped. */
export const LIBRARY: Record<string, string[]> = {
  Stack: ['children', 'direction', 'gap', 'align', 'justify', 'wrap'],
  Card: ['children', 'sources'],
  // The icon is this app's own addition: an explicit Lucide name, else the card's kind decides (headerIcon).
  CardHeader: ['title', 'subtitle', 'icon'],
  TextContent: ['text', 'size'],
  MarkDownRenderer: ['textMarkdown', 'variant'],
  Callout: ['variant', 'title', 'description', 'visible'],
  Separator: ['orientation', 'decorative'],
  Table: ['columns'],
  Col: ['label', 'data', 'type'],
  Series: ['category', 'values'],
  BarChart: ['labels', 'series', 'variant', 'xLabel', 'yLabel', 'height'],
  LineChart: ['labels', 'series', 'variant', 'xLabel', 'yLabel', 'height'],
  PieChart: ['labels', 'values', 'variant', 'appearance'],
  Buttons: ['buttons', 'direction'],
  Button: ['label', 'action', 'variant', 'type', 'size'],
  ListBlock: ['items', 'variant', 'size'],
  ListItem: ['title', 'subtitle', 'image', 'actionLabel', 'action'],
  FollowUpBlock: ['items'],
  FollowUpItem: ['text'],
  Steps: ['items'],
  StepsItem: ['title', 'details'],
  TagBlock: ['tags', 'size'],
  Tag: ['text', 'icon', 'size', 'variant'],
  ImageBlock: ['src', 'alt'],
  Image: ['alt', 'src'],
  // A real player for a video the agent shows (agent-media://f/<token> or https), with one line under it.
  Video: ['src', 'caption'],
  InlineHeader: ['heading', 'description'],
  EntityList: ['rows', 'size', 'header', 'footer'],
  TextCallout: ['variant', 'title', 'description'],
  // Lucide icon names (Tag's optional icon), drawn as the nearest icon by word.
  Icon: ['name', 'category'],
  // The phone app's own, not OpenUI's: one thing for sale, for a row of them to swipe through.
  Product: ['image', 'name', 'price', 'rating', 'reviews', 'seller', 'was', 'tag', 'actions'],
}

/** The library's root is Stack (one Card per item); a lone Card is accepted too. */
export const ROOTS = new Set(['Stack', 'Card'])

export interface Rendered {
  root: UiNode | null
  unresolved: Set<string>
  errors: string[]
}

export function isNode(v: unknown): v is UiNode {
  return typeof v === 'object' && v !== null && typeof (v as UiNode).type === 'string' && typeof (v as UiNode).props === 'object'
}

export function isAction(v: unknown): v is UiAction {
  if (typeof v !== 'object' || v === null) return false
  const kind = (v as { kind?: unknown }).kind
  return kind === 'assistant' || kind === 'url'
}

/** The tree from the entry: `root`, else the first statement that calls a root component. */
export function render(p: Program): Rendered {
  const unresolved = new Set<string>()
  const errors = [...p.errors]
  let entry = p.statements.get('root')
  if (entry === undefined) {
    entry = p.order
      .map((name) => p.statements.get(name))
      .find((s): s is Statement => s !== undefined && s.value.t === 'call' && ROOTS.has(s.value.name))
  }
  if (entry === undefined) return { root: null, unresolved, errors: [...errors, 'no-root'] }

  const evaluate = (v: V, seen: Set<string>, depth: number): unknown => {
    if (depth > 64) {
      errors.push('too deep')
      return null
    }
    switch (v.t) {
      case 'str':
      case 'num':
      case 'bool':
        return v.v
      case 'null':
        return null
      case 'arr':
        // A pending reference just is not there yet.
        return v.items.map((item) => evaluate(item, seen, depth + 1)).filter((item) => item !== null && item !== undefined)
      case 'obj': {
        const out: Record<string, unknown> = {}
        v.fields.forEach((value, key) => {
          out[key] = evaluate(value, seen, depth + 1)
        })
        return out
      }
      case 'ref': {
        if (seen.has(v.name)) {
          errors.push(`cycle at ${v.name}`)
          return null
        }
        const s = p.statements.get(v.name)
        if (s === undefined) {
          unresolved.add(v.name)
          return null
        }
        return evaluate(s.value, new Set([...seen, v.name]), depth + 1)
      }
      case 'fn': {
        const first = v.args[0] === undefined ? null : evaluate(v.args[0], seen, depth + 1)
        if (v.name === 'ToAssistant') {
          const context = v.args[1] === undefined ? null : evaluate(v.args[1], seen, depth + 1)
          return { kind: 'assistant', text: typeof first === 'string' ? first : '', context } satisfies UiAction
        }
        if (v.name === 'OpenUrl') return typeof first === 'string' ? ({ kind: 'url', url: first } satisfies UiAction) : null
        errors.push(`unsupported @${v.name}`)
        return null
      }
      case 'call': {
        if (v.name === 'Action') {
          const steps = v.args[0] === undefined ? null : evaluate(v.args[0], seen, depth + 1)
          return Array.isArray(steps) ? steps.filter(isAction) : null
        }
        const names = LIBRARY[v.name]
        if (names === undefined) {
          errors.push(`unknown-component ${v.name}`)
          return null
        }
        const props: Record<string, unknown> = {}
        names.forEach((name, index) => {
          const arg = v.args[index]
          if (arg === undefined) return
          const value = evaluate(arg, seen, depth + 1)
          if (value !== null && value !== undefined) props[name] = value
        })
        return { type: v.name, props } satisfies UiNode
      }
    }
  }

  const value = evaluate(entry.value, new Set([entry.name]), 0)
  return { root: isNode(value) ? value : null, unresolved, errors }
}

/** Parse and render in one go, never throwing: a broken program is just no tree. */
export function renderSource(source: string): Rendered {
  try {
    return render(parse(source))
  } catch (error) {
    return { root: null, unresolved: new Set(), errors: [error instanceof Error ? error.message : 'parse failed'] }
  }
}

// ---- What a tap says ------------------------------------------------------------------------

/** Where a tap happened: the card it is on and the item inside it (a section heading or a list row). */
export interface Scope {
  card?: string | null
  item?: string | null
}

/** A value as a person reads it: whole numbers without a decimal point, objects and lists flattened. */
export function plainValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : String(v)
  if (Array.isArray(v)) return v.map(plainValue).join(', ')
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${plainValue(x)}`)
      .join(', ')
  }
  return String(v)
}

/**
 * What a tap on @ToAssistant tells the agent: the instruction, then one line saying which card and item it is
 * about plus the model's context, so the agent acts on that specific one. Same wording as the phone.
 */
export function messageFor(a: { text: string; context: unknown }, scope: Scope): string {
  const text = a.text.trim()
  const parts: string[] = []
  const add = (s: string | null | undefined): void => {
    const v = (s ?? '').trim()
    if (v === '') return
    const low = v.toLowerCase()
    if (parts.some((p) => p.toLowerCase() === low) || text.toLowerCase() === low) return
    parts.push(v)
  }
  add(scope.item)
  add(scope.card)
  const c = a.context
  if (c !== null && c !== undefined) {
    if (typeof c === 'object' && !Array.isArray(c)) {
      Object.entries(c as Record<string, unknown>).forEach(([k, v]) => {
        const s = plainValue(v)
        if (s.trim() !== '') add(k === 'item' || k === 'name' || k === 'title' ? s : `${k}: ${s}`)
      })
    } else add(plainValue(c))
  }
  return parts.length === 0 ? text : `${text}\n↳ ${parts.join(' · ')}`
}

// ---- Messages: prose and blocks ---------------------------------------------------------------

export type MessagePart = { kind: 'prose'; text: string } | { kind: 'openui'; source: string; closed: boolean }

/**
 * Splits an agent message into prose and ```openui fences, as the phone's MdTable.split does. While streaming
 * the closing fence has not arrived yet: the rest is still a block, not prose.
 */
export function splitMessage(text: string): MessagePart[] {
  const lines = text.split('\n')
  const out: MessagePart[] = []
  let prose: string[] = []
  const flush = (): void => {
    const joined = prose.join('\n')
    if (joined.trim() !== '') out.push({ kind: 'prose', text: joined.replace(/^\n+|\n+$/g, '') })
    prose = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim().startsWith('```openui')) {
      let j = i + 1
      const body: string[] = []
      while (j < lines.length && !(lines[j] ?? '').trim().startsWith('```')) {
        body.push(lines[j] ?? '')
        j += 1
      }
      flush()
      out.push({ kind: 'openui', source: body.join('\n'), closed: j < lines.length })
      i = j + 1
    } else {
      prose.push(line)
      i += 1
    }
  }
  flush()
  return out
}

/** True when a message carries at least one OpenUI block. */
export function hasOpenUi(text: string): boolean {
  return /^\s*```openui/m.test(text)
}

/**
 * The message for places that cannot draw cards (a notification, a preview line): each block becomes the titles
 * of what it shows, e.g. "R7,200 a month · R6,800 a month".
 */
export function plainText(md: string): string {
  const parts = splitMessage(md)
  const chunks = parts.map((part) => {
    if (part.kind === 'prose') return part.text
    const titles: string[] = []
    const walk = (v: unknown): void => {
      if (isNode(v)) {
        const title =
          v.type === 'CardHeader' ? v.props['title'] : v.type === 'InlineHeader' ? v.props['heading'] : v.type === 'ListItem' || v.type === 'StepsItem' ? v.props['title'] : v.type === 'Product' ? v.props['name'] : null
        if (typeof title === 'string' && title.trim() !== '') titles.push(title)
        Object.values(v.props).forEach(walk)
      } else if (Array.isArray(v)) v.forEach(walk)
    }
    walk(renderSource(part.source).root)
    return [...new Set(titles)].slice(0, 4).join(' · ')
  })
  return chunks
    .filter((c) => c.trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---- Layout decisions the view makes (pure, so they are tested) --------------------------------

/** A leading amount like "R7,200" in a title, split from the words after it ("a month"). */
export const HERO = /^([R$€£]\s?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{1,2})?|[R$€£]\s?\d+(?:[.,]\d{1,2})?)(.*)$/

export function heroSplit(title: string | null | undefined): [string, string] | null {
  if (title === null || title === undefined) return null
  const m = HERO.exec(title.trim())
  return m === null ? null : [m[1] ?? '', (m[2] ?? '').trim()]
}

export function digits(v: unknown): string {
  return (v === null || v === undefined ? '' : String(v)).replace(/\D/g, '')
}

/** Numbers as the phone shows them: thin groups of three with spaces, two decimals when there are any. */
export function fmt(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') {
    const whole = Number.isInteger(v) && Math.abs(v) < 1e15
    const s = whole
      ? Math.trunc(v).toLocaleString('en-US')
      : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return s.replace(/,/g, ' ')
  }
  return String(v)
}

export type Sign = 'out' | 'in' | null

/** Money out (a leading minus) or money in (a leading plus); anything without digits has no sign. */
export function signOf(value: string): Sign {
  const t = value.trim()
  if (!/\d/.test(t)) return null
  if (t.startsWith('-') || t.startsWith('−')) return 'out'
  if (t.startsWith('+')) return 'in'
  return null
}

export const GENERIC_HEADS = new Set(['item', 'items', 'label', 'name', 'detail', 'details', 'date', 'amount', 'value', 'field', 'description', 'key', 'property', 'when'])

export interface FactRow {
  left: string
  right: string
}

export function factRows(n: UiNode): FactRow[] {
  const rows = Array.isArray(n.props['rows']) ? (n.props['rows'] as unknown[]) : []
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r) && !isNode(r))
    .map((r) => ({ left: r['left'] === undefined || r['left'] === null ? '' : String(r['left']), right: fmt(r['right']) }))
}

/**
 * How a facts list is drawn. Short label and value pairs become tiles in two columns (with no amount in the
 * header, a first money row on the card's first facts list is drawn big, full width); long or many stay a grouped list.
 * A row repeating the header's big amount is not said twice.
 */
export function factsLayout(all: FactRow[], heroAmount: string | null, firstFacts: boolean): { mode: 'tiles' | 'list'; rows: FactRow[]; lines: FactRow[][]; bigFirst: boolean } {
  const rows = all.filter((r) => heroAmount === null || digits(r.right) !== digits(heroAmount))
  const short = rows.length >= 2 && rows.length <= 8 && rows.every((r) => r.right.length <= 22 && r.left.length <= 20)
  if (!short) return { mode: 'list', rows, lines: [], bigFirst: false }
  const first = rows[0]
  const bigFirst =
    firstFacts && heroAmount === null && rows.length <= 4 && first !== undefined && HERO.test(first.right.trim().replace(/^[-+]+/, ''))
  const lines: FactRow[][] = []
  let i = 0
  if (bigFirst && first !== undefined) {
    lines.push([first])
    i = 1
  }
  while (i < rows.length) {
    lines.push(rows.slice(i, i + 2))
    i += 2
  }
  return { mode: 'tiles', rows, lines, bigFirst }
}

/**
 * How wide a table column wants to be, from its longest cell: short columns ("Fast", "R150") stay as narrow as their
 * words; columns of phrases get a real minimum so a sentence is not stacked one word per line; the table scrolls
 * sideways when the columns together are wider than the card.
 */
export function columnWidth(label: string, cells: unknown[]): 'short' | 'mid' | 'long' {
  const longest = Math.max(label.length, ...cells.map((cell) => fmt(cell).length))
  if (longest <= 14) return 'short'
  return longest > 40 ? 'long' : 'mid'
}

/** Two short choices sit side by side (Approve / Decline); more, or a column asked for, stack at full width. */
export function buttonsLayout(labels: string[], direction: string | undefined): 'row' | 'column' | 'single' {
  if (labels.length === 1) return 'single'
  const short = labels.length === 2 && labels.every((l) => l.length <= 10)
  if (direction === 'column' || (!short && labels.length > 1)) return 'column'
  return 'row'
}

/** Whole stars (2), a half (1) and the empty ones (0), for a rating out of 5. */
export function starKinds(rating: number): number[] {
  return [1, 2, 3, 4, 5].map((i) => (rating >= i - 0.25 ? 2 : rating >= i - 0.75 ? 1 : 0))
}

export function fmtRating(r: number): string {
  return Math.min(5, Math.max(0, r)).toFixed(1)
}

export function fmtCount(v: number): string {
  return Math.trunc(v).toLocaleString('en-US')
}

/** Every action a prop holds: one step, or the list Action([...]) made. */
export function actionsOf(v: unknown): UiAction[] {
  if (isAction(v)) return [v]
  if (Array.isArray(v)) return v.filter(isAction)
  return []
}

/**
 * A card header's icon: the one the agent named, else what the card is (money, a plan, a table, links...), else a
 * neutral mark. Never guessed from words in the title: "Your projects, 4 total" is not a money card.
 */
export function headerIcon(
  explicit: UiIcon | null,
  heroAmount: boolean,
  kids: UiNode[],
): UiIcon {
  if (explicit !== null) return explicit
  if (heroAmount) return 'payments'
  const types = new Set(kids.map((k) => k.type))
  if (types.has('Steps')) return 'checklist'
  if (types.has('BarChart') || types.has('LineChart') || types.has('PieChart')) return 'trendUp'
  if (types.has('Table')) return 'insights'
  const lists = kids.filter((k) => k.type === 'ListBlock')
  if (lists.length > 0) {
    const items = lists.flatMap((l) => (Array.isArray(l.props['items']) ? (l.props['items'] as unknown[]).filter(isNode) : []))
    const links = items.length > 0 && items.every((i) => actionsOf(i.props['action']).some((a) => a.kind === 'url'))
    return links ? 'link' : 'checklist'
  }
  if (types.has('EntityList')) return 'info'
  return 'insights'
}

// ---- Where each tap is (shared by the view and the tests) ----------------------------------------

/** The name a card goes by: its header title, else its first section heading. */
export function cardTitle(card: UiNode): string | null {
  const kids = Array.isArray(card.props['children']) ? (card.props['children'] as unknown[]).filter(isNode) : []
  const header = kids.find((k) => k.type === 'CardHeader')
  const t = header?.props['title']
  if (typeof t === 'string') return t
  const ih = kids.find((k) => k.type === 'InlineHeader')?.props['heading']
  return typeof ih === 'string' ? ih : null
}

export interface TapSpot {
  label: string
  scope: Scope
  actions: UiAction[]
  /** What a quiet tap tells the agent, or null when the button only opens a link. */
  message: string | null
}

/** Every button and tappable row in a tree, with the card and item its tap names, as the view resolves them. */
export function tapsIn(root: UiNode | null): TapSpot[] {
  const out: TapSpot[] = []
  const spot = (label: string, action: unknown, scope: Scope): void => {
    const steps = actionsOf(action)
    const actions: UiAction[] = steps.length === 0 && action === undefined && label.trim() !== '' ? [{ kind: 'assistant', text: label, context: null }] : steps
    const first = actions.find((a) => a.kind === 'assistant')
    out.push({ label, scope, actions, message: first !== undefined && first.kind === 'assistant' ? messageFor(first, scope) : null })
  }
  const walk = (v: unknown, scope: Scope): void => {
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, scope))
      return
    }
    if (!isNode(v)) return
    if (v.type === 'Card') {
      const title = cardTitle(v)
      const kids = Array.isArray(v.props['children']) ? (v.props['children'] as unknown[]).filter(isNode) : []
      const hasHeader = kids.some((k) => k.type === 'CardHeader')
      let section: string | null = null
      kids.forEach((k) => {
        if (k.type === 'InlineHeader' && hasHeader) section = typeof k.props['heading'] === 'string' ? k.props['heading'] : null
        walk(k, { card: title, item: section })
      })
      return
    }
    if (v.type === 'Product') {
      walk(v.props['actions'], { card: typeof v.props['name'] === 'string' ? v.props['name'] : '' })
      return
    }
    if (v.type === 'Button') {
      spot(typeof v.props['label'] === 'string' ? v.props['label'] : '', v.props['action'], scope)
      return
    }
    if (v.type === 'ListItem' && v.props['action'] !== undefined) {
      const title = typeof v.props['title'] === 'string' ? v.props['title'] : ''
      spot(title, v.props['action'], { ...scope, item: title })
      return
    }
    Object.values(v.props).forEach((x) => walk(x, scope))
  }
  walk(root, {})
  return out
}
