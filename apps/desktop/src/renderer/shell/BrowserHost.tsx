import type { BrowserPageSpec, BrowserState, BrowserTab } from '@agent/core'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { placePage, type PageSpec } from '../../shared/page-place'
import { agent } from '../bridge'
import { onStageBox, stageBox } from '../lib/browser-stage'

/**
 * Where the live pages are: inside the browser card (they scroll and clip with it), over the full-size view's
 * page area, or "backstage" (behind the app, still on screen so the page keeps painting for the agent's
 * screenshots, but covered by the window).
 */
export type HostPlace = 'card' | 'full' | 'backstage'

/** A box the size of nothing still gets a page laid out at a sensible size. */
const FALLBACK_BOX = { width: 380, height: 420 }

interface PageNode {
  wrap: HTMLDivElement
  view: Electron.WebviewTag
}

function specOf(tab: BrowserTab, state: BrowserState): PageSpec {
  const own: BrowserPageSpec | undefined = tab.view
  if (own !== undefined) return own
  const view = state.view
  return view === undefined ? { mode: 'desktop', width: 1440, height: 900 } : { mode: view.mode, width: view.width, height: view.height }
}

/**
 * The agent's pages, one <webview> per tab, made once and never moved in the DOM (moving a <webview> ends its
 * page). This component lives in the panel card and is mounted for as long as the main window is: when the
 * card is not on screen the panel is parked, not unmounted. Everything that follows the card (size, scale,
 * place) is set straight on the elements in the frame the layout changes, so the page never trails the card.
 */
