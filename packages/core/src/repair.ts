/**
 * Repairs a stored conversation so every assistant tool call is followed by its results.
 *
 * Every provider rejects a history where tool calls and tool results do not pair up, and keeps
 * rejecting it on every message after, so the chat is stuck until the user clears their data.
 * Causes: a run cut short (calls with no results), and something else writing to the conversation
 * mid-tool (a routine, a voice call, a typed answer) so the results land after an unrelated message.
 *
 * So: each assistant tool call gets its result placed straight after it (found anywhere before the
 * next assistant message, or a stub saying it was interrupted), and any result no call claims is dropped.
 */
import {
  msgToolCalls,
  type Block,
  type ImageBlock,
  type Msg,
  type ToolResultBlock,
} from './model'

export const INTERRUPTED = 'Interrupted before it finished (the app was closed or stopped).'

export function repair(msgs: Msg[]): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!
    if (m.role === 'ASSISTANT') {
      out.push(m)
      const calls = msgToolCalls(m)
      if (calls.length === 0) continue
      const ids = new Set(calls.map((c) => c.id))
      const found = new Map<string, ToolResultBlock>()
      let j = i + 1
      while (j < msgs.length && msgs[j]!.role !== 'ASSISTANT') {
        for (const b of msgs[j]!.blocks) {
          if (b.t === 'result' && ids.has(b.id) && !found.has(b.id)) found.set(b.id, b)
        }
        j++
      }
      const next = msgs[i + 1]
      const images = next && carriesResults(next) ? next.blocks.filter(isImage) : []
      const blocks: Block[] = calls.map(
        (call): ToolResultBlock =>
          found.get(call.id) ?? { t: 'result', id: call.id, content: INTERRUPTED, err: true },
      )
      out.push({ role: 'USER', blocks: [...blocks, ...images] })
    } else {
      const prev = i > 0 ? msgs[i - 1] : undefined
      const followsCalls =
        prev !== undefined &&
        prev.role === 'ASSISTANT' &&
        msgToolCalls(prev).length > 0 &&
        carriesResults(m)
      const rest = m.blocks.filter(
        (b) => b.t !== 'result' && !(followsCalls && b.t === 'image'),
      )
      if (rest.length > 0) {
        out.push(rest.length === m.blocks.length ? m : { role: m.role, blocks: rest })
      }
    }
  }
  return out
}

/**
 * Last resort when a provider still rejects the history's tool exchange: keep every word the user
 * and the agent said, drop the earlier tool calls and results. The current turn (after the last
 * thing the user typed) is left whole so the work in progress carries on.
 */
export function flatten(msgs: Msg[]): Msg[] {
  let lastUser = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.role === 'USER' && m.blocks.some((b) => b.t === 'text')) {
      lastUser = i
      break
    }
  }
  const before: Msg[] = []
  for (const m of msgs.slice(0, lastUser)) {
    // Reasoning stays with the words it explains: thinking models (DeepSeek) refuse a history
    // whose earlier assistant turns lost it.
    const keep = m.blocks.filter((b) => b.t === 'text' || b.t === 'image' || b.t === 'reasoning')
    if (!keep.some((b) => b.t !== 'reasoning')) continue
    before.push({ role: m.role, blocks: keep })
  }
  return [...before, ...msgs.slice(lastUser)]
}

function carriesResults(m: Msg): boolean {
  return m.role === 'USER' && m.blocks.some((b) => b.t === 'result')
}

function isImage(b: Block): b is ImageBlock {
  return b.t === 'image'
}
