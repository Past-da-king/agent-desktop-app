// The seam between the "show me how" engine (this folder) and the native layer that reads the
// screen (./native, with its sidecar under tools/). Both sides code to this file. The engine
// owns it: change it here, additively, and say so in the commit message.
//
// Every rect is in PHYSICAL screen pixels with the virtual desktop's origin (the primary
// display's top left is 0,0; a display to its left or above has negative coordinates). A click's
// x and y are in the same pixels. The engine converts to Electron's DIP per display before it
// draws anything (./coords.ts).
//
// How the app gets the native layer: ./native/index.ts exports
//   export function createScreenReader(options?: { log?: (message: string, detail?: Record<string, unknown>) => void }): ScreenReader
// and ./reader.ts (ONE line, see its comment) returns it. The native layer makes that one-line change itself when it
// lands. Until then the service runs with no reader and says so plainly; nothing else in the engine changes.
//
// What the engine relies on, beyond the types:
//   - find() matches the name exactly first (case and surrounding space ignored), then as a part; role is a hint in
//     the engine's own words (button, link, textbox, checkbox, combobox, tab, menuitem, listitem) and may be ignored;
//     nth is 1-based among the matches. It answers null rather than an offscreen or zero-size element when it can.
//   - tree() and find() never give a password field's value. The engine sends no value to a model either.
//   - onInput() reports a click AFTER the system delivered it (never held back), 'paste' for Ctrl+V or a paste from a
//     menu, and 'foreground' when another window comes to the front. Events are only needed while a listener is on.
//   - activeWindow() and 'foreground' never report the Agent app's own windows or the overlay.

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

/** What a watch's null (or new place) means, when the reader can tell. */
export type WatchWhy = 'moved' | 'scrolling' | 'hidden' | 'gone'

export interface ScreenReader {
  available(): Promise<boolean>
  /** The window in front. Never one of the Agent app's own windows, nor the overlay. */
  activeWindow(): Promise<ActiveWindow | null>
  /** A flat list of the visible, named elements that can be clicked or typed in. */
  tree(hwnd: string, opts?: { max?: number; interactiveOnly?: boolean }): Promise<UiNode[]>
  find(hwnd: string, q: { name: string; role?: string; nth?: number }): Promise<UiNode | null>
  /**
   * The rect follows scrolling and resizing; null when the element is gone. Returns a stop.
   * `why` (added 10 Nov 2026, optional) says what a null means when the reader knows: 'scrolling' (the page is moving
   * and the place will be reported again), 'hidden' (it exists but is out of sight) or 'gone'. Left out, null is gone.
   * find() may answer an element with `offscreen: true` when the only match is out of sight: the engine reads that as
   * "scroll to it" and never rings it.
   */
  watch(hwnd: string, node: UiNode, onMove: (r: Rect | null, why?: WatchWhy) => void): () => void
  /** A PNG, for the vision fallback. */
  capture(target: { hwnd: string } | { displayId: number }): Promise<Buffer>
  /** Global and passive: it never blocks or swallows the person's input. */
  onInput(cb: (e: InputEvent) => void): () => void
  dispose(): void
}

/** What stands in while there is no native layer (another system, or the layer failed to load): nothing can be read. */
export function noScreenReader(): ScreenReader {
  return {
    available: async () => false,
    activeWindow: async () => null,
    tree: async () => [],
    find: async () => null,
    watch: () => () => undefined,
    capture: async () => Buffer.alloc(0),
    onInput: () => () => undefined,
    dispose: () => undefined,
  }
}
