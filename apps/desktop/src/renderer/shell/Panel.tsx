import type { BrowserState, BrowserViewMode } from '@agent/core'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { agent, chat } from '../bridge'
import { skyHopDemo } from '../bridge/seed'
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, boundsFor, displayUrl } from '../lib/panel'
import { parseMeta, metaStrings } from '../lib/meta'
import { useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/bits'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../ui/Icon'
import { HelperStage, HelpersPanel } from './HelpersPanel'

const VIEW_CHOICES: Array<{ mode: Exclude<BrowserViewMode, 'fit'>; label: string; icon: IconName }> = [
  { mode: 'desktop', label: 'Desktop', icon: 'monitor' },
  { mode: 'tablet', label: 'Tablet', icon: 'apps' },
  { mode: 'phone', label: 'Phone', icon: 'phone' },
]

/** Where the page sits inside a slot: laid out at its own size, scaled down to fit, centred. */
export function fittedRect(
  slot: { width: number; height: number },
  view: BrowserState['view'],
): { left: number; top: number; width: number; height: number } | null {
  if (view === undefined || view.mode === 'fit' || view.width <= 0 || view.height <= 0) return null
  if (slot.width <= 0 || slot.height <= 0) return null
  const scale = Math.min(1, slot.width / view.width, slot.height / view.height)
  const width = Math.max(1, Math.round(view.width * scale))
  const height = Math.max(1, Math.round(view.height * scale))
  return { left: Math.floor((slot.width - width) / 2), top: Math.floor((slot.height - height) / 2), width, height }
}

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
  const items = useEntity('chat_item')
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
            return (
              <span key={tab.id} className={`br-tab${tab.active ? ' on' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  className="br-tab-title"
                  title={tab.url === '' ? label : tab.url}
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

function PanelBody(): JSX.Element {
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
  const slot = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)

  const agentName = settings?.agentName.trim() || 'Your agent'
  const hasPage = state !== null && state.tabs.length > 0
  const expanded = state?.expanded === true
  // A helper open full size covers the window, so the native page steps out of the way until it closes.
  const helperOpen = usePanel((store) => store.helper !== null)
  const [slotSize, setSlotSize] = useState({ width: 0, height: 0 })
  const [live, setLive] = useState(true)
  const [still, setStill] = useState<string | null>(null)
  const used = [...memories]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .slice(0, 3)

  // The live page is a native view. Report the reserved rectangle, debounced while the layout settles.
  useEffect(() => {
    const element = slot.current
    if (!element) return
    // While the page is expanded, the full-window stage owns the native view.
    if (expanded) return
    if (helperOpen) {
      void agent.browser.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
      return
    }
    let timer = 0
    let frame = 0
    let sent = ''
    let shownLive = true
    // Keep a fresh still of the page, so it is ready the moment the live page has to step aside.
    const still = window.setInterval(() => {
      if (!hasPage || !shownLive) return
      void agent.browser
        .frame()
        .then((url) => {
          if (url !== null) setStill(url)
        })
        .catch(() => undefined)
    }, 1500)
    // The native page sits on top of everything, so it must never be anywhere its slot is not: it follows
    // the slot every frame, and steps out of sight whenever any part of the slot is scrolled or covered.
    const send = (): void => {
      const rect = element.getBoundingClientRect()
      const box = element.closest('.panel-w')?.getBoundingClientRect()
      // Live only while the whole card is in view; any part scrolled away and the still picture stands in.
      const inside =
        box === undefined ||
        (rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5 && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5)
      if (inside !== shownLive) {
        shownLive = inside
        setLive(inside)
      }
      const next = boundsFor(rect, hasPage && inside)
      const key = `${next.x},${next.y},${next.width},${next.height},${next.visible}`
      if (key === sent) return
      sent = key
      void agent.browser.setBounds(next)
    }
    const follow = (): void => {
      send()
      frame = window.requestAnimationFrame(follow)
    }
    const report = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const rect = element.getBoundingClientRect()
        setSlotSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
        send()
      }, 80)
    }
    report()
    frame = window.requestAnimationFrame(follow)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    observer?.observe(element)
    window.addEventListener('resize', report)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(still)
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', report)
      // Leaving Chat (or collapsing the panel) hides the native view.
      void agent.browser.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [hasPage, width, expanded, helperOpen])
  const frame = fittedRect(slotSize, state?.view)

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

  // A helper opened from the list fills this side panel (only the panel), until its X puts the panel back.
  if (helperOpen) {
    return (
      <aside className="panel-w panel-helper" aria-label="Helper">
        <HelperStage />
      </aside>
    )
  }

  return (
    <aside className="panel-w" aria-label="The agent's browser">
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

      <section className="panel-browser">
        <div className="panel-h">
          <div className="sec" style={{ margin: 0 }}>
            <span className="eyebrow">AGENT&apos;S BROWSER</span>
            <span className="sec-line">
              {state?.needsUser === true
                ? 'Waiting for you'
                : state?.agentActive === false
                  ? 'You have control'
                  : 'Live, in its own window'}
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
            <IconButton
              icon="chev"
              label="Collapse the browser panel"
              size={18}
              onClick={() => setCollapsed(true)}
            />
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <BrowserChrome state={state} agentName={agentName} />
        </div>

        <div className="br-view" ref={slot}>
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
                ) : !live && still !== null ? (
                  <img className="br-still" src={still} alt="" />
                ) : frame !== null ? (
                  <span
                    className="br-frame"
                    style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
                  />
                ) : (
                  <span className="br-frame fill" />
                )}
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
        </div>

        {state?.needsUser === true && state.handoffReason !== '' ? (
          <p className="br-reason">
            The page is yours. {state.handoffReason} Tap Done, carry on in the chat when you are finished.
          </p>
        ) : null}
      </section>

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

export function ChatPanel(): JSX.Element {
  const collapsed = usePanel((store) => store.collapsed)
  const setCollapsed = usePanel((store) => store.setCollapsed)

  if (collapsed) {
    return (
      <aside className="panel-w panel-mini" aria-label="The agent's browser panel is collapsed">
        <button
          type="button"
          className="panel-mini-open"
          aria-label="Open the agent's browser panel"
          title="Open the agent's browser panel"
          onClick={() => setCollapsed(false)}
        >
          <Icon name="panel" size={22} />
          <span className="panel-mini-chev">
            <Icon name="chev" size={13} />
          </span>
        </button>
      </aside>
    )
  }

  return <PanelBody />
}

/**
 * The page over the whole app window, for when the person helps out: a sign-in, a captcha, a fiddly
 * page. The same native view, just given a much bigger rectangle, so nothing reloads. While the person
 * has control the agent's own actions wait; Done, carry on hands the page back.
 */
export function BrowserStage(): JSX.Element | null {
  const state = useBrowserState()
  const settings = useSettings((store) => store.settings)
  const navigate = useUi((store) => store.navigate)
  const handBack = useHandBack()
  const slot = useRef<HTMLDivElement>(null)
  const [slotSize, setSlotSize] = useState({ width: 0, height: 0 })
  const expanded = state?.expanded === true && state.tabs.length > 0

  useEffect(() => {
    if (!expanded) return
    const element = slot.current
    if (!element) return
    let timer = 0
    const report = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const rect = element.getBoundingClientRect()
        setSlotSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
        void agent.browser.setBounds(boundsFor(rect, true))
      }, 40)
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    observer?.observe(element)
    window.addEventListener('resize', report)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void agent.browser.setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      observer?.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('keydown', onKey)
      // The chat panel reports its own rectangle again once it sees the page is back.
      void agent.browser.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [expanded])

  if (!expanded || state === null) return null
  const agentName = settings?.agentName.trim() || 'Your agent'
  const needsUser = state.needsUser
  const personDriving = state.agentActive === false
  const frame = fittedRect(slotSize, state.view)

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
      <div className="br-stage-view" ref={slot}>
        {agent.platform === 'web' ? (
          <div className="br-stage-mock">
            <MockPage agentName={agentName} />
          </div>
        ) : frame !== null ? (
          <span className="br-frame" style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }} />
        ) : (
          <span className="br-frame fill" />
        )}
      </div>
    </div>
  )
}
