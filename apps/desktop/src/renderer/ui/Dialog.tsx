import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The window's overlay layer, where every dialog draws. A dialog is often opened from inside something small (a
 * mini-app card, a list row, a side panel). Drawn there, its scrim was only that thing's size, so the dialog was
 * squeezed to it, scrolled sideways and pushed off the left of the window. Drawn here it is centred on the whole
 * window. A window without the layer (the quick-ask and dictation windows) keeps the dialog where it is.
 */
export const DIALOG_LAYER = '.win > .overlay'

export function dialogLayer(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(DIALOG_LAYER)
}

/**
 * A real dialog: scrim, focus trap, Escape to close, and focus returned where it came from.
 * Never an alert/confirm/prompt. On the desktop it is a centred panel sized to its content: never a phone sheet,
 * never a grab handle, never wider than the window.
 */
export function Dialog({
  label,
  onClose,
  children,
  surface = 'dialog',
  className,
  labelledBy,
}: {
  label: string
  onClose: () => void
  children: ReactNode
  surface?: 'dialog' | 'palette' | 'quick'
  className?: string
  labelledBy?: string
}): JSX.Element | null {
  const box = useRef<HTMLDivElement>(null)
  // undefined: not looked yet (a dialog mounted together with the window, before the layer is in the page); it is
  // looked for again once the page is drawn, before anything is painted. null: this window has no layer.
  const [layer, setLayer] = useState<HTMLElement | null | undefined>(() => dialogLayer() ?? undefined)
  const placed = layer !== undefined
  useLayoutEffect(() => {
    if (layer === undefined) setLayer(dialogLayer())
  }, [layer])
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!placed) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = box.current
    const first = node?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? node)?.focus()

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
      if (items.length === 0) {
        event.preventDefault()
        node.focus()
        return
      }
      const start = items[0]
      const end = items[items.length - 1]
      if (!start || !end) return
      if (event.shiftKey && document.activeElement === start) {
        event.preventDefault()
        end.focus()
      } else if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault()
        start.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && previous.isConnected) previous.focus()
    }
  }, [placed])

  const classes = [surface, className ?? ''].filter(Boolean).join(' ')
  const dialog = (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current()
      }}
    >
      <div
        ref={box}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  )
  if (layer === undefined) return null
  return layer === null ? dialog : createPortal(dialog, layer)
}
