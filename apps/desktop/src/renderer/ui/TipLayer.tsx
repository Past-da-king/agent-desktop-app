import { useEffect, useRef, useState } from 'react'

/**
 * The app's own hover labels. Every element's `title` would otherwise show Windows' plain black box; this layer
 * reads the same `title`s, holds the text aside while the element is hovered or focused (so the native box never
 * appears) and draws a label in the app's style instead, then puts the title back. Nothing in the app needs to
 * change to get it: any element with a title does. A label that only repeats text already fully on screen is not
 * shown; it appears when that text is cut off.
 */
const DELAY_MS = 450
/** Moving straight from one label to the next shows it at once, as menus do. */
const WARM_MS = 300
const GAP = 8
const EDGE = 8

interface Tip {
  text: string
  x: number
  y: number
  above: boolean
}

/** True when an element (or a text element inside it) is cut off, e.g. ellipsis on a long project name. */
export function isClipped(el: Element): boolean {
  const all = [el, ...Array.from(el.querySelectorAll('*'))]
  return all.some((node) => node instanceof HTMLElement && node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1)
}

/** Whether a title is worth showing: always, unless it only repeats the element's own visible, uncut words. */
export function worthShowing(el: Element, text: string): boolean {
  const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (own === '' || own !== text.replace(/\s+/g, ' ').trim()) return true
  return isClipped(el)
}

export function TipLayer(): JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const current = useRef<{ el: HTMLElement; title: string } | null>(null)
  const timer = useRef<number | null>(null)
  const lastHidden = useRef(0)

  useEffect(() => {
    const restore = (): void => {
      const held = current.current
      if (held !== null && held.el.isConnected && !held.el.hasAttribute('title')) held.el.setAttribute('title', held.title)
      current.current = null
    }
    const hide = (): void => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      if (current.current !== null) lastHidden.current = Date.now()
      restore()
      setTip(null)
    }
    const show = (el: HTMLElement, text: string): void => {
      const rect = el.getBoundingClientRect()
      const below = rect.bottom + GAP + 40 < window.innerHeight
      setTip({ text, x: rect.left + rect.width / 2, y: below ? rect.bottom + GAP : rect.top - GAP, above: !below })
    }
    const enter = (target: EventTarget | null): void => {
      const el = target instanceof Element ? target.closest<HTMLElement>('[title]') : null
      if (el === null || el === current.current?.el) return
      hide()
      const text = (el.getAttribute('title') ?? '').trim()
      if (text === '') return
      // Held aside so Windows does not draw its own box over ours; put back when the pointer or focus leaves.
      el.removeAttribute('title')
      current.current = { el, title: text }
      if (!worthShowing(el, text)) return
      const warm = Date.now() - lastHidden.current < WARM_MS
      timer.current = window.setTimeout(() => show(el, text), warm ? 0 : DELAY_MS)
    }
    const leave = (event: Event): void => {
      const held = current.current
      if (held === null) return
      const next = (event as PointerEvent).relatedTarget ?? (event as FocusEvent).relatedTarget
      if (next instanceof Node && held.el.contains(next)) return
      hide()
    }
    const over = (event: PointerEvent): void => enter(event.target)
    const focus = (event: FocusEvent): void => enter(event.target)
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', leave, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', leave, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', leave, true)
      document.removeEventListener('focusin', focus, true)
      document.removeEventListener('focusout', leave, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Kept on screen: measured once drawn, then nudged inside the window's edges.
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    if (tip === null || box.current === null) {
      setLeft(null)
      return
    }
    const width = box.current.offsetWidth
    setLeft(Math.min(Math.max(EDGE, tip.x - width / 2), window.innerWidth - width - EDGE))
  }, [tip])

  if (tip === null) return null
  return (
    <div
      ref={box}
      className={`tip${tip.above ? ' above' : ''}`}
      role="tooltip"
      style={{ left: left ?? tip.x, top: tip.y, visibility: left === null ? 'hidden' : 'visible' }}
    >
      {tip.text}
    </div>
  )
}
