import type { ChatItem } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { withNo } from '../../shared/ask-options'
import { chat } from '../bridge'
import { openChat } from '../lib/chat-actions'
import { chatOf } from '../lib/chats'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { flashWaitingCard, SHOW_WAITING_EVENT } from '../lib/needs-you'
import { sourceOfChat, type ChatSource } from '../lib/source'
import { useCalmEntity, useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { ProjectTile } from '../ui/ProjectTile'

/** Cards shown before "Show all": the rest of the panel stays in reach. */
const SHOWN = 3

/** Where a waiting card came from: the project's tile and name, or the main agent's. */
function SourceTag({ source }: { source: ChatSource }): JSX.Element {
  const mascot = useSettings((store) => store.settings?.mascot ?? 'scout')
  return (
    <span className="ny-src">
      {source.icon === null ? (
        <span className="ny-src-ic mascot" aria-hidden="true">
          <Mascot id={mascot} size={20} />
        </span>
      ) : (
        <ProjectTile icon={source.icon} size={20} />
      )}
      <span className="ny-src-name">{source.name}</span>
    </span>
  )
}

export function WaitingCard({ item, source, onOpen }: { item: ChatItem; source: ChatSource; onOpen: () => void }): JSX.Element {
  const meta = parseMeta(item.meta)
  const [sending, setSending] = useState(false)
  const approval = item.kind === 'approval'
  const options = metaStrings(meta, 'options')
  const handoff = !approval && options.includes('Done, carry on')
  const title = approval ? metaText(meta, 'summary') || item.text : item.text
  const answers = approval ? [] : handoff ? ['Done, carry on', 'Skip'] : withNo(options.length > 0 ? options : ['Yes']).slice(0, 4)

  // The exact thing being approved (the command, the message, the list), not only its one-line summary.
  const details = approval ? metaText(meta, 'details').trim() : ''
  const [failed, setFailed] = useState(false)

  const act = (run: () => Promise<unknown>): void => {
    if (sending) return
    setSending(true)
    setFailed(false)
    void run().catch(() => {
      // The answer did not get through: the card says so and can be pressed again.
      setSending(false)
      setFailed(true)
    })
  }

  return (
    <li data-item={item.id} className={`ny-card${approval ? ' appr-k' : ''}`}>
      <div className="ny-top">
        <SourceTag source={source} />
        <span className="ny-kind">{approval ? 'Approve' : handoff ? 'Your turn' : 'Question'}</span>
        <button type="button" className="ny-open" onClick={onOpen} aria-label={`Open this in ${source.name}`} title="Open where it was asked">
          <Icon name="arrow" size={16} />
        </button>
      </div>
      <div className="ny-t" title={title}>
        {title}
      </div>
      {details !== '' ? (
        <pre className="ny-details" tabIndex={0} aria-label="Exactly what will happen">
          {details}
        </pre>
      ) : null}
      {failed ? (
        <div className="ny-fail" role="alert">
          That did not go through. Try again.
        </div>
      ) : null}
      <div className="ny-acts">
        {approval ? (
          <>
            <button type="button" className="btn fill ny-go" disabled={sending} onClick={() => act(() => chat.decide(item.id, 'approve'))}>
              Approve
            </button>
            <button type="button" className="ny-ans" disabled={sending} onClick={() => act(() => chat.decide(item.id, 'decline'))}>
              Decline
            </button>
          </>
        ) : (
          answers.map((answer, index) => (
            <button
              key={answer}
              type="button"
              className={index === 0 ? 'btn fill ny-go' : 'ny-ans'}
              disabled={sending}
              onClick={() => act(() => chat.answer(item.id, answer))}
            >
              {answer}
            </button>
          ))
        )}
      </div>
    </li>
  )
}

/**
 * Everything waiting on the person, from the main thread or any chat or project, first in the side panel:
 * approve, decline or answer right here, or open it where it was asked.
 */
export function NeedsYou(): JSX.Element | null {
  const waiting = useWaiting()
  const items = useCalmEntity('chat_item')
  const projects = useEntity('project')
  const agentName = useSettings((store) => store.settings?.agentName.trim()) || 'Your agent'
  const closeOverlay = useUi((store) => store.closeOverlay)
  const [all, setAll] = useState(false)
  // The chat pointed at a card that is folded behind "Show all": unfold, then ring it once it is drawn.
  const [point, setPoint] = useState('')
  useEffect(() => {
    const onShow = (event: Event): void => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id !== 'string' || id === '') return
      setAll(true)
      setPoint(id)
    }
    window.addEventListener(SHOW_WAITING_EVENT, onShow)
    return () => window.removeEventListener(SHOW_WAITING_EVENT, onShow)
  }, [])
  useEffect(() => {
    if (point === '' || !all) return
    flashWaitingCard(point)
    setPoint('')
  }, [point, all])
  const cards = useMemo(() => waiting.map((item) => ({ item, source: sourceOfChat(chatOf(item), items, projects, agentName) })), [waiting, items, projects, agentName])
  if (cards.length === 0) return null

  return (
    <section className="ny" aria-label="Waiting on you">
      <div className="hp-title">
        <span className="eyebrow">NEEDS YOU</span>
        <span className="small muted">{cards.length === 1 ? '1 waiting' : `${cards.length} waiting`}</span>
      </div>
      <ul className="ny-list">
        {(all ? cards : cards.slice(0, SHOWN)).map(({ item, source }) => (
          <WaitingCard
            key={item.id}
            item={item}
            source={source}
            onOpen={() => {
              // The chat it was asked in, in full: the same move as a card tap (lib/chat-actions.ts openChat).
              closeOverlay()
              openChat(chatOf(item))
            }}
          />
        ))}
      </ul>
      {cards.length > SHOWN ? (
        <button type="button" className="ny-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${cards.length}`}
        </button>
      ) : null}
    </section>
  )
}
