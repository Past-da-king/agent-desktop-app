/**
 * A long run piles up tool output (pages, screenshots, code results) until the model's context is full.
 * Before each step, old tool results beyond the budget are cut down to a short stub, newest kept whole,
 * so the agent can keep going for hundreds of steps. Its own words and the user's are never cut.
 */
import type { Block, ImageBlock, Msg, ToolResultBlock } from './model'

export const BUDGET = 350_000
export const KEEP_RECENT = 8

export function messageSize(m: Msg): number {
  return m.blocks.reduce((total, b) => total + blockSize(b), 0)
}

function blockSize(b: Block): number {
  switch (b.t) {
    case 'text':
      return b.text.length
    case 'result':
      return b.content.length
    case 'call':
      return JSON.stringify(b.input).length
    case 'image':
      return 6_000
    case 'reasoning':
      return 0
  }
}

export function trimFit(history: Msg[]): void {
  let total = history.reduce((sum, m) => sum + messageSize(m), 0)
  if (total <= BUDGET) return
  const last = Math.max(0, history.length - KEEP_RECENT)
  for (let i = 0; i < last; i++) {
    if (total <= BUDGET) return
    const m = history[i]!
    if (!m.blocks.some((b) => b.t === 'result' || b.t === 'image')) continue
    const slimBlocks: Block[] = []
    for (const b of m.blocks) {
      if (isResult(b) && b.content.length > 400) {
        slimBlocks.push({
          ...b,
          content: b.content.slice(0, 300) + '\n[...older output trimmed to save room]',
        })
      } else if (!isImage(b)) {
        slimBlocks.push(b)
      }
    }
    if (slimBlocks.length === 0) continue
    const slim: Msg = { role: m.role, blocks: slimBlocks }
    total += messageSize(slim) - messageSize(m)
    history[i] = slim
  }
}

function isResult(b: Block): b is ToolResultBlock {
  return b.t === 'result'
}

function isImage(b: Block): b is ImageBlock {
  return b.t === 'image'
}
