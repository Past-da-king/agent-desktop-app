/**
 * One mini-app, open in the sheet (docs/plans/mini-apps.md). The app runs in <iframe sandbox="allow-scripts"> from
 * miniapp://<id>/ (no same-origin: no cookies, storage or reach into this window; no network by its own rules). Its
 * only door is a MessagePort this view holds: every message goes to main, which checks and runs it (host.ts), and
 * the answer comes back the same way. The view tells the frame the theme and accent at once when they change.
 *
 * A version is shown only after it passed its look check (light and dark at 1440 and 390); a failed check shows
 * what was found, with a way to hand it to his agent to fix.
 */
import type { MiniAppRow } from '@agent/core'
import { useEffect, useMemo, useRef, useState } from 'react'

import { agent } from '../bridge'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { isDarkNow } from '../state/theme'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { MiniAppTile } from '../ui/MiniAppIcon'
import { AskChange, DeleteApp } from './MiniApps'

/** Light or dark as the window shows it now, following the system when the setting is system. */
function useDark(): boolean {
  const theme = useSettings((state) => state.settings?.theme ?? 'system')
  const [dark, setDark] = useState(() => isDarkNow())
  useEffect(() => {
    setDark(isDarkNow())
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const change = (): void => setDark(isDarkNow())
    media.addEventListener?.('change', change)
    // applyTheme sets data-theme on <html>: follow it too.
    const watch = new MutationObserver(change)
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media.removeEventListener?.('change', change)
      watch.disconnect()
    }
  }, [theme])
  return dark
}

export function MiniAppView({ id }: { id: string }): JSX.Element {
  const apps = useEntity('miniapp')
  const app = apps.find((row) => row.id === id) ?? null
  const navigate = useUi((state) => state.navigate)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (app !== null) setGone(false)
  }, [app])
  if (app === null) {
    return (
      <div className="page">
        <div className="empty">
          <div className="h3">{gone ? 'This app was deleted' : 'No such app'}</div>
          <p>It is not on this computer (any more).</p>
          <Button variant="tonal" size="sm" onClick={() => navigate({ page: 'apps' })}>
            All apps
          </Button>
        </div>
      </div>
    )
  }
  return <AppScreen app={app} onGone={() => setGone(true)} />
}

