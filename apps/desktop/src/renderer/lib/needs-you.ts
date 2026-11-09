/**
 * Pointing at one waiting card in the side panel's "Needs you" list from the chat. The list shows its first few
 * cards and folds the rest behind "Show all", so a card may not be drawn yet: the list is asked to open first.
 */
export const SHOW_WAITING_EVENT = 'agent:show-waiting'

/** Brings the card into view and rings it once. False when it is not drawn. */
export function flashWaitingCard(id: string, root: ParentNode = document): boolean {
  const card = root.querySelector<HTMLElement>(`.ny-card[data-item="${CSS.escape(id)}"]`)
  if (card === null) return false
  card.scrollIntoView({ block: 'center' })
  card.classList.remove('ny-flash')
  void card.offsetWidth
  card.classList.add('ny-flash')
  return true
}

/** From the chat's "Answer it in the side panel" line: show that card, unfolding the list when it is past the fold. */
export function showWaitingCard(id: string): void {
  if (flashWaitingCard(id)) return
  window.dispatchEvent(new CustomEvent<string>(SHOW_WAITING_EVENT, { detail: id }))
}
