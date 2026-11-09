import { useEffect, useRef } from 'react'

import { dismissCard, openTarget } from '../lib/card-open'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { Icon } from '../ui/Icon'
import { helperHold } from '../../shared/helper-cards'
import { HelperCardList, useListGroups, useMainCard, useNeedsCards, usePanelCards, useScopedCards } from './HelpersPanel'
import { NeedsYou } from './NeedsYou'
import { usePanelShown } from './Panel'

/**
 * The working cards where the side panel is not on screen (Settings and the other pages without it, a narrow window,
 * the panel collapsed): a button in the title bar with how many there are, opening the same lists the side panel
 * has (Needs you, then the cards working now). A tap does exactly what it does in the side panel.
 */
export function WorkButton(): JSX.Element | null {
  const open = useUi((store) => store.overlay === 'work')
  const setOverlay = useUi((store) => store.setOverlay)
  const shown = usePanelShown()
  const cards = usePanelCards()
  const main = useMainCard()
  const waiting = useWaiting()
  const count = cards.length + (main === null ? 0 : 1)
  if (shown || (count === 0 && waiting.length === 0)) return null
  const replied = cards.filter((card) => card.waiting).length
  // Held by the low-memory guard or the queue: on the list, but not working.
  const held = cards.filter((card) => helperHold(card) !== null).length
  const working = count - replied - held
  const label = [working > 0 ? `${working} working` : '', held > 0 ? `${held} waiting to start` : '', replied > 0 ? `${replied} replied` : '', waiting.length > 0 ? `${waiting.length} waiting for you` : ''].filter((part) => part !== '').join(', ')
  return (
    <div className="tb-work-wrap">
      <button
        type="button"
        className={`tb-work${waiting.length > 0 ? ' needs' : ''}`}
        aria-label={`${label}. Show them`}
        aria-expanded={open}
        title={label}
        onClick={() => setOverlay(open ? null : 'work')}
      >
        <span className="tb-work-dot" aria-hidden="true" />
        <span className="tb-work-n">{count + waiting.length}</span>
        <span className="tb-work-t">{waiting.length > 0 ? 'Needs you' : working > 0 ? 'Working' : held > 0 ? 'Waiting' : 'Replied'}</span>
      </button>
      {open ? <WorkMenu /> : null}
    </div>
  )
}

function WorkMenu(): JSX.Element {
  const close = useUi((store) => store.closeOverlay)
  const mascot = useSettings((store) => store.settings?.mascot ?? 'scout')
  const { cards, main, current } = useScopedCards()
  const needs = useNeedsCards()
  const groups = useListGroups(current)
  const projects = useEntity('project')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (box.current !== null && target !== null && !box.current.contains(target) && !(target instanceof Element && target.closest('.tb-work') !== null)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [close])

  return (
    <div className="work-menu" ref={box} role="dialog" aria-label="Working now and waiting for you">
      <div className="work-menu-h">
        <b>Jump to a chat or helper</b>
        <button type="button" className="hp-x" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="work-menu-b">
        <NeedsYou />
        <HelperCardList
          cards={cards}
          main={main}
          current={current}
          mascot={mascot}
          needs={needs}
          groups={groups}
          onOpen={(target) => {
            close()
            openTarget(target)
          }}
          onClose={(card) => void dismissCard(card, projects)}
        />
        {cards.length === 0 && main === null ? <p className="small muted">Nothing is working right now.</p> : null}
      </div>
    </div>
  )
}

/** Back to where the person was before the last move (a card tap, a page, a chat). Alt+Left does the same. */
export function BackButton(): JSX.Element {
  const can = useUi((store) => store.back.length > 0)
  const goBack = useUi((store) => store.goBack)
  return (
    <button type="button" className="tb-btn tb-back" aria-label="Back" title={can ? 'Back (Alt+Left)' : 'Back'} disabled={!can} onClick={() => goBack()}>
      <Icon name="arrow" size={20} />
    </button>
  )
}