function AppScreen({ app, onGone }: { app: MiniAppRow; onGone: () => void }): JSX.Element {
  const accent = useSettings((state) => state.settings?.accent ?? 'iris')
  const dark = useDark()
  const navigate = useUi((state) => state.navigate)
  const [anyway, setAnyway] = useState(false)
  const [checking, setChecking] = useState(false)
  const [asking, setAsking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const checked = app.check.version === app.version
  const show = (checked && app.check.ok) || anyway

  // A version not looked at yet is looked at now (it may have come from another device).
  useEffect(() => {
    if (checked) return
    let live = true
    setChecking(true)
    void agent.miniapps
      .check(app.id)
      .catch(() => null)
      .finally(() => {
        if (live) setChecking(false)
      })
    return () => {
      live = false
    }
  }, [app.id, app.version, checked])
  useEffect(() => setAnyway(false), [app.version])

  return (
    <div className="ma-screen">
      <div className="ma-bar">
        <button type="button" className="ib" aria-label="All apps" title="All apps" onClick={() => navigate({ page: 'apps' })}>
          <Icon name="arrow" size={18} />
        </button>
        <MiniAppTile icon={app.icon} size={32} />
        <div className="ma-bar-name">
          <b>{app.name}</b>
          <span className="small muted">{app.description}</span>
        </div>
        <div className="ma-bar-actions">
          <button
            type="button"
            className={`chip${app.pinned > 0 ? ' on' : ''}`}
            aria-pressed={app.pinned > 0}
            title={app.pinned > 0 ? 'Take it off the sidebar' : 'Pin it to the sidebar'}
            onClick={() => void (app.pinned > 0 ? agent.miniapps.unpin(app.id) : agent.miniapps.pin(app.id)).then(() => toast(app.pinned > 0 ? `${app.name} is off the sidebar.` : `${app.name} is on the sidebar.`))}
          >
            <Icon name="pin" size={16} />
            <span className="hide-narrow">{app.pinned > 0 ? 'Pinned' : 'Pin'}</span>
          </button>
          <button type="button" className="chip" title="Ask your agent to change it" onClick={() => setAsking(true)}>
            <Icon name="edit" size={16} />
            <span className="hide-narrow">Edit by asking</span>
          </button>
          <button type="button" className="ib" title="Delete" aria-label={`Delete ${app.name}`} onClick={() => setDeleting(true)}>
            <Icon name="trash" size={18} />
          </button>
        </div>
      </div>
      {show ? (
        <AppFrame key={`${app.id}:${app.version}`} app={app} dark={dark} accent={accent} onGone={onGone} />
      ) : (
        <div className="ma-wait">
          {!checked || checking ? (
            <>
              <span className="ma-spin" aria-hidden="true" />
              <div className="h3">Checking how it looks</div>
              <p className="muted">Light and dark, wide and phone width, before it is shown.</p>
            </>
          ) : (
            <>
              <div className="h3">It did not pass its look check</div>
              <ul className="ma-issues">
                {app.check.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <div className="row">
                <Button
                  size="sm"
                  onClick={() =>
                    void agent.miniapps.askChange(app.id, `Its look check found:\n${app.check.issues.map((i) => `- ${i}`).join('\n')}\nFix these.`).then(() => toast('Your agent is on it.'))
                  }
                >
                  Ask your agent to fix it
                </Button>
                <Button variant="text" size="sm" onClick={() => setAnyway(true)}>
                  Open anyway
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {asking ? <AskChange app={app} onClose={() => setAsking(false)} /> : null}
      {deleting ? <DeleteApp app={app} onClose={(done) => {
        setDeleting(false)
        if (done) navigate({ page: 'apps' })
      }} /> : null}
    </div>
  )
}

/** The sandboxed frame and its bridge: one session per frame, closed when it goes. */
function AppFrame({ app, dark, accent, onGone }: { app: MiniAppRow; dark: boolean; accent: string; onGone: () => void }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const port = useRef<MessagePort | null>(null)
  const sessionRef = useRef<string | null>(null)
  const [failed, setFailed] = useState(false)
  // The first paint is already right: the frame reads its theme from the address; later changes are posted.
  const src = useMemo(() => `miniapp://${app.id}/index.html?theme=${dark ? 'dark' : 'light'}&accent=${encodeURIComponent(accent)}`, [app.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const look = useRef({ dark, accent })
  look.current = { dark, accent }
  // What the frame says before its session is open waits here (the frame can load first).
  const waiting = useRef<unknown[]>([])
  const relay = (message: unknown): void => {
    const sid = sessionRef.current
    if (sid === null) {
      if (waiting.current.length < 100) waiting.current.push(message)
      return
    }
    void agent.miniapps.send(sid, message).then((reply) => {
      if (reply !== null && reply !== undefined) port.current?.postMessage(reply)
    })
  }
  const relayRef = useRef(relay)
  relayRef.current = relay
  const goneRef = useRef(onGone)
  goneRef.current = onGone

  useEffect(() => {
    let live = true
    const offPush = agent.miniapps.onPush((sessionId, message) => {
      if (sessionId !== sessionRef.current) return
      const m = message as { op?: string; topic?: string }
      if (m.op === 'event' && m.topic === 'app.deleted') goneRef.current()
      port.current?.postMessage(message)
    })
    void agent.miniapps.session(app.id).then((sid) => {
      if (!live) {
        if (sid !== null) void agent.miniapps.close(sid)
        return
      }
      if (sid === null) setFailed(true)
      sessionRef.current = sid
      const held = waiting.current
      waiting.current = []
      if (sid !== null) for (const message of held) relayRef.current(message)
    })
    return () => {
      live = false
      offPush()
      port.current?.close()
      port.current = null
      if (sessionRef.current !== null) void agent.miniapps.close(sessionRef.current)
      sessionRef.current = null
    }
  }, [app.id])

  useEffect(() => {
    port.current?.postMessage({ op: 'theme', dark, accent })
  }, [dark, accent])

  const connect = (): void => {
    const target = frame.current?.contentWindow
    if (target === null || target === undefined) return
    port.current?.close()
    const channel = new MessageChannel()
    port.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent) => relay(event.data)
    // The frame has an opaque origin (sandbox without allow-same-origin): '*' is the only target that reaches it,
    // and the port is the only thing handed over.
    target.postMessage({ type: 'agent:port' }, '*', [channel.port2])
    channel.port1.postMessage({ op: 'theme', dark: look.current.dark, accent: look.current.accent })
  }

  if (failed) {
    return (
      <div className="ma-wait">
        <div className="h3">This app cannot start</div>
        <p className="muted">Its bridge did not open. Try again in a moment.</p>
      </div>
    )
  }
  return (
    <iframe
      ref={frame}
      className="ma-frame"
      title={app.name}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow=""
      onLoad={connect}
    />
  )
}
