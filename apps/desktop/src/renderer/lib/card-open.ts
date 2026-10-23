/**
 * What tapping a working card does, the same everywhere cards are listed (the side panel, its collapsed strip, the
 * title bar's card list on pages with no side panel, a helper's link to its chat). Three different things, kept apart:
 *  - the main chat's card: the main chat in full, at its newest message, cursor in the box;
 *  - a project chat's card (a project's own agent, its own thread): that chat in full under its project's header,
 *    exactly as when the person opens it from the project's page; it does not matter which device runs it;
 *  - a helper's card (one job: a brief, steps, a result): the helper's own view, which links to the project chat it
 *    works in, if it has one.
 * Every move keeps where the person was, so Back returns there.
 */
import { MAIN_CHAT, type ChatItem } from '@agent/core'

import type { CardKind } from '../../shared/helper-cards'
import { projectChatLines } from '../../shared/helper-cards'
import { openChat, openHelper } from './chat-actions'
import { metaOf, metaText } from './meta'

export type CardTarget = { kind: 'main' } | { kind: 'project-chat'; chat: string } | { kind: 'helper'; id: string }

/** The main chat's card: shown while the main chat works or waits on the person. */
export interface MainCard {
  kind: 'main'
  id: typeof MAIN_CHAT
  label: string
  line: string
  waiting: boolean
}

/** Where a card goes. A card from an older computer has no kind: a project chat is the one carrying `projectChat`. */
export function cardTarget(card: { kind?: CardKind | 'main'; projectChat?: string; id: string }): CardTarget {
  if (card.kind === 'main') return { kind: 'main' }
  const chat = card.projectChat ?? ''
  if (card.kind === 'project-chat' || (card.kind === undefined && chat !== '')) return { kind: 'project-chat', chat }
  return { kind: 'helper', id: card.id }
}

/** Do what a tap on the card does. */
export function openTarget(target: CardTarget): void {
  if (target.kind === 'main') openChat(MAIN_CHAT)
  else if (target.kind === 'project-chat') openChat(target.chat)
  else openHelper(target.id)
}

export function openCard(card: { kind?: CardKind | 'main'; projectChat?: string; id: string }): void {
  openTarget(cardTarget(card))
}

/**
 * The main chat's card, or null when the main chat is neither working nor waiting on the person (only working
 * cards show, as for helpers). Its line is the step the main agent is on, else its newest line.
 */
export function mainCard(items: ChatItem[], running: boolean, waiting: number, agentName: string): MainCard | null {
  if (!running && waiting === 0) return null
  const lines = projectChatLines(items, MAIN_CHAT)
  const step = [...lines].reverse().find((line) => line.kind === 'activity' && metaText(metaOf(line), 'status') === 'running') ?? lines[lines.length - 1]
  const text = step === undefined ? '' : (metaText(metaOf(step), 'summary') || step.text).replace(/\s+/g, ' ').trim()
  const line = waiting > 0 ? (waiting === 1 ? 'Waiting for you' : `${waiting} waiting for you`) : text === '' ? 'Working' : text.length > 160 ? `${text.slice(0, 159)}…` : text
  return { kind: 'main', id: MAIN_CHAT, label: agentName, line, waiting: waiting > 0 }
}
