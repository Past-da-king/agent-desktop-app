import type { ChatItem } from '@agent/core'
import { useMemo, useState } from 'react'

import { withNo } from '../../shared/ask-options'
import { chat } from '../bridge'
import { chatOf } from '../lib/chats'
import { metaStrings, metaText, parseMeta } from '../lib/meta'
import { sourceOfChat, type ChatSource } from '../lib/source'
import { useChats } from '../state/useChats'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { Icon } from '../ui/Icon'
import { ProjectTile } from '../ui/ProjectTile'

/** Cards shown before "Show all": the rest of the panel stays in reach. */
const SHOWN = 3

/** Where a waiting card came from: the project's tile and name, or the main agent's. */
function SourceTag({ source }: { source: ChatSource }): JSX.Element {
  return (
    <span className="ny-src">
      {source.icon === null ? (
        <span className="ny-src-ic" aria-hidden="true">
          <Icon name="chat" size={13} />
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

  const act = (run: () => Promise<unknown>): void => {
    if (sending) return
    setSending(true)
    void run().catch(() => setSending(false))
  }

  return (
    <li className={`ny-card${approval ? ' appr-k' : ''}`}>
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
  const items = useEntity('chat_item')
  const projects = useEntity('project')
  const agentName = useSettings((store) => store.settings?.agentName.trim()) || 'Your agent'
  const openChat = useChats((store) => store.openChat)
  const navigate = useUi((store) => store.navigate)
  const focusComposer = useUi((store) => store.focusComposer)
  const [all, setAll] = useState(false)
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
              openChat(chatOf(item))
              navigate({ page: 'chat' })
              focusComposer()
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
