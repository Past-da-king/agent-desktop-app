/**
 * The provider-neutral agent loop: ask the model, run any tools it calls, feed the results
 * back, repeat until it answers in plain text (or hits the step cap).
 *
 * `history` is mutated in place: every assistant message and tool-result message is appended,
 * so the caller can persist exactly what the model saw.
 */
import { existsSync } from 'node:fs'

import type {
  Completion,
  ImageBlock,
  LlmProvider,
  Msg,
  TextBlock,
  Tool,
  ToolCallBlock,
  ToolContext,
  ToolResultBlock,
} from './model'
import { ProviderException, msgText, msgToolCalls } from './model'
import { flatten, repair } from './repair'
import { trimFit } from './trim'

export const IMAGE_MARKER = /\[\[image:([^\]]+)]]/g
export const RESULT_CLIP = 24_000

export type AgentEvent =
  | { type: 'thinking'; step: number }
  | { type: 'said'; text: string }
  | { type: 'tool_started'; call: ToolCallBlock }
  | { type: 'tool_finished'; call: ToolCallBlock; result: string; isError: boolean }

export interface AgentLoopOptions {
  provider: LlmProvider
  model: string
  tools: Tool[]
  /** No cap by default: the agent is long-running and stops when the work is done or the user stops it. */
  maxSteps?: number
}

export interface AgentLoopHooks {
  onEvent?: (event: AgentEvent) => void | Promise<void>
  onAppend?: (message: Msg) => void | Promise<void>
  /** Messages sent in while it works: steering notes read before every step. */
  incoming?: () => string[] | Promise<string[]>
  signal?: AbortSignal
}

export class AgentLoop {
  private readonly provider: LlmProvider
  private readonly model: string
  private readonly tools: Tool[]
  private readonly maxSteps: number
  private readonly byName: Map<string, Tool>

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider
    this.model = options.model
    this.tools = options.tools
    this.maxSteps = options.maxSteps ?? Number.MAX_SAFE_INTEGER
    this.byName = new Map(options.tools.map((tool) => [tool.spec.name, tool]))
  }

  async run(
    system: string,
    history: Msg[],
    ctx: ToolContext,
    hooks: AgentLoopHooks = {},
  ): Promise<string> {
    const { onEvent, onAppend, incoming, signal } = hooks
    let lastText = ''

    for (let step = 1; step <= this.maxSteps; step++) {
      if (signal?.aborted) break

      const notes = (await incoming?.()) ?? []
      if (notes.length > 0) {
        const text: TextBlock = {
          t: 'text',
          text: notes.map((note) => `[The main agent, while you work] ${note}`).join('\n\n'),
        }
        // Ride along in the last user message (after tool results) so the turn order stays valid everywhere.
        const last = history[history.length - 1]
        if (last !== undefined && last.role === 'USER') {
          history[history.length - 1] = { role: 'USER', blocks: [...last.blocks, text] }
        } else {
          history.push({ role: 'USER', blocks: [text] })
        }
      }

      await onEvent?.({ type: 'thinking', step })
      trimFit(history)

      let completion: Completion
      try {
        completion = await this.provider.complete(system, history, this.specs(), this.model)
      } catch (e) {
        // A history the provider calls malformed would block every message from now on. Rebuild it
        // without the earlier tool exchanges and try once more instead of making the user clear their data.
        if (!(e instanceof ProviderException)) throw e
        if (e.status !== 400 || !/tool/i.test(e.message)) throw e
        const fixed = flatten(repair(history))
        history.length = 0
        history.push(...fixed)
        completion = await this.provider.complete(system, history, this.specs(), this.model)
      }

      // Stop was pressed while the provider was answering: drop the reply and end the run cleanly.
      if (signal?.aborted) return lastText

      const reply = completion.message
      history.push(reply)
      await onAppend?.(reply)
      const text = msgText(reply)
      if (text) {
        lastText = text
        await onEvent?.({ type: 'said', text })
      }

      const calls = msgToolCalls(reply)
      if (calls.length === 0) return lastText

      const results: ToolResultBlock[] = []
      for (const call of calls) {
        await onEvent?.({ type: 'tool_started', call })
        const tool = this.byName.get(call.name)
        let out: string
        let isError: boolean
        if (tool === undefined) {
          out = `Unknown tool ${call.name}`
          isError = true
        } else {
          try {
            out = await tool.run(call.input, ctx)
            isError = false
          } catch (e) {
            if (signal?.aborted) return lastText
            out = `Error: ${e instanceof Error ? e.message || e.name : String(e)}`
            isError = true
          }
        }
        const clipped =
          out.length > RESULT_CLIP
            ? out.slice(0, RESULT_CLIP) + `\n…(cut, ${out.length} chars total)`
            : out
        await onEvent?.({ type: 'tool_finished', call, result: clipped, isError })
        results.push({ t: 'result', id: call.id, content: clipped, err: isError })
      }

      // Tools can hand the model pictures by writing [[image:/path]] lines.
      const images = results
        .flatMap((result) => imagePaths(result.content))
        .filter((path) => existsSync(path))
        .map((path): ImageBlock => ({ t: 'image', path, mime: 'image/jpeg' }))
      const resultMsg: Msg = { role: 'USER', blocks: [...results, ...images] }
      history.push(resultMsg)
      await onAppend?.(resultMsg)
    }

    if (signal?.aborted) return lastText
    return (
      lastText ||
      `I stopped after ${this.maxSteps} steps without finishing. Tell me to carry on and I will pick it up.`
    )
  }

  private specs() {
    return this.tools.map((tool) => tool.spec)
  }
}

function imagePaths(content: string): string[] {
  const paths: string[] = []
  const marker = new RegExp(IMAGE_MARKER.source, 'g')
  let match = marker.exec(content)
  while (match !== null) {
    const path = match[1]
    if (path) paths.push(path)
    match = marker.exec(content)
  }
  return paths
}
