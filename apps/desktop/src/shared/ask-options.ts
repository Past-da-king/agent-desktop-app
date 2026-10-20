/**
 * Whatever an agent asks of the user, there is always a No: "I don't want to do that myself". The agent's own
 * buttons come first, and No is the last one. A question that already has a way to refuse (No, Not now, Decline)
 * is left as it was. Ported from the phone app's agent/AskOptions.kt; used by the ask_user tool in the main
 * process and by the question card in the renderer.
 */
export const NO = 'No'

const REFUSALS = new Set(['no', 'no thanks', 'not now', 'decline', 'cancel', 'never mind'])

export function refuses(option: string): boolean {
  return REFUSALS.has(option.trim().replace(/[.!]+$/, '').toLowerCase())
}

/** True when the agent already offered its own way to say no. */
export function hasRefusal(options: string[]): boolean {
  return options.some(refuses)
}

export function withNo(options: string[]): string[] {
  return hasRefusal(options) ? options : [...options, NO]
}

/** At most `max` buttons for a place that cannot fit more (a notification), with No always kept. */
export function fit(options: string[], max: number): string[] {
  if (options.length <= max) return options
  const no = [...options].reverse().find(refuses) ?? NO
  return [...options.filter((o) => o !== no).slice(0, max - 1), no]
}

/** What the agent reads when the user turned down a request that had no refusal of its own. */
export const TURNED_DOWN =
  "The user said No: they don't want to do this themselves. Don't ask again. Find another way to get it done, or tell them plainly what you can't do."
