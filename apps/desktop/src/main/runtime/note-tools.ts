/**
 * How a message reaches a plan run (Claude or Codex on the person's plan) mid-turn: with the result of the app tool
 * it is running. The engine runs its own loop, so the app cannot slip a note in between steps; what it can do is
 * hand it over at the next tool-call boundary, packaged with that tool's result (26 Oct 2026, "never queued").
 *
 * A tool that only reads is cut off the moment the bell rings, so the note never waits for a slow read (a page wait,
 * a search, a read-only command): its result says it was cut short, and the note rides with it. A tool that changes
 * something always finishes first.
 *
 * A helper's messages do not ride in tool results at all (30 Oct 2026: careful helpers rightly took text inside a tool
 * result for prompt injection and ignored real corrections). They go through TurnMessages, the engine's own channel for
 * a message (cli-agent.ts), and a tool here only makes room: with `hold` it does not start while one waits.
 */
import { CUT_SHORT_RESULT, raceAbort, type Bell, type Tool } from '@agent/core'

/** One message for a running plan turn, as the model will read it. */
export interface TurnMessage {
  id: string
  text: string
}

/**
 * Messages sent to a running plan turn. The engine adapter takes them and delivers each as a message of its own
 * (never a tool result, never a hook error), so only the app can have written one.
 */
export interface TurnMessages {
  /** Handed to the engine now: each one comes back through `read` or `putBack`. */
  take(): TurnMessage[]
  /** Is one waiting to be taken? */
  waiting(): boolean
  /** Is one not read yet (waiting, or with the engine)? A step does not start while this holds. */
  hold(): boolean
  /** The model has it: the engine put it in the conversation. */
  read(ids: string[]): void
  /** The engine never got to it (the turn ended first): it waits again. */
  putBack(ids: string[]): void
  /** Rung when one arrives. */
  bell: Bell
}

/** What a step answers when it was not started so a message can be read first. It carries no instruction of its own. */
export const HELD_STEP =
  'Not run: the app held this step so you read a new message first. The message itself comes as its own message in the conversation, not here. Run this again only if it still makes sense after reading it.'

export interface NoteToolsOptions {
  /** Notes waiting for the run, taken once (an empty list when there are none, or when they must not be taken now). */
  take?: () => string[]
  /** A message is waiting: a step that has not started does not start, and answers HELD_STEP. */
  hold?: () => boolean
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
      if (options.hold?.() === true) return HELD_STEP
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
      const notes = options.take?.() ?? []
      return notes.length === 0 ? answer : `${answer}\n\n${frame(notes.join('\n\n'))}`
    },
  }))
}
