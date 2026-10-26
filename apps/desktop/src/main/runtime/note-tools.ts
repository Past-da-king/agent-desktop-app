/**
 * How a message reaches a plan run (Claude or Codex on the person's plan) mid-turn: with the result of the app tool
 * it is running. The engine runs its own loop, so the app cannot slip a note in between steps; what it can do is
 * hand it over at the next tool-call boundary, packaged with that tool's result (26 Oct 2026, "never queued").
 *
 * A tool that only reads is cut off the moment the bell rings, so the note never waits for a slow read (a page wait,
 * a search, a read-only command): its result says it was cut short, and the note rides with it. A tool that changes
 * something always finishes first.
 */
import { CUT_SHORT_RESULT, raceAbort, type Bell, type Tool } from '@agent/core'

export interface NoteToolsOptions {
  /** Notes waiting for the run, taken once (an empty list when there are none, or when they must not be taken now). */
  take: () => string[]
  /** How the notes read inside the result. */
  frame?: (notes: string) => string
  /** Rung when a note arrives. Without it nothing is cut off. */
  bell?: Bell
  /** May this call be cut off for a note? Default: never. */
  interruptible?: (name: string, input: Record<string, unknown>) => boolean
  /** Told when a read was cut off. */
  onCut?: (name: string) => void
}

export function withNoteTools(tools: Tool[], options: NoteToolsOptions): Tool[] {
  const frame = options.frame ?? ((notes: string) => notes)
  return tools.map((tool) => ({
    ...tool,
    run: async (input, ctx) => {
      let answer: string
      const bell = options.bell
      if (bell !== undefined && options.interruptible?.(tool.spec.name, input) === true) {
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        if (ctx.signal.aborted) controller.abort()
        else ctx.signal.addEventListener('abort', abort, { once: true })
        const off = bell.on(abort)
        try {
          answer = await raceAbort(tool.run(input, { ...ctx, signal: controller.signal }), controller.signal)
        } catch (error) {
          if (ctx.signal.aborted || !controller.signal.aborted) throw error
          answer = CUT_SHORT_RESULT
          options.onCut?.(tool.spec.name)
        } finally {
          off()
          ctx.signal.removeEventListener('abort', abort)
        }
      } else {
        answer = await tool.run(input, ctx)
      }
      const notes = options.take()
      return notes.length === 0 ? answer : `${answer}\n\n${frame(notes.join('\n\n'))}`
    },
  }))
}
