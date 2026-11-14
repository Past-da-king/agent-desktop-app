/**
 * The one door the screen tools use to show the agent's cursor (11 Nov 2026; docs/agent-cursor.md, "Interface between
 * them"). It forwards to the app's AgentCursors (overlay/agent-cursor.ts, made in index.ts) and does nothing before
 * that exists or with the setting `agentCursor` off, so a caller never has to check.
 *
 *   agentCursor.show({ owner, rect, label })   glide to the middle of `rect` (screen DIPs, e.g. the control being acted on)
 *   agentCursor.show({ owner, locate, label }) or follow `locate` (called about 5 times a second: the window moved,
 *                                              was minimised or covered -> { at, visible }; null hides it)
 *   agentCursor.click(owner)                   pulse where it is
 *   agentCursor.label(owner, 'Typing...')      change the words only
 *   agentCursor.hide(owner)                    that run's cursor is gone (run end also does this by itself)
 *
 * `owner` is ctx.owner / browserOwner: one cursor per running agent.
 */
import type { AgentCursors, Locator } from '../overlay/agent-cursor'
import type { Rect } from '../overlay/rect'
import { ownerLabel } from '../browser/owner'

let current: AgentCursors | null = null

/** index.ts hands the app's cursors over once. */
export function setAgentCursors(cursors: AgentCursors | null): void {
  current = cursors
}

export interface AgentCursorShow {
  owner: string
  label?: string
  rect?: Rect
  locate?: Locator
}

export const agentCursor = {
  show(spec: AgentCursorShow): Promise<void> {
    const cursors = current
    if (cursors === null) return Promise.resolve()
    const who = ownerLabel(spec.owner)
    const label = spec.label === undefined ? {} : { label: spec.label }
    if (spec.locate !== undefined) return cursors.show(spec.owner, { locate: spec.locate, who, ...label })
    if (spec.rect !== undefined) return cursors.show(spec.owner, { at: { x: spec.rect.x + spec.rect.width / 2, y: spec.rect.y + spec.rect.height / 2 }, who, ...label })
    return cursors.show(spec.owner, { who, ...label })
  },
  click(owner: string): void {
    current?.click(owner)
  },
  label(owner: string, text: string): void {
    current?.label(owner, text)
  },
  hide(owner: string): void {
    current?.hide(owner)
  },
}
