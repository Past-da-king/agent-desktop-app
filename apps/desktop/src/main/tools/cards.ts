/**
 * The main agent answers cards for him (23 Nov 2026, "Agent acts for me on approvals").
 *
 *   cards_waiting   the cards routed to it: id, who asked, what, the exact details, the options
 *   card_answer     approve, decline, answer a question, or escalate to him, with a one-line reason
 *
 * Only the main agent in the main thread has these (a helper, a routine and a project chat never do, and the tool
 * checks that again). card_answer refuses a card that is his: the app recomputes whose it is from the real tool call
 * it stamped on the card (runtime/acts-for-me.ts, shared/approval-policy.ts), never from what the card says.
 */
import { MAIN_CHAT, schema, str, type Tool, type ToolContext } from '@agent/core'

import type { ActResult, AnswerArgs, WaitingEntry } from '../runtime/acts-for-me'

export interface CardToolDeps {
  waiting: () => Promise<WaitingEntry[]>
  answer: (args: AnswerArgs) => Promise<ActResult>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The main agent in the main thread only. */
export function mayAnswerCards(ctx: Pick<ToolContext, 'agentLabel' | 'owner' | 'chat'>): string | null {
  const owner = ctx.owner ?? ''
  if (owner.startsWith('helper:') || owner === 'routine' || owner === 'device' || owner.startsWith('chat:')) return 'Refused: only the main agent in the main thread answers cards for Ayanda. A helper, a routine or a project chat never does.'
  if ((ctx.chat ?? MAIN_CHAT) !== MAIN_CHAT) return 'Refused: a project chat never answers cards for Ayanda.'
  if (ctx.agentLabel !== 'main') return 'Refused: only the main agent answers cards for Ayanda.'
  return null
}

export function cardTools(deps: CardToolDeps): Tool[] {
  return [
    {
      spec: {
        name: 'cards_waiting',
        description:
          'The approval and question cards the app handed to you to answer for Ayanda ("Agent acts for me on approvals"): id, who asked, what, the exact details and options. Vet each one, then card_answer.',
        schema: schema([], {}),
      },
      run: async (_input, ctx) => {
        const refused = mayAnswerCards(ctx)
        if (refused !== null) return refused
        const list = await deps.waiting()
        if (list.length === 0) return 'No cards are waiting for you.'
        return list
          .map((card) =>
            [
              `id ${card.id} | ${card.kind} | from ${card.asker} | waiting ${Math.max(1, Math.round(card.ageMs / 60_000))} min | rule ${card.rule}`,
              `  ${card.summary}`,
              ...(card.details === '' ? [] : [`  details: ${card.details}`]),
              ...(card.options.length === 0 ? [] : [`  options: ${card.options.join(' | ')}`]),
            ].join('\n'),
          )
          .join('\n\n')
      },
    },
    {
      spec: {
        name: 'card_answer',
        description:
          "Answer a card for Ayanda: approve or decline an approval, answer a question (from memory or what you know), or escalate it to him when it is truly worth his eyes. For an explicitly requested person-send approval, use the complete originating user instruction as the reason. Always give a one-line reason: it is shown in his Answered for you list. The app refuses a card that is his: text sent to a person unless the exact send was requested, money, his own hands (sign-in, passkey, phone, card), secrets, anything unknown, and your own cards. Do not try to get around a refusal.",
        schema: schema(['id', 'action', 'reason'], {
          id: str('The card id from cards_waiting'),
          action: str('approve, decline, answer or escalate'),
          answer: str('For a question: the answer text (one of its options when it has them)'),
          reason: str('One line: why you decided this'),
        }),
      },
      run: async (input, ctx) => {
        const refused = mayAnswerCards(ctx)
        if (refused !== null) return refused
        const id = text(input['id']).trim()
        const action = text(input['action']).trim().toLowerCase()
        const reason = text(input['reason'])
        if (id === '') return 'Pass the card id.'
        let args: AnswerArgs
        if (action === 'approve' || action === 'decline') args = { id, action, reason }
        else if (action === 'answer') args = { id, action, answer: text(input['answer']), reason }
        else if (action === 'escalate') args = { id, action, reason }
        else return 'action must be approve, decline, answer or escalate.'
        const result = await deps.answer(args)
        return result.message
      },
    },
  ]
}
