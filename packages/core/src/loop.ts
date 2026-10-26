/**
 * The provider-neutral agent loop: ask the model, run any tools it calls, feed the results
 * back, repeat until it answers in plain text (or hits the step cap).
 *
 * `history` is mutated in place: every assistant message and tool-result message is appended,
 * so the caller can persist exactly what the model saw.
 *
 * A message the person sends while it works is never left waiting for the step in flight (26 Oct 2026, "my messages
 * should never be queued ever in life"). The caller rings `bell` when one arrives:
 *  - a model step in flight is cut off at once (its request aborted) and asked again with the message;
 *  - a tool in flight that only reads (`interruptible`) is aborted, and its result says it was cut short;
 *  - a tool that changes something is left to finish, never cut halfway; the message rides with its result;
 *  - calls the model asked for after that are not run: the model reads the message first and decides again.
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
import { withScriptTools } from './script'
import { trimFit } from './trim'

export const IMAGE_MARKER = /\[\[image:([^\]]+)]]/g
export const RESULT_CLIP = 24_000

/** What a read-only tool cut short for a new message returns, so the model knows why and may run it again. */
export const CUT_SHORT_RESULT =
  'Cut short: a new message arrived while this ran, so it was stopped to let you read it (it is right below). Run it again only if it still makes sense.'
/** What a call the model asked for, but which was not started because a new message came first, returns. */
export const NOT_RUN_RESULT =
  'Not run: a new message arrived before this step started (it is right below). Read it first; run this again only if it still makes sense.'

export type AgentEvent =
  | { type: 'thinking'; step: number }
  | { type: 'said'; text: string }
  | { type: 'tool_started'; call: ToolCallBlock }
  | { type: 'tool_finished'; call: ToolCallBlock; result: string; isError: boolean }
  /** A step in flight was cut off so a new message could be read now: the model's answer, or a read-only tool. */
  | { type: 'interrupted'; what: 'model' | 'tool'; call?: ToolCallBlock }

/** Rung when a new message for a running loop arrives. `on` returns the unsubscribe. */
export interface Bell {
  on(listener: () => void): () => void
}

/** The simplest bell: whoever holds it rings it, every loop listening hears it. */
export class NoteBell implements Bell {
  private readonly listeners = new Set<() => void>()

  on(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  ring(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A listener failing must never stop the message reaching the others.
      }
    }
  }
}

export interface AgentLoopOptions {
  provider: LlmProvider
  model: string
  tools: Tool[]
  /** No cap by default: the agent is long-running and stops when the work is done or the user stops it. */
  maxSteps?: number
  /**
   * May this call be cut off for a new message? Only calls that read (searches, page reads, waits, read-only commands)
   * say yes. Default: none, so anything unknown is treated as changing something and always finishes.
   */
  interruptible?: (call: ToolCallBlock) => boolean
}

export interface AgentLoopHooks {
  onEvent?: (event: AgentEvent) => void | Promise<void>
  onAppend?: (message: Msg) => void | Promise<void>
  /** The last message (already passed to onAppend) changed: a note rode along with its tool results. */
  onAmend?: (message: Msg) => void | Promise<void>
  /** Messages sent in while it works: steering notes read before every step. */
  incoming?: () => string[] | Promise<string[]>
  /** The notes `incoming` just handed over are now in the stored transcript (so they are never given twice). */
  delivered?: () => void | Promise<void>
  /** Is a note waiting? With `bell`, lets a step in flight be cut off for it. */
  hasIncoming?: () => boolean
  /** Rung when a note arrives. */
  bell?: Bell
  /** What each incoming note starts with. Helpers hear "[The main agent, while you work]"; a chat frames its own. */
  notePrefix?: string
  signal?: AbortSignal
}

