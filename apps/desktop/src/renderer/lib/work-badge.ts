/**
 * The number on the title bar's work button. It used to add the cards working to the cards waiting and call the sum
 * "Needs you" (3 working + 6 waiting read "9 Needs you" beside a rail badge and a Home line that both said 6).
 * The number now always counts the thing the word names. "Needs you" is the waiting list of state/useWaiting, the
 * one list the rail badge, Home and the side panel count too.
 */
export interface WorkCounts {
  working: number
  held: number
  replied: number
  /** Cards waiting on the person: `useWaiting().length`. */
  waiting: number
}

export function workBadge(counts: WorkCounts): { n: number; word: 'Needs you' | 'Working' | 'Waiting' | 'Replied' } {
  if (counts.waiting > 0) return { n: counts.waiting, word: 'Needs you' }
  if (counts.working > 0) return { n: counts.working, word: 'Working' }
  if (counts.held > 0) return { n: counts.held, word: 'Waiting' }
  return { n: counts.replied, word: 'Replied' }
}
