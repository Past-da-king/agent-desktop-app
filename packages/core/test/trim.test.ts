import { describe, expect, it } from 'vitest'

import { BUDGET, KEEP_RECENT, messageSize, trimFit } from '../src/trim'
import type { Msg, ToolResultBlock } from '../src/model'

const BIG = 'x'.repeat(50_000)

function resultMsg(index: number, size = BIG): Msg {
  return {
    role: 'USER',
    blocks: [{ t: 'result', id: `r${index}`, content: size, err: false }],
  }
}

function resultOf(m: Msg): ToolResultBlock {
  const block = m.blocks.find((b) => b.t === 'result')
  if (block === undefined || block.t !== 'result') throw new Error('no result block')
  return block
}

describe('trimFit', () => {
  it('cuts old big tool results', () => {
    const history: Msg[] = []
    for (let i = 0; i < 20; i++) history.push(resultMsg(i))
    expect(history.reduce((sum, m) => sum + messageSize(m), 0)).toBeGreaterThan(BUDGET)

    trimFit(history)

    expect(resultOf(history[0]!).content.length).toBeLessThan(400)
    expect(resultOf(history[0]!).content).toContain('older output trimmed')
  })

  it('leaves the recent messages untouched', () => {
    const history: Msg[] = []
    for (let i = 0; i < 24; i++) history.push(resultMsg(i))
    const recentStart = history.length - KEEP_RECENT

    trimFit(history)

    for (let i = recentStart; i < history.length; i++) {
      expect(resultOf(history[i]!).content).toBe(BIG)
    }
  })

  it('never cuts text', () => {
    const history: Msg[] = []
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'USER', blocks: [{ t: 'text', text: BIG }] })
    }

    trimFit(history)

    for (const m of history) {
      const block = m.blocks[0]!
      expect(block).toEqual({ t: 'text', text: BIG })
    }
  })

  it('does nothing when the history fits', () => {
    const history: Msg[] = [resultMsg(0, 'small'), resultMsg(1, 'also small')]
    const before = messageSize(history[0]!) + messageSize(history[1]!)

    trimFit(history)

    expect(messageSize(history[0]!) + messageSize(history[1]!)).toBe(before)
  })
})
