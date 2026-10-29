import { MAIN_CHAT, type ChatItem, type MascotId, type ProjectRow } from '@agent/core'
import { PlaceChip } from '../ui/PlaceChip'
import { useEffect, useMemo, useState } from 'react'

import { agent } from '../bridge'
import { cardTarget, dismissCard, mainCard, openTarget, type CardTarget, type MainCard } from '../lib/card-open'
import { openChat } from '../lib/chat-actions'
import { chatOf, chatTitleOf, itemsOfChat } from '../lib/chats'
import { helperCards, helperIdOf, helperOwner, helperView, isHelper, type HelperCard, type HelperOwner, type HelperView } from '../lib/helpers'
import { metaText, parseMeta } from '../lib/meta'
import { cardsForChat, helperParentChat } from '../../shared/helper-cards'
import { useChats } from '../state/useChats'
import { useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { Icon, type IconName } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'
import { Mascot } from '../ui/Mascot'
import { ProjectTile } from '../ui/ProjectTile'
import { runFromMeta } from '../../shared/run-record'
import { RunStep } from '../views/RunStep'

function stateLabel(helper: HelperView): { label: string; tone: string; icon: IconName } {
  if (helper.state === 'working') return helper.queued ? { label: 'Queued', tone: 'mute', icon: 'clock' } : { label: 'Working', tone: 'pri', icon: 'globe' }
  if (helper.state === 'done') return { label: 'Done', tone: 'ok', icon: 'check' }
  if (helper.state === 'failed') return { label: 'Failed', tone: 'warn', icon: 'x' }
  return { label: 'Stopped', tone: 'mute', icon: 'stop' }
}

/** A helper's picture from whose it is: the agent's own, the project's icon, or the plain helper icon. */
export function OwnerAvatar({ owner, helper, mascot, size = 32 }: { owner: HelperOwner; helper: HelperView; mascot: MascotId; size?: number }): JSX.Element {
  if (owner.kind === 'main') {
    return (
      <span className="hp-av" aria-hidden="true">
        <Mascot id={mascot} size={size} />
      </span>
    )
  }
  if (owner.kind === 'project') return <ProjectTile icon={owner.icon} size={size} />
  const s = stateLabel(helper)
  return (
    <span className={`hp-ic ${s.tone}`} aria-hidden="true">
      <Icon name={s.icon} size={16} />
    </span>
  )
}

/**
 * Whose helper it is, as its picture: the agent's own for the main chat's helpers, the project's icon for a
 * project's helpers and for a project agent's own row. A hidden project shows nothing of itself, so its helpers
 * get the plain helper icon.
 */
export function HelperAvatar({ row, helper, size = 32 }: { row: ChatItem | undefined; helper: HelperView; size?: number }): JSX.Element {
  const projects = useEntity('project')
  const mascot = useSettings((store) => store.settings?.mascot ?? 'scout')
  const owner: HelperOwner = row === undefined ? { kind: 'main' } : helperOwner(row, projects)
  return <OwnerAvatar owner={owner} helper={helper} mascot={mascot} size={size} />
}

function stepText(item: ChatItem): string {
  return metaText(parseMeta(item.meta), 'summary') || item.text
}

function useStop(): { stopping: string | null; stop: (id: string) => void } {
  const [stopping, setStopping] = useState<string | null>(null)
  return {
    stopping,
    stop: (id) => {
      setStopping(id)
      void agent.helpers.stop(id).finally(() => setStopping(null))
    },
  }
}

/**
 * The side panel's cards (shared/helper-cards.ts helperCards): every project chat that works or waits on the person
 * until he closes it, the helpers it started under it, and every other helper while it works.
 */
export function usePanelCards(): HelperCard[] {
  const items = useEntity('chat_item')
  const projects = useEntity('project')
  const runs = useChats((state) => state.runs)
  return useMemo(() => helperCards(items, projects, { running: (chat) => runs[chat]?.running === true }), [items, projects, runs])
}

/** The same cards (the collapsed strip's faces and older callers). */
export function useWorkingHelpers(): HelperCard[] {
  return usePanelCards()
}

/** A project agent's newest steps under its card while it works (the line above already says the one it is on). */
const CARD_STEPS = 3

/**
 * The cards working right now (the main chat's while it works or waits, then project chats with their helpers under
 * them, then the other helpers), under the agent's browser in the side panel and in the title bar's list. Nothing is
 * cut off: the list scrolls. What a tap does is the caller's `onOpen` (lib/card-open.ts openTarget everywhere): a
 * project chat's card and the main card open that chat in full; a helper's card opens the helper's own view.
 */
export function HelperCardList({
  cards,
  main = null,
  current = '',
  mascot,
  onOpen,
  onClose,
}: {
  cards: HelperCard[]
  main?: MainCard | null
  /** The chat on screen ('' on any other page): its card is marked. */
  current?: string
  mascot: MascotId
  onOpen: (target: CardTarget) => void
  /**
   * A card's X: a working card stops and leaves, a finished one (a project chat's, or a helper's under it) leaves the
   * list on every device (lib/card-open.ts dismissCard). Without it a working card's X only stops it.
   */
  onClose?: (card: HelperCard) => void
}): JSX.Element | null {
  const { stopping, stop } = useStop()
  if (cards.length === 0 && main === null) return null
  const working = cards.filter((card) => card.state === 'working').length + (main === null ? 0 : 1)
  const replied = cards.filter((card) => card.waiting).length
  const counts = [working > 0 || replied === 0 ? `${working} working` : '', replied > 0 ? `${replied} replied` : ''].filter((part) => part !== '').join(', ')
  return (
    <section className="hp" aria-label="Chats and helpers">
      <div className="hp-title">
        <span className="eyebrow">CHATS AND HELPERS</span>
        <span className="small muted">{counts}</span>
      </div>
      <ul className="hp-list">
        {main !== null ? (
          <li key="main" data-card="main" className={main.waiting ? undefined : 'hp-li closable'}>
            <button type="button" className="hp-card hp-main" data-kind="main" aria-current={current === MAIN_CHAT ? true : undefined} onClick={() => onOpen({ kind: 'main' })} aria-label={`Open the main chat with ${main.label}`} title={main.line}>
              <span className="hp-av" aria-hidden="true">
                <Mascot id={mascot} size={32} />
              </span>
              <span className="hp-t">
                <b>{main.label}</b>
                <span className="hp-where">Main chat</span>
                <span className="hp-line">{main.line}</span>
              </span>
              <span className={`pill ${main.waiting ? 'warn' : 'pri'}`}>{main.waiting ? 'Needs you' : 'Working'}</span>
            </button>
            {main.waiting ? null : (
              <button type="button" className="hp-close hp-stop" aria-label={`Stop ${main.label}`} title="Stop the main chat's run now" onClick={() => void agent.chat.stop(MAIN_CHAT)}>
                <Icon name="x" size={16} />
              </button>
            )}
          </li>
        ) : null}
        {cards.map((card) => {
          const s = card.waiting ? { label: 'Your turn', tone: 'ok' } : stateLabel(card)
          const target = cardTarget(card)
          // Every run at work has its stop on its card (28 Oct 2026: a routine and a background script ran unseen and
          // could only be stopped by killing processes). A project chat stops its own run; anything else by its id.
          const stoppable = card.state === 'working' && !card.waiting
          const closable = !stoppable && onClose !== undefined
          // A project chat's card reads as its project, named by its chat; a helper under it sits in its group; any other
          // project helper says which project it works in.
          const where = target.kind === 'project-chat' ? card.chatTitle || 'Project chat' : card.owner.kind === 'project' && card.depth === 0 ? card.owner.name : ''
          const opens = target.kind === 'project-chat' ? `Open the ${card.label} chat` : `Open ${card.label}, a helper`
          return (
            <li key={card.id} className={`hp-li${card.depth === 1 ? ' hp-sub' : ''}${card.waiting ? ' waiting' : ''}${closable || stoppable ? ' closable' : ''}`} data-card={card.id}>
              <button type="button" className="hp-card" data-kind={target.kind} aria-current={target.kind === 'project-chat' && current !== '' && target.chat === current ? true : undefined} onClick={() => onOpen(target)} aria-label={opens} title={card.line}>
                <OwnerAvatar owner={card.owner} helper={card} mascot={mascot} size={card.depth === 1 ? 28 : 32} />
                <span className="hp-t">
                  <b>
                    {card.label}
                    {card.model !== '' ? <span className="hp-model" title={`Runs on ${card.model}`}>{card.model}</span> : null}
                  </b>
                  {where !== '' ? <span className="hp-where">{where}</span> : null}
                  <span className={card.state === 'working' ? 'hp-line' : 'hp-line idle'}>{card.line}</span>
                  {target.kind === 'project-chat' && card.state === 'working' && card.steps.length > 1 ? (
                    <span className="hp-steps-mini" aria-label="Its newest steps">
                      {card.steps
                        .slice(-CARD_STEPS - 1, -1)
                        .reverse()
                        .map((step) => (
                          <span key={step.id}>{stepText(step)}</span>
                        ))}
                    </span>
                  ) : null}
                </span>
                <span className={`pill ${s.tone}`}>{s.label}</span>
              </button>
              {stoppable ? (
                <button
                  type="button"
                  className="hp-close hp-stop"
                  aria-label={`Stop ${card.label}`}
                  title="Stop it now (its run, its process and its browser tabs end)"
                  disabled={stopping === card.id}
                  onClick={() => {
                    if (onClose !== undefined) onClose(card)
                    else if (target.kind === 'project-chat') void agent.chat.stop(target.chat)
                    else stop(card.id)
                  }}
                >
                  <Icon name="x" size={16} />
                </button>
              ) : null}
              {closable ? (
                <button
                  type="button"
                  className="hp-close"
                  aria-label={card.kind === 'project-chat' ? `Close the ${card.label} card. The chat keeps going` : `Close the ${card.label} card`}
                  title={card.kind === 'project-chat' ? 'Close this card (the chat keeps going, and comes back when it moves)' : 'Close this card (its result stays in the chat)'}
                  onClick={() => onClose?.(card)}
                >
                  <Icon name="x" size={16} />
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The main chat's card while the main chat works or waits on the person, else null. */
export function useMainCard(): MainCard | null {
  const items = useEntity('chat_item')
  const running = useChats((state) => state.runs[MAIN_CHAT]?.running === true)
  const waiting = useWaiting()
  const agentName = useSettings((store) => store.settings?.agentName.trim()) || 'Your agent'
  const inMain = useMemo(() => waiting.filter((item) => chatOf(item) === MAIN_CHAT).length, [waiting])
  return useMemo(() => mainCard(items, running, inMain, agentName), [items, running, inMain, agentName])
}

/**
 * The cards for the chat on screen: in a project chat only that project's (the main chat's card is not one of them);
 * in the main chat and on every other page, everything across all projects.
 */
export function useScopedCards(): { cards: HelperCard[]; main: MainCard | null; current: string } {
  const all = usePanelCards()
  const main = useMainCard()
  const current = useCurrentChat()
  const projects = useEntity('project')
  const cards = useMemo(() => cardsForChat(all, projects, current), [all, projects, current])
  const inProject = current !== '' && current !== MAIN_CHAT
  return { cards, main: inProject ? null : main, current }
}

/** The side panel's card list (and the title bar's): a tap goes where lib/card-open.ts says. */
export function HelpersPanel(): JSX.Element | null {
  const mascot = useSettings((store) => store.settings?.mascot ?? 'scout')
  const { cards, main, current } = useScopedCards()
  const projects = useEntity('project')
  return <HelperCardList cards={cards} main={main} current={current} mascot={mascot} onOpen={openTarget} onClose={(card) => void dismissCard(card, projects)} />
}

/** The chat on screen, or '' when the window shows another page. */
export function useCurrentChat(): string {
  const onChat = useUi((state) => state.route.page === 'chat')
  const open = useChats((state) => state.open)
  return onChat ? open : ''
}

/**
 * One helper over the whole window: its brief, what it is doing now, every step and its result. The X (or Esc)
 * closes it and the side panel is back at the width it had.
 */
export function HelperStage(): JSX.Element | null {
  const id = usePanel((store) => store.helper)
  const close = usePanel((store) => store.closeHelper)
  const items = useEntity('chat_item')
  const projects = useEntity('project')

  useEffect(() => {
    if (id === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [id, close])

  if (id === null) return null
  return <HelperDetail id={id} items={items} projects={projects} onClose={close} />
}

/** The helper's view itself, drawn from the rows it is given (HelperStage gives it the live ones). */
export function HelperDetail({ id, items, projects, onClose: close }: { id: string; items: ChatItem[]; projects: ProjectRow[]; onClose: () => void }): JSX.Element {
  const { stopping, stop } = useStop()
  const row = items.find((item) => isHelper(item) && helperIdOf(item) === id)
  const helper = row === undefined ? null : helperView(row, items)
  // A helper working inside a project chat links to that chat; the chat is the project's own agent, not this job.
  const parentChat = row === undefined ? '' : helperParentChat(row, projects)
  const parentProject = parentChat === '' ? null : (projects.find((project) => project.chats.includes(parentChat)) ?? null)
  // Go to chat: the chat it works for (its project chat, else the chat that started it, the main chat for most).
  const homeChat = parentChat !== '' ? parentChat : row === undefined ? MAIN_CHAT : chatOf(row)

  if (helper === null) {
    return (
      <div className="hp-stage" role="dialog" aria-modal="true" aria-label="Helper">
        <div className="hp-stage-bar">
          <b>This helper is gone</b>
          <button type="button" className="hp-x" onClick={close} aria-label="Close">
            <Icon name="x" size={20} />
          </button>
        </div>
      </div>
    )
  }

  const s = stateLabel(helper)
  const current = [...helper.activity].reverse().find((step) => metaText(parseMeta(step.meta), 'status') === 'running')
  return (
    <div className="hp-stage" role="dialog" aria-modal="true" aria-label={`Helper ${helper.label}`}>
      <div className="hp-stage-bar">
        <HelperAvatar row={row} helper={helper} />
        <b>{helper.label}</b>
        {helper.model !== '' ? <span className="hp-model">{helper.model}</span> : null}
        <span className={`pill ${s.tone}`}>{s.label}</span>
        <span className="hp-stage-gap" />
        <button
          type="button"
          className="btn tonal sm hp-goto"
          data-chat={homeChat}
          title={parentChat !== '' ? `Open ${parentProject?.name ?? 'its project'} chat` : 'Open the chat that started it'}
          onClick={() => {
            close()
            openChat(homeChat)
          }}
        >
          Go to chat
        </button>
        {helper.state === 'working' ? (
          <button type="button" className="btn text sm" disabled={stopping === helper.id} onClick={() => stop(helper.id)}>
            {stopping === helper.id ? 'Stopping' : 'Stop'}
          </button>
        ) : null}
        <button type="button" className="hp-x" onClick={close} aria-label="Close and go back">
          <Icon name="x" size={20} />
        </button>
      </div>
      <div className="hp-stage-body">
        <div className="hp-stage-col">
          <section>
            <div className="eyebrow mute">THE JOB</div>
            <div className="hp-brief a-prose">
              <Markdown text={helper.brief} />
            </div>
            {helper.where !== '' ? <p className="small muted hp-where">{helper.state === 'working' ? 'Runs on' : 'Ran on'} <PlaceChip name={helper.where} /></p> : null}
            {parentChat !== '' ? (
              <button type="button" className="hp-parent" data-chat={parentChat} onClick={() => openChat(parentChat)}>
                {parentProject !== null ? <ProjectTile icon={parentProject.icon} size={22} /> : <Icon name="chat" size={18} />}
                <span className="hp-parent-t">
                  <b>Open the project chat</b>
                  <span>
                    {parentProject?.name ?? 'Project'} · {chatTitleOf(itemsOfChat(items, parentChat))}
                  </span>
                </span>
                <Icon name="chev" size={16} />
              </button>
            ) : null}
          </section>
          {current !== undefined ? (
            <div className="hp-now">
              <span className="eyebrow">NOW</span>
              <span>{stepText(current)}</span>
            </div>
          ) : null}
          <section>
            <div className="eyebrow mute">EVERY STEP, {helper.activity.length}</div>
            {helper.activity.length === 0 ? (
              <p className="small muted">No steps yet.</p>
            ) : (
              <ol className="hp-steps">
                {helper.activity.map((step) => {
                  const meta = parseMeta(step.meta)
                  const status = metaText(meta, 'status') || 'done'
                  // A step with a record (a command, a browser call, a file) opens to what it was given and what came back.
                  const run = runFromMeta(meta)
                  if (run !== null) {
                    return (
                      <li key={step.id} className="hp-step run">
                        <RunStep run={run} status={status} summary={stepText(step)} />
                      </li>
                    )
                  }
                  const icon: IconName = status === 'error' ? 'x' : status === 'running' ? 'globe' : 'check'
                  return (
                    <li key={step.id} className={`hp-step ${status}`}>
                      <i>
                        <Icon name={icon} size={14} />
                      </i>
                      <span>{stepText(step)}</span>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
          {helper.result !== '' && helper.state !== 'working' ? (
            <section className="hp-result">
              <div className="eyebrow mute">RESULT</div>
              <p>{helper.result}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