export class AgentLoop {
  private readonly provider: LlmProvider
  private readonly model: string
  private readonly tools: Tool[]
  private readonly maxSteps: number
  private readonly interruptible: (call: ToolCallBlock) => boolean

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider
    this.model = options.model
    this.tools = options.tools
    this.maxSteps = options.maxSteps ?? Number.MAX_SAFE_INTEGER
    this.interruptible = options.interruptible ?? (() => false)
  }

  async run(
    system: string,
    history: Msg[],
    ctx: ToolContext,
    hooks: AgentLoopHooks = {},
  ): Promise<string> {
    const { onEvent, onAppend, incoming, signal } = hooks
    const prefix = hooks.notePrefix ?? '[The main agent, while you work] '
    const waiting = (): boolean => hooks.hasIncoming?.() ?? false
    let lastText = ''
    // run_script over this run's own tools: its inner calls show in the same work trail as ordinary calls.
    const tools =
      this.tools.length === 0
        ? this.tools
        : withScriptTools(this.tools, {
            started: (call) => onEvent?.({ type: 'tool_started', call }),
            finished: (call, result, isError) => onEvent?.({ type: 'tool_finished', call, result, isError }),
          })
    const byName = new Map(tools.map((tool) => [tool.spec.name, tool]))
    const specs = tools.map((tool) => tool.spec)

    for (let step = 1; step <= this.maxSteps; step++) {
      if (signal?.aborted) break

      const notes = (await incoming?.()) ?? []
      if (notes.length > 0) {
        const text: TextBlock = {
          t: 'text',
          text: notes.map((note) => `${prefix}${note}`).join('\n\n'),
        }
        // Ride along in the last user message (after tool results) so the turn order stays valid everywhere.
        const last = history[history.length - 1]
        if (last !== undefined && last.role === 'USER') {
          const amended: Msg = { role: 'USER', blocks: [...last.blocks, text] }
          history[history.length - 1] = amended
          await hooks.onAmend?.(amended)
        } else {
          const added: Msg = { role: 'USER', blocks: [text] }
          history.push(added)
          await onAppend?.(added)
        }
        await hooks.delivered?.()
      }

      await onEvent?.({ type: 'thinking', step })
      trimFit(history)

      // The model's step: cut off at once when a message arrives, then asked again with it.
      const stepStop = this.cutter(signal, hooks.bell, waiting)
      let completion: Completion
      try {
        completion = await this.ask(system, history, specs, stepStop.signal)
      } catch (e) {
        if (signal?.aborted) return lastText
        if (stepStop.signal.aborted) {
          stepStop.release()
          await onEvent?.({ type: 'interrupted', what: 'model' })
          continue
        }
        stepStop.release()
        // A history the provider calls malformed would block every message from now on. Rebuild it
        // without the earlier tool exchanges and try once more instead of making the user clear their data.
        if (!(e instanceof ProviderException)) throw e
        if (e.status !== 400 || !/tool/i.test(e.message)) throw e
        const fixed = flatten(repair(history))
        history.length = 0
        history.push(...fixed)
        completion = await this.provider.complete(system, history, specs, this.model, undefined, signal)
      }
      stepStop.release()

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
        // A message came in before this call started: the model reads it first and decides again.
        if (waiting()) {
          await onEvent?.({ type: 'tool_started', call })
          await onEvent?.({ type: 'tool_finished', call, result: NOT_RUN_RESULT, isError: true })
          results.push({ t: 'result', id: call.id, content: NOT_RUN_RESULT, err: true })
          continue
        }
        await onEvent?.({ type: 'tool_started', call })
        const tool = byName.get(call.name)
        let out: string
        let isError: boolean
        if (tool === undefined) {
          out = `Unknown tool ${call.name}`
          isError = true
        } else if (this.interruptible(call) && hooks.bell !== undefined) {
          // Only reads: a message arriving cuts it off (its own signal aborts and nobody waits for it).
          const callStop = this.cutter(signal, hooks.bell, waiting)
          try {
            out = await raceAbort(tool.run(call.input, { ...ctx, signal: callStop.signal }), callStop.signal)
            isError = false
          } catch (e) {
            if (signal?.aborted) {
              callStop.release()
              return lastText
            }
            if (callStop.signal.aborted) {
              out = CUT_SHORT_RESULT
              isError = true
              await onEvent?.({ type: 'interrupted', what: 'tool', call })
            } else {
              out = `Error: ${e instanceof Error ? e.message || e.name : String(e)}`
              isError = true
            }
          } finally {
            callStop.release()
          }
        } else {
          // Changes something (or unknown): never cut halfway. A message waits for its result and rides with it.
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

  /** One model step that ends the moment its signal aborts, even if the provider does not listen for it. */
  private ask(system: string, history: Msg[], specs: Tool['spec'][], signal: AbortSignal): Promise<Completion> {
    return raceAbort(this.provider.complete(system, history, specs, this.model, undefined, signal), signal)
  }

  /**
   * A controller for one step: aborted by Stop (the run's signal) or by a message arriving (the bell, or one already
   * waiting). `release` stops listening.
   */
  private cutter(run: AbortSignal | undefined, bell: Bell | undefined, waiting: () => boolean): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (run?.aborted === true) controller.abort()
    else run?.addEventListener('abort', abort, { once: true })
    const off = bell?.on(abort) ?? (() => undefined)
    if (bell !== undefined && waiting()) controller.abort()
    return {
      signal: controller.signal,
      release: () => {
        off()
        run?.removeEventListener('abort', abort)
      },
    }
  }
}

/** The promise's outcome, or an AbortError the moment the signal aborts (the promise is left to settle on its own). */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
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
