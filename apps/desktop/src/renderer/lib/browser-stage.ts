/**
 * The full-size browser view's empty page area. BrowserStage registers it; the one BrowserHost (in the panel
 * card) lays the live page over it while the page is full size. A tiny shared slot, not React state, so the
 * host can read it in the same frame it is laid out.
 */
let box: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setStageBox(element: HTMLElement | null): void {
  if (box === element) return
  box = element
  for (const listener of [...listeners]) listener()
}

export function stageBox(): HTMLElement | null {
  return box !== null && box.isConnected ? box : null
}

export function onStageBox(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
