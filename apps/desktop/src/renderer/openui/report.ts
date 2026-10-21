/**
 * A report's body as the reader draws it: its prose as markdown, its ```openui-lang blocks as cards, and every
 * markdown table turned into an OpenUI Table card, so a table reads as a table even when the agent wrote pipes.
 * Pure: no DOM, so it is unit tested directly.
 */

import { q } from './ask'
import { splitMessage, type MessagePart } from './lang'

const ROW = /^\s*\|.*\|\s*$/
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const NUMBER = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) =>
    cell
      .trim()
      .replace(/\\\|/g, '|')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1'),
  )
}

/** A cell as OpenUI data: a plain number (commas allowed) becomes a number, so it lines up on the right. */
function cellValue(cell: string): string {
  return NUMBER.test(cell) ? String(Number(cell.replace(/,/g, ''))) : q(cell)
}

/** One markdown table as an OpenUI program: a Card holding a Table, one Col per column. */
export function tableProgram(head: string[], rows: string[][]): string {
  const lines = ['root = Stack([card])', 'card = Card([table])']
  const cols = head.map((_, i) => `c${i}`)
  lines.push(`table = Table([${cols.join(', ')}])`)
  head.forEach((label, i) => {
    const data = rows.map((row) => cellValue(row[i] ?? ''))
    lines.push(`c${i} = Col(${q(label)}, [${data.join(', ')}])`)
  })
  return lines.join('\n')
}

/** The markdown with each pipe table (header, rule, rows) replaced by an ```openui-lang block. Code is left alone. */
export function tablesToOpenUi(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (/^\s*```/.test(line)) {
      fence = !fence
      out.push(line)
      i += 1
      continue
    }
    if (!fence && ROW.test(line) && RULE.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && ROW.test(lines[j] ?? '')) {
        rows.push(cells(lines[j] ?? ''))
        j += 1
      }
      out.push('```openui-lang', tableProgram(head, rows), '```')
      i = j
      continue
    }
    out.push(line)
    i += 1
  }
  return out.join('\n')
}

/** The report split into prose and card blocks, tables included. */
export function reportParts(markdown: string): MessagePart[] {
  return splitMessage(tablesToOpenUi(markdown))
}