export function BrowserHost({ state, parked }: { state: BrowserState | null; parked: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const pages = useRef(new Map<string, PageNode>())
  const shade = useRef<HTMLDivElement | null>(null)
  const curtain = useRef<HTMLDivElement | null>(null)
  /** Over a page an agent is driving: a click hands it to the person; the wheel still scrolls the panel. */
  const catcher = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ state, parked, inView: true, sent: '' })
  latest.current.state = state
  latest.current.parked = parked

  // Lays everything out from the current state and the boxes' sizes. Called from layout effects, resize
  // observers and the intersection observer, so it always runs before the frame paints.
  const apply = useRef<() => void>(() => undefined)
  apply.current = (): void => {
    const host = hostRef.current
    const slot = host?.parentElement
    if (host === null || slot === null || slot === undefined) return
    const { state: now, parked: isParked, inView } = latest.current
    const stage = stageBox()
    const place: HostPlace = now?.expanded === true && stage !== null ? 'full' : !isParked && inView ? 'card' : 'backstage'

    let box = { width: slot.clientWidth, height: slot.clientHeight }
    const style = host.style
    if (place === 'full' && stage !== null) {
      const rect = stage.getBoundingClientRect()
      box = { width: Math.round(rect.width), height: Math.round(rect.height) }
      style.left = `${Math.round(rect.left)}px`
      style.top = `${Math.round(rect.top)}px`
      style.width = `${box.width}px`
      style.height = `${box.height}px`
    } else if (place === 'backstage') {
      if (box.width <= 0 || box.height <= 0) box = { ...FALLBACK_BOX }
      // On screen (a page off screen stops painting) but behind the window's own opaque background.
      const win = host.closest('.win')?.getBoundingClientRect()
      const area = win ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      style.left = `${Math.round(area.left + Math.max(0, (area.width - box.width) / 2))}px`
      style.top = `${Math.round(area.top + Math.max(0, (area.height - box.height) / 2))}px`
      style.width = `${box.width}px`
      style.height = `${box.height}px`
    } else {
      style.left = ''
      style.top = ''
      style.width = ''
      style.height = ''
    }
    host.className = `br-host ${place}${now !== null && now.tabs.some((tab) => tab.embed === true) ? ' has-pages' : ''}`

    const shown = now?.tabs.find((tab) => tab.active) ?? now?.tabs[0]
    // The person can use the page only when it is theirs and in sight; otherwise the wheel scrolls the panel.
    const theirs = now !== null && now.agentActive === false && place !== 'backstage'
    host.classList.toggle('live', theirs)
    // A page in sight that an agent is driving: clicking it takes it over, as the Take over button does.
    if (catcher.current !== null) catcher.current.hidden = theirs || place === 'backstage' || shown === undefined || shown.embed !== true

    let shadeAt: { left: number; top: number; width: number; height: number } | null = null
    for (const tab of now?.tabs ?? []) {
      const node = pages.current.get(tab.id)
      if (node === undefined || now === null) continue
      const at = placePage(box, specOf(tab, now))
      const front = tab.id === shown?.id
      node.wrap.classList.toggle('on', front)
      if (at === null) continue
      node.wrap.style.width = `${at.width}px`
      node.wrap.style.height = `${at.height}px`
      node.wrap.style.transform = `translate(${at.left}px, ${at.top}px) scale(${at.scale})`
      if (front) {
        const width = Math.round(at.width * at.scale)
        const height = Math.round(at.height * at.scale)
        // A page smaller than its box sits on a soft card, like the panel's still frame did.
        shadeAt = width < box.width - 1 || height < box.height - 1 ? { left: at.left, top: at.top, width, height } : null
      }
    }
    if (shade.current !== null) {
      shade.current.hidden = shadeAt === null
      if (shadeAt !== null) {
        shade.current.style.transform = `translate(${shadeAt.left}px, ${shadeAt.top}px)`
        shade.current.style.width = `${shadeAt.width}px`
        shade.current.style.height = `${shadeAt.height}px`
      }
    }

    // The main process only needs the box's size (for the page's shape and the scale it reports).
    const rect = place === 'card' ? slot.getBoundingClientRect() : host.getBoundingClientRect()
    const bounds = { x: Math.round(rect.left), y: Math.round(rect.top), width: box.width, height: box.height, visible: place !== 'backstage' }
    const key = `${bounds.width}x${bounds.height}:${bounds.visible}`
    if (key !== latest.current.sent) {
      latest.current.sent = key
      void agent.browser.setBounds(bounds).catch(() => undefined)
    }
  }

  // One <webview> per tab the main process asked the card to host, made once; dropped when the tab goes.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    if (curtain.current === null) {
      const node = document.createElement('div')
      node.className = 'br-curtain'
      host.appendChild(node)
      curtain.current = node
    }
    if (shade.current === null) {
      const node = document.createElement('div')
      node.className = 'br-shade'
      node.hidden = true
      host.appendChild(node)
      shade.current = node
    }
    if (catcher.current === null) {
      const node = document.createElement('div')
      node.className = 'br-catch'
      node.hidden = true
      node.title = 'Click to take over this page'
      node.addEventListener('click', () => {
        void agent.browser.takeOver()
      })
      host.appendChild(node)
      catcher.current = node
    }
    const wanted = new Map<string, BrowserTab>()
    for (const tab of state?.tabs ?? []) {
      if (tab.embed === true && typeof tab.partition === 'string' && tab.partition !== '') wanted.set(tab.id, tab)
    }
    for (const [id, node] of pages.current) {
      if (wanted.has(id)) continue
      // Removing the element ends the page; the main process has already let the tab go.
      node.wrap.remove()
      pages.current.delete(id)
    }
    for (const [id, tab] of wanted) {
      if (pages.current.has(id)) continue
      const wrap = document.createElement('div')
      wrap.className = 'br-page'
      wrap.dataset['tab'] = id
      const view = document.createElement('webview')
      // Set before the element is connected: the partition can never change once the guest exists.
      view.setAttribute('partition', tab.partition ?? '')
      view.setAttribute('src', 'about:blank')
      // New windows go to the main process's handler, which opens them as checked tabs (embed.ts guardWebview).
      view.setAttribute('allowpopups', '')
      // Reached by clicking the page when it is the person's, never by tabbing through the app.
      view.tabIndex = -1
      // The guest's id can be read once its first (blank) document is ready; hand it over once.
      let handed = false
      const handOver = (): void => {
        if (handed) return
        let guestId = 0
        try {
          guestId = view.getWebContentsId()
        } catch {
          return
        }
        handed = true
        void agent.browser.attach(id, guestId).catch(() => false)
      }
      view.addEventListener('did-attach', handOver)
      view.addEventListener('dom-ready', handOver)
      wrap.appendChild(view)
      host.appendChild(wrap)
      pages.current.set(id, { wrap, view })
    }
    apply.current()
  }, [state, parked])

  // The boxes the page follows: the card's slot, the full-size area, and the window (for backstage).
  useEffect(() => {
    const host = hostRef.current
    const slot = host?.parentElement
    if (host === null || slot === null || slot === undefined) return
    const run = (): void => apply.current()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run)
    resize?.observe(slot)
    let stage = stageBox()
    if (stage !== null) resize?.observe(stage)
    const offStage = onStageBox(() => {
      if (stage !== null) resize?.unobserve(stage)
      stage = stageBox()
      if (stage !== null) resize?.observe(stage)
      run()
    })
    // A card scrolled right out of the panel steps backstage, so its page keeps painting for the agent.
    const scroller = slot.closest('.panel-w')
    const seen =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              const entry = entries[entries.length - 1]
              if (entry === undefined) return
              latest.current.inView = entry.isIntersecting
              run()
            },
            { root: scroller, rootMargin: '160px 0px', threshold: 0 },
          )
    seen?.observe(slot)
    window.addEventListener('resize', run)
    return () => {
      resize?.disconnect()
      seen?.disconnect()
      offStage()
      window.removeEventListener('resize', run)
    }
  }, [])

  return <div ref={hostRef} className="br-host card" aria-hidden={state?.agentActive !== false ? true : undefined} />
}
