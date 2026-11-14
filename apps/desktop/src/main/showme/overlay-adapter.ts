/**
 * The walk's ring on the shared guide overlay ("show me how", 10 Nov 2026). The walk speaks physical screen pixels
 * (what the screen reader gives); the overlay (main/overlay/, one capture-protected window per display) speaks DIPs.
 * This is the thin piece between them: convert per display (./coords.ts), add the app's look, pass the rest through.
 * No window is made here: the overlay module owns every window.
 */
import type { BrandLook } from '../../shared/brand'
import { toDip, type ScreenDisplay } from './coords'
import type { Rect } from './screen'
import type { WalkOverlay } from './walk'

/** The part of main/overlay/guide-overlay.ts GuideOverlay a walk draws with. */
export interface RingOverlay {
  show(spec: {
    rect: Rect
    label: string
    step?: number
    of?: number
    fill?: { field: string; value?: string; sensitive?: boolean; pasteKey?: string }
    look: BrandLook
    displayId?: number
    onAct?: (outcome: 'done' | 'skipped') => void
  }): void
  move(rect: Rect): void
  hide(): void
}

export function walkOverlay(overlay: RingOverlay, displays: () => ScreenDisplay[], look: () => BrandLook, pasteKey = 'Ctrl+V'): WalkOverlay {
  let last: Parameters<WalkOverlay['show']>[0] | null = null
  let shownOn: number | null = null
  const draw = (spec: Parameters<WalkOverlay['show']>[0]): void => {
    const at = toDip(spec.rect, displays())
    if (at === null) {
      shownOn = null
      overlay.hide()
      return
    }
    shownOn = at.displayId
    overlay.show({
      rect: at.rect,
      displayId: at.displayId,
      label: spec.label,
      step: spec.step,
      of: spec.of,
      ...(spec.fill === undefined ? {} : { fill: { ...spec.fill, pasteKey } }),
      look: look(),
      ...(spec.onAct === undefined ? {} : { onAct: spec.onAct }),
    })
  }
  return {
    show(spec) {
      last = { ...spec, rect: { ...spec.rect } }
      draw(last)
    },
    move(rect) {
      if (last === null) return
      last = { ...last, rect: { ...rect } }
      const at = toDip(rect, displays())
      // Dragged onto another display: that display's window takes the ring over.
      if (at === null || at.displayId !== shownOn) draw(last)
      else overlay.move(at.rect)
    },
    hide() {
      last = null
      shownOn = null
      overlay.hide()
    },
  }
}
