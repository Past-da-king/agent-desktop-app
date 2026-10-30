import type { BrowserState, BrowserViewMode } from '@agent/core'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

import { agent, chat } from '../bridge'
import { skyHopDemo } from '../bridge/seed'
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, browserTucked, displayUrl, openedMode } from '../lib/panel'
import { cardTarget, openTarget } from '../lib/card-open'
import { parseMeta, metaStrings } from '../lib/meta'
import { useCalmEntity, useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { useWaiting } from '../state/useWaiting'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/bits'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../ui/Icon'
import { BrowserHost } from './BrowserHost'
import { HelperAvatar, HelperStage, HelpersPanel, useWorkingHelpers } from './HelpersPanel'
import { helperHold } from '../../shared/helper-cards'
import { ReportStage } from './ReportStage'
import { NeedsYou } from './NeedsYou'
import { BrowserPeople, personOfTab, usePeople } from './BrowserPeople'
import { toneStyle } from '../lib/profiles'
import { setStageBox } from '../lib/browser-stage'

const VIEW_CHOICES: Array<{ mode: Exclude<BrowserViewMode, 'fit'>; label: string; icon: IconName }> = [
  { mode: 'desktop', label: 'Desktop', icon: 'monitor' },
  { mode: 'tablet', label: 'Tablet', icon: 'apps' },
  { mode: 'phone', label: 'Phone', icon: 'phone' },
]

/** The compact device switch: shows the mode and size the page is laid out at, and changes it. */
function ViewSwitch({ state, disabled }: { state: BrowserState | null; disabled: boolean }): JSX.Element {
  const view = state?.view
  const current = view?.mode ?? 'desktop'
  const size = view !== undefined && view.mode !== 'fit' ? `${view.width}x${view.height}` : 'Panel size'
  return (
    <div className="br-modes" role="group" aria-label={`Page shown as ${view?.label ?? 'Desktop'}`}>
      {VIEW_CHOICES.map((choice) => (
        <button
          key={choice.mode}
          type="button"
          className={`br-mode${current === choice.mode ? ' on' : ''}`}
          aria-pressed={current === choice.mode}
          aria-label={`Show as ${choice.label}`}
          title={`Show as ${choice.label}`}
          disabled={disabled}
          onClick={() => {
            void agent.browser.setView(choice.mode)
          }}
        >
          <Icon name={choice.icon} size={14} />
        </button>
      ))}
      <span className="br-mode-size" title={view?.label}>
        {size}
      </span>
    </div>
  )
}

/** Answers the open handoff card if there is one, so the agent's waiting browser_handoff returns. */
function useHandBack(): () => void {
  const items = useCalmEntity('chat_item')
  return () => {
    const pending = [...items]
      .reverse()
      .find((item) => {
        if (item.kind !== 'question') return false
        const meta = parseMeta(item.meta)
        const answered = typeof meta['answer'] === 'string' && meta['answer'] !== ''
        return !answered && metaStrings(meta, 'options').includes('Done, carry on')
      })
    if (pending !== undefined) {
      void chat.answer(pending.id, 'Done, carry on').catch(() => undefined)
    } else {
      void agent.browser.giveBack()
    }
    void agent.browser.setExpanded(false)
  }
}

/** The main process pushes a fresh BrowserState on every change it notices. */
function useBrowserState(): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(null)

  useEffect(() => {
    let alive = true
    void agent.browser
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch(() => undefined)
    const off = agent.browser.onState((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}

/** The mock bridge shows the designed SkyHop page; Electron paints the real page over this slot. */
function MockPage({ agentName }: { agentName: string }): JSX.Element {
  // On another device the agent's browser runs on the computer: say so instead of the preview's demo page.
  if (agent.remote !== undefined) {
    return (
      <div className="br-remote">
        <Icon name="monitor" size={22} />
        <span>
          {agentName} browses on {agent.remote.nodeName}. The page is there, and the cards here show what it found.
        </span>
      </div>
    )
  }
  return (
    <div className="web">
      <div className="web-h">
        <b>{skyHopDemo.brand}</b>
        <span style={{ color: '#55555e' }}>{skyHopDemo.action}</span>
      </div>
      <div className="rt">{skyHopDemo.route}</div>
      {skyHopDemo.flights.map((flight) => (
        <div key={flight.code} className={`fl${flight.selected ? ' sel' : ''}`}>
          <b>{flight.time}</b>
          <span>{flight.code}</span>
          {flight.selected ? <em className="nv">{agentName} is here</em> : null}
          <b>{flight.fare}</b>
        </div>
      ))}
    </div>
  )
}

function BrowserChrome({
  state,
  agentName,
  full = false,
  actions,
}: {
  state: BrowserState | null
  agentName: string
  /** In the full-size view: the expand button becomes a way back. */
  full?: boolean
  /** Extra controls at the end of the address row (the full-size view's status and buttons). */
  actions?: JSX.Element
}): JSX.Element {
  const tabs = state?.tabs ?? []
  const hasPage = tabs.length > 0
  const [address, setAddress] = useState<string | null>(null)
  const shownAddress = address ?? (hasPage ? (state?.url ?? '') : '')
  const active = state?.agentActive !== false
  const needsUser = state?.needsUser === true
  const muted = state?.muted === true
  const people = usePeople(state, 0)

  return (
    <div className="browser br-live-browser">
      <div className="br-top">
        <IconButton
          icon="arrow"
          label="Back"
          size={18}
          className="br-back"
          disabled={!hasPage}
          onClick={() => {
            void agent.browser.back()
          }}
        />
        <IconButton
          icon="sync"
          label="Reload"
          size={18}
          disabled={!hasPage}
          onClick={() => {
            void agent.browser.reload()
          }}
        />
        <IconButton
          icon={muted ? 'muted' : 'sound'}
          label={muted ? 'Turn the sound back on' : 'Mute the browser'}
          size={18}
          tonal={muted}
          className={`br-mute${!muted && state?.audible === true ? ' playing' : ''}`}
          aria-pressed={muted}
          onClick={() => {
            void agent.browser.setMuted(!muted)
          }}
        />
        <form
          className="url url-form"
          title={state?.url === undefined || state.url === '' ? undefined : state.url}
          onSubmit={(event) => {
            event.preventDefault()
            const typed = (address ?? '').trim()
            if (typed === '') return
            setAddress(null)
            ;(document.activeElement as HTMLElement | null)?.blur()
            void agent.browser.go(typed)
          }}
        >
          <Icon name="lock" size={14} />
          <input
            className="url-input"
            aria-label="Address, or words to search"
            spellCheck={false}
            value={address ?? (hasPage ? displayUrl(shownAddress) : '')}
            placeholder="Type an address or search"
            onFocus={(event) => {
              setAddress(hasPage ? (state?.url ?? '') : '')
              const input = event.currentTarget
              window.setTimeout(() => input.select(), 0)
            }}
            onBlur={() => setAddress(null)}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setAddress(null)
                event.currentTarget.blur()
              }
            }}
          />
        </form>
        <BrowserPeople state={state} compact={!full} />
        <IconButton
          icon="bolt"
          label="Fix this site (sign-in failing or page broken): forget what was learned for it and reload as this computer's own browser"
          size={18}
          className="br-expand"
          disabled={!hasPage}
          onClick={() => {
            void agent.browser.fixSite()
          }}
        />
        <IconButton
          icon="ext"
          label="Open in my browser"
          size={18}
          className="br-expand"
          disabled={!hasPage}
          onClick={() => {
            void agent.browser.openInSystem()
          }}
        />
        {full ? (
          <IconButton
            icon="code"
            label="Developer tools"
            size={18}
            disabled={!hasPage}
            onClick={() => {
              void agent.browser.devtools()
            }}
          />
        ) : null}
        {full ? null : (
          <IconButton
            icon="max"
            label="Expand the page to the whole window"
            size={18}
            disabled={!hasPage}
            onClick={() => {
              void agent.browser.setExpanded(true)
            }}
          />
        )}
        {actions}
      </div>

      {tabs.length > 0 ? (
        <div className="br-tabs" role="tablist" aria-label="Browser tabs">
          {tabs.map((tab) => {
            const label = tab.title.trim() || displayUrl(tab.url) || 'Untitled'
            const person = personOfTab(people, tab.partition)
            return (
              <span key={tab.id} className={`br-tab${tab.active ? ' on' : ''}`}>
                {person !== undefined ? (
                  <span className="pf br-tab-who" style={toneStyle(person.color) as CSSProperties} title={`${person.name}'s sign-ins`} aria-label={`${person.name}'s sign-ins`} />
                ) : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  className="br-tab-title"
                  title={`${tab.url === '' ? label : tab.url}${tab.ownerLabel !== undefined ? `\nOpened by ${tab.ownerLabel}` : ''}`}
                  data-owner={tab.owner ?? ''}
                  onClick={() => {
                    void agent.browser.selectTab(tab.id)
                  }}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="br-tab-close"
                  aria-label={`Close ${label}`}
                  title="Close tab"
                  onClick={() => {
                    void agent.browser.closeTab(tab.id)
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )
          })}
          <button
            type="button"
            className="br-tab-new"
            aria-label="New tab"
            title="New tab"
            onClick={() => {
              void agent.browser.newTab()
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
      ) : null}

      <div className="br-status">
        {hasPage ? (
          <span className={`br-here${needsUser ? ' needs' : ''}`}>
            {needsUser ? <Icon name="person" size={13} /> : <span className="br-dot" aria-hidden="true" />}
            {needsUser ? `${agentName} needs you` : `${agentName} is here`}
          </span>
        ) : (
          <span className="br-status-mute">No page open</span>
        )}
        <span className="br-status-gap" />
        <ViewSwitch state={state} disabled={!hasPage} />
      </div>
    </div>
  )
}

/**
 * The browser folded to one line: nothing is open, or the person folded it for room. The pages keep running
 * behind the window; the line shows what the agent is on, and opening it brings the card back.
 */
function BrowserLine({
  state,
  agentName,
  onOpen,
}: {
  state: BrowserState | null
  agentName: string
  onOpen: () => void
}): JSX.Element {
  const tabs = state?.tabs ?? []
  const shown = tabs.find((tab) => tab.active) ?? tabs[0]
  const needsUser = state?.needsUser === true
  const page = shown === undefined ? '' : shown.title.trim() || displayUrl(shown.url) || 'A page'
  const line = needsUser ? `${agentName} needs you on ${page}` : shown === undefined ? 'Nothing open' : tabs.length > 1 ? `${page} and ${tabs.length - 1} more` : page
  return (
    <section className={`br-line${shown !== undefined ? ' live' : ''}${needsUser ? ' needs' : ''}`} aria-label="The agent's browser, folded">
      <button type="button" className="br-line-open" onClick={onOpen} aria-label="Open the agent's browser" title={shown?.url || undefined}>
        <span className="br-line-ic" aria-hidden="true">
          <Icon name="globe" size={16} />
          {shown !== undefined ? <span className="br-line-dot" /> : null}
        </span>
        <span className="br-line-t">
          <b>Agent&apos;s browser</b>
          <span>{line}</span>
        </span>
        <Icon name="chevd" size={16} />
      </button>
    </section>
  )
}

/** True while the window is narrow enough that the shell hides the side panel (responsive.css). */
export function useNarrow(): boolean {
  const query = '(max-width:1180px)'
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const change = (): void => setNarrow(list.matches)
    change()
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  return narrow
}

/**
 * The browser card and the rest of the side panel. It stays mounted for as long as the main window does, because
 * the agent's pages live in it (BrowserHost) and a page ends if its <webview> is ever unmounted or moved. When
 * the panel is not on screen (another page, collapsed, a helper open, a narrow window) it is parked: laid out
 * the same, invisible and out of reach, while the pages carry on backstage.
 */
function PanelBody({ parked = false }: { parked?: boolean }): JSX.Element {
  const settings = useSettings((store) => store.settings)
  const width = usePanel((store) => store.width)
  const setWidth = usePanel((store) => store.setWidth)
  const commit = usePanel((store) => store.commit)
  const setCollapsed = usePanel((store) => store.setCollapsed)
  const resetWidth = usePanel((store) => store.resetWidth)
  const navigate = useUi((store) => store.navigate)
  const selectMemory = useUi((store) => store.selectMemory)
  const focusComposer = useUi((store) => store.focusComposer)
  const memories = useEntity('memory')
  const state = useBrowserState()
  const browserMode = usePanel((store) => store.browserMode)
  const setBrowserMode = usePanel((store) => store.setBrowserMode)
  const drag = useRef<{ x: number; width: number } | null>(null)

  const agentName = settings?.agentName.trim() || 'Your agent'
  const hasPage = state !== null && state.tabs.length > 0
  const expanded = state?.expanded === true
  // Folded to one line: the card's page area stays laid out behind the window, so every page keeps working.
  const tucked = browserTucked(browserMode, hasPage)
  const shownTab = state?.tabs.find((tab) => tab.active) ?? state?.tabs[0]
  // A tab no window could host (it opened while the app was still setting up) is shown as a still picture.
  const offscreen = hasPage && shownTab !== undefined && shownTab.embed !== true
  const [still, setStill] = useState<string | null>(null)
  const used = [...memories]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .slice(0, 3)

  // Only an offscreen tab needs pictures; an embedded page is the real thing, drawn in the card.
  useEffect(() => {
    if (!offscreen || parked || expanded) return
    const grab = (): void => {
      void agent.browser
        .frame()
        .then((url) => {
          if (url !== null) setStill(url)
        })
        .catch(() => undefined)
    }
    grab()
    const timer = window.setInterval(grab, 1500)
    return () => window.clearInterval(timer)
  }, [offscreen, parked, expanded])


  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    drag.current = null
    commit()
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // The pointer may already be released.
    }
  }

  return (
    // Parked, the panel is visibility:hidden (so nothing in it takes focus or is read out) except the live page,
    // which may still be shown full size over the window. `inert` would block that page too, so it is not used.
    <aside className={`panel-w${parked ? ' panel-parked' : ''}`} aria-label="The agent's browser">
      <div
        className="panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the browser panel"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, width }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start === null) return
          setWidth(start.width + (start.x - event.clientX))
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetWidth}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setWidth(width + 16)
            commit()
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            setWidth(width - 16)
            commit()
          } else if (event.key === 'Home') {
            event.preventDefault()
            setWidth(PANEL_MIN_WIDTH)
            commit()
          } else if (event.key === 'End') {
            event.preventDefault()
            setWidth(PANEL_MAX_WIDTH)
            commit()
          }
        }}
      />

      {tucked ? (
        <BrowserLine
          state={state}
          agentName={agentName}
          onOpen={() => setBrowserMode(openedMode(hasPage))}
        />
      ) : null}

      <section className={`panel-browser${tucked ? ' tucked' : ''}`} aria-hidden={tucked ? true : undefined}>
        <div className="panel-h">
          <div className="sec" style={{ margin: 0 }}>
            <span className="eyebrow">AGENT&apos;S BROWSER</span>
            <span className="sec-line">
              {state?.needsUser === true
                ? 'Waiting for you'
                : state?.agentActive === false
                  ? 'You have control'
                  : 'Live, right here in the card'}
            </span>
          </div>
          <div className="panel-h-actions">
            {hasPage ? (
              state?.agentActive === false ? (
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    void agent.browser.giveBack()
                  }}
                >
                  Give back
                </Button>
              ) : (
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    void agent.browser.takeOver()
                  }}
                >
                  Take over
                </Button>
              )
            ) : null}
            <IconButton icon="min" label="Fold the browser to one line" size={18} onClick={() => setBrowserMode('min')} />
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <BrowserChrome state={state} agentName={agentName} />
        </div>

        <div className="br-view">
          {hasPage ? (
            agent.platform === 'web' ? (
              <MockPage agentName={agentName} />
            ) : (
              <div className="br-live" aria-hidden="true">
                {expanded ? (
                  <span className="br-live-away">
                    <Icon name="max" size={18} />
                    Open full size
                  </span>
                ) : offscreen && still !== null ? (
                  <img className="br-still" src={still} alt="" />
                ) : null}
              </div>
            )
          ) : (
            <div className="br-empty">
              <span className="br-empty-icon" aria-hidden="true">
                <Icon name="globe" size={24} />
              </span>
              <b>The agent&apos;s browser opens here when it needs one</b>
              <p>Ask for something on the web and the page appears beside this chat.</p>
              <Button
                variant="tonal"
                size="sm"
                onClick={() => {
                  navigate({ page: 'chat' })
                  focusComposer()
                }}
              >
                Ask {agentName}
              </Button>
            </div>
          )}
          {agent.platform === 'web' ? null : <BrowserHost state={state} parked={parked || tucked} />}
        </div>

        {state?.needsUser === true && state.handoffReason !== '' ? (
          <p className="br-reason">
            The page is yours. {state.handoffReason} Tap Done, carry on in the chat when you are finished.
          </p>
        ) : null}
      </section>

      {/* The browser always sits at the top; what needs the person comes straight under it, then helpers. */}
      <NeedsYou />

      <HelpersPanel />

      <section>
        <div className="sec">
          <span className="eyebrow">USED FROM MEMORY</span>
          <span className="sec-line">What I remembered for this</span>
        </div>
        {used.length === 0 ? (
          <div className="panel-empty">
            <Icon name="memory" size={18} />
            <span>Pages {agentName} uses in a chat will show here.</span>
          </div>
        ) : (
          <div className="mem-chips">
            {used.map((memory) => (
              <Chip
                key={memory.id}
                icon={<Icon name={memory.pinned ? 'heart' : 'memory'} size={16} />}
                onClick={() => {
                  selectMemory(memory.id)
                  navigate({ page: 'memory' })
                }}
              >
                {memory.title}
              </Chip>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}

/**
 * What the collapsed side panel still shows: what waits on the person, the faces of the side panel's cards (project
 * chats working or waiting on him, helpers working; a tap opens it), and the agent's browser when a page is open.
 */
function MiniStrip({ onOpen }: { onOpen: () => void }): JSX.Element {
  // One face per card group: a project chat (working or waiting on him) or a helper on its own.
  const helpers = useWorkingHelpers().filter((card) => card.depth === 0)
  const waiting = useWaiting()
  const state = useBrowserState()
  const page = state?.tabs.find((tab) => tab.active) ?? state?.tabs[0]
  return (
    <div className="mini-strip">
      {waiting.length > 0 ? (
        <button type="button" className="mini-needs" title={`${waiting.length} waiting for you`} aria-label={`${waiting.length} waiting for you, open the side panel`} onClick={onOpen}>
          {waiting.length}
        </button>
      ) : null}
      {helpers.slice(0, 6).map((helper) => (
        <button
          key={helper.id}
          type="button"
          className="mini-helper"
          title={`${helper.label}: ${helper.line}`}
          data-card={helper.id}
          aria-label={`Open ${helper.label}, ${helper.waiting ? 'your turn' : (helperHold(helper)?.kind ?? (helper.state === 'working' ? 'working' : 'done'))}`}
          onClick={() => {
            // A project chat's face opens that chat in full; a helper's opens its own view in the side panel.
            const target = cardTarget(helper)
            if (target.kind === 'helper') onOpen()
            openTarget(target)
          }}
        >
          <HelperAvatar row={helper.row} helper={helper} size={30} />
          <i className={`mini-dot${helper.state === 'working' ? '' : ' done'}`} aria-hidden="true" />
        </button>
      ))}
      {helpers.length > 6 ? <span className="small muted">+{helpers.length - 6}</span> : null}
      {page !== undefined ? (
        <button type="button" className="mini-helper" title={page.title.trim() || displayUrl(page.url) || "The agent's browser"} aria-label="Open the side panel to the agent's browser" onClick={onOpen}>
          <span className="mini-globe">
            <Icon name="globe" size={16} />
          </span>
          {state?.needsUser === true ? <i className="mini-dot needs" aria-hidden="true" /> : null}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The side panel. `parked` (the shell is showing another page) keeps the browser card mounted but out of
 * sight, so the agent's pages survive moving around the app. The collapsed strip and an open helper take the
 * panel's place on screen while the card stays parked behind them.
 */
export function ChatPanel({ parked = false }: { parked?: boolean }): JSX.Element {
  const collapsed = usePanel((store) => store.collapsed)
  const setCollapsed = usePanel((store) => store.setCollapsed)
  // A helper opened from the list fills this side panel (only the panel), until its X puts the panel back.
  const helperOpen = usePanel((store) => store.helper !== null)
  // A report opened from the chat takes the panel's place too, even when the panel was collapsed.
  const reportOpen = usePanel((store) => store.report !== null)
  const narrow = useNarrow()

  return (
    <>
      {!parked && reportOpen ? (
        <aside className="panel-w panel-helper" aria-label="Report">
          <ReportStage />
        </aside>
      ) : null}
      {!parked && !reportOpen && collapsed ? (
        <aside className="panel-w panel-mini" aria-label="The side panel is collapsed">
          <button
            type="button"
            className="panel-mini-open"
            aria-label="Open the side panel"
            title="Open the side panel"
            onClick={() => setCollapsed(false)}
          >
            <Icon name="panel" size={22} />
            <span className="panel-mini-chev">
              <Icon name="chev" size={13} />
            </span>
          </button>
          <MiniStrip onOpen={() => setCollapsed(false)} />
        </aside>
      ) : null}
      {!parked && !reportOpen && !collapsed && helperOpen && !narrow ? (
        <aside className="panel-w panel-helper" aria-label="Helper">
          <HelperStage />
        </aside>
      ) : null}
      <PanelBody parked={parked || collapsed || helperOpen || reportOpen || narrow} />
    </>
  )
}

/**
 * Whether the side panel is on screen, open, holding its cards: a chat or project page, the window wide enough and
 * the panel not collapsed. Elsewhere the title bar lists the cards (WorkMenu) and a helper's view opens over the window.
 */
export function usePanelShown(): boolean {
  const page = useUi((store) => store.route.page)
  const collapsed = usePanel((store) => store.collapsed)
  const narrow = useNarrow()
  return (page === 'chat' || page === 'project') && !collapsed && !narrow
}

/**
 * A helper's own view when the side panel cannot hold it (Settings, any page without the panel, a narrow window, the
 * panel collapsed): the same view, over the window. Its X, Esc or a tap outside closes it.
 */
export function HelperFloat(): JSX.Element | null {
  const helper = usePanel((store) => store.helper)
  const report = usePanel((store) => store.report)
  const close = usePanel((store) => store.closeHelper)
  const shown = usePanelShown()
  if (helper === null || report !== null || shown) return null
  return (
    <div
      className="hp-float"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <aside className="hp-float-card" aria-label="Helper">
        <HelperStage />
      </aside>
    </div>
  )
}

/**
 * The page over the whole app window, for when the person helps out: a sign-in, a captcha, a fiddly
 * page. This draws the chrome and an empty page area; the card's own BrowserHost lays the same live page
 * over that area (nothing reloads, and the page is only ever in one place). While the person has control the
 * agent's own actions wait; Done, carry on hands the page back.
 */
export function BrowserStage(): JSX.Element | null {
  const state = useBrowserState()
  const settings = useSettings((store) => store.settings)
  const navigate = useUi((store) => store.navigate)
  const handBack = useHandBack()
  const expanded = state?.expanded === true && state.tabs.length > 0

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void agent.browser.setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // A page no <webview> could host (it opened while the window was busy) is shown as a still, as the card does.
  const shownTab = state?.tabs.find((tab) => tab.active) ?? state?.tabs[0]
  const offscreen = expanded && shownTab !== undefined && shownTab.embed !== true
  const [still, setStill] = useState<string | null>(null)
  useEffect(() => {
    if (!offscreen) {
      setStill(null)
      return
    }
    const grab = (): void => {
      void agent.browser
        .frame()
        .then((url) => {
          if (url !== null) setStill(url)
        })
        .catch(() => undefined)
    }
    grab()
    const timer = window.setInterval(grab, 1000)
    return () => window.clearInterval(timer)
  }, [offscreen])

  if (!expanded || state === null) return null
  const agentName = settings?.agentName.trim() || 'Your agent'
  const needsUser = state.needsUser
  const personDriving = state.agentActive === false

  return (
    <div className="br-stage" role="dialog" aria-modal="true" aria-label="The agent's browser, full size">
      <div className="br-stage-chrome">
        <BrowserChrome
          state={state}
          agentName={agentName}
          full
          actions={
            <div className="br-stage-actions">
              <span className={`br-here${needsUser ? ' needs' : ''}`}>
                {needsUser ? <Icon name="person" size={13} /> : <span className="br-dot" aria-hidden="true" />}
                {needsUser ? `${agentName} needs you` : personDriving ? 'You have control' : `${agentName} is here`}
              </span>
              <ViewSwitch state={state} disabled={false} />
              {personDriving ? (
                <Button size="sm" onClick={handBack}>
                  <Icon name="check" size={16} />
                  Done, carry on
                </Button>
              ) : (
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    void agent.browser.takeOver()
                  }}
                >
                  Take over
                </Button>
              )}
              <Button
                variant="text"
                size="sm"
                onClick={() => {
                  void agent.browser.setExpanded(false)
                  navigate({ page: 'chat' })
                }}
              >
                Back to chat
                <span className="br-stage-kbd">Esc</span>
              </Button>
            </div>
          }
        />
        {needsUser && state.handoffReason !== '' ? <p className="br-stage-reason">{state.handoffReason}</p> : null}
      </div>
      {/* Registered in the commit itself (a ref callback), so the live page lands here in the same frame. */}
      <div className="br-stage-view" ref={setStageBox}>
        {agent.platform === 'web' ? (
          <div className="br-stage-mock">
            <MockPage agentName={agentName} />
          </div>
        ) : offscreen && still !== null ? (
          <img className="br-stage-still" src={still} alt="" />
        ) : null}
      </div>
    </div>
  )
}
