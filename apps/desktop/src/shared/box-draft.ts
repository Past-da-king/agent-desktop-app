/**
 * The text of a chat's message box, the rules only (no window, no storage), so they are tested on their own.
 * A dictation only ever adds to what is there, and its words still being heard show after the draft without being
 * part of it until they are final.
 */

/** `words` added after `draft`, with one space between them when the draft does not end in white space. */
export function joinDraft(draft: string, words: string): string {
  if (words === '') return draft
  if (draft.trim() === '') return words
  return /\s$/.test(draft) ? `${draft}${words}` : `${draft} ${words}`
}

/** True when `draft` really holds `words` (what the composer confirms before a dictation counts as added). */
export function draftHolds(draft: string, words: string): boolean {
  return words.trim() !== '' && draft.includes(words.trim())
}

/**
 * The box shows `joinDraft(draft, live)`. What he typed there, as the draft: his edit to his own text is kept, what he
 * types after the live words joins his text, and an edit inside the live words is dropped (they are replaced at the
 * end anyway).
 */
export function draftFromBox(typed: string, draft: string, live: string): string {
  if (live === '') return typed
  const shown = joinDraft(draft, live)
  if (typed === shown) return draft
  if (typed.startsWith(shown)) return `${draft}${typed.slice(shown.length)}`
  const tail = shown.slice(draft.length)
  if (typed.endsWith(tail)) return typed.slice(0, typed.length - tail.length)
  // The edit reached into the live words. What is in front of them is his; the rest was the live words.
  let same = 0
  while (same < typed.length && same < draft.length && typed[same] === draft[same]) same += 1
  return same >= draft.length ? draft : typed.slice(0, same)
}
