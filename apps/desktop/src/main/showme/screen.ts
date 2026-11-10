// The seam between the "show me how" engine (this folder) and the native layer that reads the
// screen (./native, with its sidecar under tools/). Both sides code to this file. The engine
// owns it: change it here, additively, and say so in the commit message.
//
// Every rect is in PHYSICAL screen pixels with the virtual desktop's origin (the primary
// display's top left is 0,0; a display to its left or above has negative coordinates). The
// engine converts to Electron's DIP per display before it draws anything (./coords.ts).

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ActiveWindow {
  hwnd: string
  pid: number
  process: string
  title: string
  /** The page address when the window is a browser and it can be read. */
  url?: string
  bounds: Rect
  displayId?: number
}

export interface UiNode {
  id: string
  role: string
  name: string
  /** Never set for a password field. */
  value?: string
  bounds: Rect
  enabled: boolean
  offscreen: boolean
  /** Names of the ancestors, short, outermost first: "Settings > Pixels". */
  path: string
}

export type InputEvent =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; time: number }
  | { kind: 'key'; key: string; ctrl: boolean; alt: boolean; shift: boolean; time: number }
  | { kind: 'paste'; time: number }
  | { kind: 'foreground'; window: ActiveWindow; time: number }

export interface ScreenReader {
  available(): Promise<boolean>
  /** The window in front. Never one of the Agent app's own windows, nor the overlay. */
  activeWindow(): Promise<ActiveWindow | null>
  /** A flat list of the visible, named elements that can be clicked or typed in. */
  tree(hwnd: string, opts?: { max?: number; interactiveOnly?: boolean }): Promise<UiNode[]>
  find(hwnd: string, q: { name: string; role?: string; nth?: number }): Promise<UiNode | null>
  /** The rect follows scrolling and resizing; null when the element is gone. Returns a stop. */
  watch(hwnd: string, node: UiNode, onMove: (r: Rect | null) => void): () => void
  /** A PNG, for the vision fallback. */
  capture(target: { hwnd: string } | { displayId: number }): Promise<Buffer>
  /** Global and passive: it never blocks or swallows the person's input. */
  onInput(cb: (e: InputEvent) => void): () => void
  dispose(): void
}
