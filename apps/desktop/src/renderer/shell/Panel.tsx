import type { BrowserState } from '@agent/core'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { agent } from '../bridge'
import { skyHopDemo } from '../bridge/seed'
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, boundsFor, displayUrl } from '../lib/panel'
import { useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/bits'
import { Chip } from '../ui/Chip'
import { Icon } from '../ui/Icon'

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
}: {
  state: BrowserState | null
  agentName: string
}): JSX.Element {
  const tabs = state?.tabs ?? []
  const hasPage = tabs.length > 0
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
        <span className="url" title={state?.url === undefined || state.url === '' ? undefined : state.url}>
          <Icon name="lock" size={14} />
          <span className="url-text">{hasPage ? displayUrl(state?.url ?? '') : 'Not open yet'}</span>
        </span>
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
        <button
          type="button"
          className="btn text sm br-open"
          disabled={!hasPage}
          onClick={() => {
            void agent.browser.openInSystem()
          }}
        >
          <Icon name="ext" size={14} />
          Open in my browser
        </button>
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
  const used = [...memories]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .slice(0, 3)

  // The live page is a native view. Report the reserved rectangle, debounced while the layout settles.
  useEffect(() => {
    const element = slot.current
    if (!element) return
    let timer = 0
    const report = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void agent.browser.setBounds(boundsFor(element.getBoundingClientRect(), hasPage))
      }, 80)
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    observer?.observe(element)
    window.addEventListener('resize', report)
    return () => {
      window.clearTimeout(timer)
      observer?.disconnect()
      window.removeEventListener('resize', report)
      // Leaving Chat (or collapsing the panel) hides the native view.
      void agent.browser.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [hasPage, width])

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

      <section>
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
              <div className="br-live" aria-hidden="true" />
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
