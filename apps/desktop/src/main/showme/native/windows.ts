/**
 * The ScreenReader for Windows: every call goes to the `agent-screen` helper (./sidecar.ts), which reads other
 * windows through UI Automation. This file owns nothing native; it shapes the answers, keeps the watches and the
 * input listeners, and makes sure the mouse and keyboard hooks exist only while somebody listens.
 *
 * All rectangles are physical screen pixels, as ../screen.ts says.
 */
import type { ActiveWindow, InputEvent, Rect, ScreenReader, UiNode } from '../screen'
import { ScreenReadError, ScreenSidecar } from './sidecar'
import type { SidecarEvent, SpawnLike } from './sidecar'

/** One display as the caller knows it (Electron's id), in physical pixels. */
export interface ScreenDisplay {
  id: number
  bounds: Rect
}

/** A monitor as Windows reports it. */
export interface ScreenMonitor {
  device: string
  bounds: Rect
  work: Rect
  /** 1.25 for a 125% screen. */
  scale: number
  primary: boolean
}

/** What the helper knows beyond ../screen.ts ActiveWindow. */
export interface NativeActiveWindow extends ActiveWindow {
  className: string
  /** True when the window runs as administrator and this app does not: its controls cannot be read. */
  elevated: boolean
  monitor?: ScreenMonitor
}

export interface ScreenReaderOptions {
  /** The helper's path, or null when this build has none. */
  binary: () => string | null
  spawn?: SpawnLike
  /** Process ids whose windows are never "the active window" (this app's own). The helper's parent is always one. */
  excludePids?: () => number[]
  /** The displays with the caller's ids, in physical pixels; without it, displayId is left out and a display capture takes the primary screen. */
  displays?: () => ScreenDisplay[]
  /** The key names reported as 'key' events. Nothing else typed ever leaves the helper. */
  keys?: string[]
  /** Report a click when the button goes down instead of when it comes up (the default: the app has acted by then). */
  clickOn?: 'up' | 'down'
  /** Scale captures down to this width, for a vision model. 0 keeps the true size. */
  captureMaxWidth?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
  idleMs?: number
  callTimeoutMs?: number
}

export interface NativeScreenReader extends ScreenReader {
  /** Why it cannot work here (not Windows, the helper is missing), or null. */
  unavailableReason(): string | null
  /** A window by its handle, in the same shape as activeWindow(). */
  window(hwnd: string): Promise<NativeActiveWindow | null>
  activeWindow(): Promise<NativeActiveWindow | null>
  /** Every window a person could be working in, front to back, without this app's own. No url (that costs a read each). */
  windows(): Promise<NativeActiveWindow[]>
  monitors(): Promise<ScreenMonitor[]>
  /**
   * The mouse wheel turned (at most one call every 50 ms). A browser reports an element's new place about half a
   * second after a scroll, so a caller can let its ring rest on this and show it again on the next watch move.
   * Like onInput, it keeps the hooks installed only while somebody listens.
   */
  onScroll(cb: (e: { x: number; y: number; time: number }) => void): () => void
  /** Change which keys are reported while a walk runs. */
  setKeys(keys: string[]): void
  /** How long the person has not touched mouse or keyboard, ms; -1 when unknown. */
  idleMs(): Promise<number>
  /** The helper's own account of itself; null when it is not there. `hooks` is true only while input is being listened to. */
  helperState(): Promise<{ version: string; elevated: boolean; hooks: boolean; idleMs: number } | null>
}

const DEFAULT_KEYS = ['Escape', 'Enter', 'Tab']

const num = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0)
const str = (raw: unknown, max = 2000): string => (typeof raw === 'string' ? raw.slice(0, max) : '')
const obj = (raw: unknown): Record<string, unknown> | null => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null)

export function parseRect(raw: unknown): Rect | null {
  const r = obj(raw)
  if (r === null) return null
  const rect = { x: Math.round(num(r['x'])), y: Math.round(num(r['y'])), width: Math.round(num(r['width'])), height: Math.round(num(r['height'])) }
  return rect.width > 0 && rect.height > 0 ? rect : null
}

function parseMonitor(raw: unknown): ScreenMonitor | null {
  const m = obj(raw)
  const bounds = m === null ? null : parseRect(m['bounds'])
  if (m === null || bounds === null) return null
  return { device: str(m['device'], 64), bounds, work: parseRect(m['work']) ?? bounds, scale: num(m['scale']) || 1, primary: m['primary'] === true }
}

export function parseWindow(raw: unknown, displays: ScreenDisplay[]): NativeActiveWindow | null {
  const w = obj(raw)
  if (w === null) return null
  const hwnd = str(w['hwnd'], 32)
  const bounds = parseRect(w['bounds'])
  if (hwnd === '' || bounds === null) return null
  const window: NativeActiveWindow = {
    hwnd,
    pid: num(w['pid']),
    process: str(w['process'], 260),
    title: str(w['title'], 512),
    bounds,
    className: str(w['className'], 256),
    elevated: w['elevated'] === true,
  }
  const url = str(w['url'], 4000)
  if (url !== '') window.url = url
  const monitor = parseMonitor(w['monitor'])
  if (monitor !== null) window.monitor = monitor
  const display = displayAt(displays, bounds)
  if (display !== null) window.displayId = display.id
  return window
}

/** The display that holds the middle of a rectangle, else the one it overlaps most. */
export function displayAt(displays: ScreenDisplay[], rect: Rect): ScreenDisplay | null {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  let best: ScreenDisplay | null = null
  let bestArea = 0
  for (const display of displays) {
    const b = display.bounds
    if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) return display
    const w = Math.min(rect.x + rect.width, b.x + b.width) - Math.max(rect.x, b.x)
    const h = Math.min(rect.y + rect.height, b.y + b.height) - Math.max(rect.y, b.y)
    if (w > 0 && h > 0 && w * h > bestArea) {
      best = display
      bestArea = w * h
    }
  }
  return best
}

export function parseNode(raw: unknown): UiNode | null {
  const n = obj(raw)
  if (n === null) return null
  const id = str(n['id'], 32)
  const r = obj(n['bounds'])
  if (id === '' || r === null) return null
  const node: UiNode = {
    id,
    role: str(n['role'], 40),
    name: str(n['name'], 200),
    bounds: { x: Math.round(num(r['x'])), y: Math.round(num(r['y'])), width: Math.round(num(r['width'])), height: Math.round(num(r['height'])) },
    enabled: n['enabled'] !== false,
    offscreen: n['offscreen'] === true,
    path: str(n['path'], 300),
  }
  const value = str(n['value'], 200)
  if (value !== '') node.value = value
  return node
}

export function parseInput(event: SidecarEvent, displays: ScreenDisplay[]): InputEvent | null {
  const time = num(event['time']) || Date.now()
  const kind = event['kind']
  if (kind === 'click') {
    const button = event['button']
    if (button !== 'left' && button !== 'right' && button !== 'middle') return null
    return { kind: 'click', x: Math.round(num(event['x'])), y: Math.round(num(event['y'])), button, time }
  }
  if (kind === 'key') {
    const key = str(event['key'], 20)
    if (key === '') return null
    return { kind: 'key', key, ctrl: event['ctrl'] === true, alt: event['alt'] === true, shift: event['shift'] === true, time }
  }
  if (kind === 'paste') return { kind: 'paste', time }
  if (kind === 'foreground') {
    const window = parseWindow(event['window'], displays)
    return window === null ? null : { kind: 'foreground', window, time }
  }
  return null
}

interface WatchEntry {
  hwnd: string
  node: UiNode
  onMove: (r: Rect | null) => void
  /** The helper's id for it, once it answered. */
  remote: number | null
  stopped: boolean
}

export function createWindowsScreenReader(options: ScreenReaderOptions): NativeScreenReader {
  const listeners = new Set<(e: InputEvent) => void>()
  const wheelListeners = new Set<(e: { x: number; y: number; time: number }) => void>()
  const listening = (): boolean => listeners.size > 0 || wheelListeners.size > 0
  const watches = new Set<WatchEntry>()
  let keys = [...(options.keys ?? DEFAULT_KEYS)]
  let hooksOn = false
  let disposed = false
  const displays = (): ScreenDisplay[] => {
    try {
      return options.displays?.() ?? []
    } catch {
      return []
    }
  }

  const sidecar = new ScreenSidecar({
    binary: options.binary,
    spawn: options.spawn,
    log: options.log,
    idleMs: options.idleMs,
    callTimeoutMs: options.callTimeoutMs,
    busy: () => listening() || watches.size > 0,
    onEvent: (event) => {
      if (event.event === 'input' && event['kind'] === 'wheel') {
        const wheel = { x: Math.round(num(event['x'])), y: Math.round(num(event['y'])), time: num(event['time']) || Date.now() }
        for (const listener of [...wheelListeners]) {
          try {
            listener(wheel)
          } catch {
            // One listener's error is not the others' problem.
          }
        }
      } else if (event.event === 'input') {
        const input = parseInput(event, displays())
        if (input === null) return
        for (const listener of [...listeners]) {
          try {
            listener(input)
          } catch {
            // One listener's error is not the others' problem.
          }
        }
      } else if (event.event === 'move') {
        const id = num(event['watch'])
        for (const watch of watches) {
          if (watch.remote === id && !watch.stopped) watch.onMove(parseRect(event['rect']))
        }
      }
    },
    onLost: () => {
      // Whatever the helper followed is gone with it. Tell the watchers once, then start again for whoever still listens.
      hooksOn = false
      for (const watch of watches) {
        watch.remote = null
        if (!watch.stopped) watch.onMove(null)
      }
      if (disposed) return
      const again = setTimeout(() => {
        if (disposed) return
        if (listening()) void syncHooks()
        for (const watch of watches) if (!watch.stopped) void startWatch(watch)
      }, 500)
      again.unref?.()
    },
  })

  let prepared = -1
  let preparing: Promise<void> | null = null
  /** Tell a freshly started helper whose windows to leave out, once per start. */
  const prepare = (): Promise<void> => {
    const extra = options.excludePids?.() ?? []
    if (extra.length === 0 || (prepared === sidecar.generation && sidecar.running())) return Promise.resolve()
    if (preparing !== null) return preparing
    preparing = sidecar
      .call('exclude', { pids: extra })
      .then(() => {
        prepared = sidecar.generation
      })
      .finally(() => {
        preparing = null
      })
    return preparing
  }

  const call = async (op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> => {
    await prepare()
    return sidecar.call(op, args, timeoutMs)
  }

  let syncing: Promise<void> | null = null
  let keysChanged = false
  /** Make the helper's hooks match whether anybody listens. One at a time; a change that comes meanwhile is picked up after. */
  const syncHooks = (): Promise<void> => {
    if (syncing !== null) return syncing
    syncing = (async (): Promise<void> => {
      for (;;) {
        const want = listening()
        if (want === hooksOn && !(want && keysChanged)) return
        if (!want && !sidecar.running()) {
          hooksOn = false
          return
        }
        keysChanged = false
        try {
          await call('input', want ? { on: true, keys, clickOn: options.clickOn ?? 'up' } : { on: false })
          hooksOn = want
        } catch (error) {
          hooksOn = false
          options.log?.('showme: input hooks', { error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
    })().finally(() => {
      syncing = null
    })
    return syncing
  }

  const startWatch = async (watch: WatchEntry): Promise<void> => {
    try {
      const result = obj(await call('watch', { hwnd: watch.hwnd, node: watch.node.id, name: watch.node.name, role: watch.node.role }))
      const remote = result === null ? 0 : num(result['watch'])
      if (watch.stopped) {
        if (remote > 0) void sidecar.call('unwatch', { watch: remote }).catch(() => undefined)
        return
      }
      watch.remote = remote
    } catch {
      if (!watch.stopped) watch.onMove(null)
    }
  }

  return {
    unavailableReason: () => sidecar.unavailableReason(),

    async available(): Promise<boolean> {
      if (disposed || sidecar.unavailableReason() !== null) return false
      try {
        await call('hello', {}, 5_000)
        return true
      } catch {
        return false
      }
    },

    async activeWindow(): Promise<NativeActiveWindow | null> {
      try {
        return parseWindow(await call('activeWindow'), displays())
      } catch {
        return null
      }
    },

    async window(hwnd: string): Promise<NativeActiveWindow | null> {
      try {
        return parseWindow(await call('window', { hwnd }), displays())
      } catch {
        return null
      }
    },

    async windows(): Promise<NativeActiveWindow[]> {
      try {
        const raw = await call('windows')
        const all = displays()
        return Array.isArray(raw) ? raw.map((w) => parseWindow(w, all)).filter((w): w is NativeActiveWindow => w !== null) : []
      } catch {
        return []
      }
    },

    async monitors(): Promise<ScreenMonitor[]> {
      const raw = await call('monitors')
      return Array.isArray(raw) ? raw.map(parseMonitor).filter((m): m is ScreenMonitor => m !== null) : []
    },

    async tree(hwnd, opts): Promise<UiNode[]> {
      const result = obj(await call('tree', { hwnd, max: opts?.max ?? 400, interactiveOnly: opts?.interactiveOnly ?? true }))
      const nodes = result === null ? null : result['nodes']
      return Array.isArray(nodes) ? nodes.map(parseNode).filter((n): n is UiNode => n !== null) : []
    },

    async find(hwnd, q): Promise<UiNode | null> {
      const args: Record<string, unknown> = { hwnd, name: q.name, nth: q.nth ?? 1 }
      if (q.role !== undefined && q.role !== '') args['role'] = q.role
      const result = obj(await call('find', args))
      return result === null ? null : parseNode(result['node'])
    },

    watch(hwnd, node, onMove): () => void {
      const watch: WatchEntry = { hwnd, node, onMove, remote: null, stopped: false }
      watches.add(watch)
      void startWatch(watch)
      return () => {
        if (watch.stopped) return
        watch.stopped = true
        watches.delete(watch)
        if (watch.remote !== null && sidecar.running()) void sidecar.call('unwatch', { watch: watch.remote }).catch(() => undefined)
      }
    },

    async capture(target): Promise<Buffer> {
      const args: Record<string, unknown> = {}
      if ((options.captureMaxWidth ?? 0) > 0) args['maxWidth'] = options.captureMaxWidth
      if ('hwnd' in target) args['hwnd'] = target.hwnd
      else {
        let bounds = displays().find((d) => d.id === target.displayId)?.bounds
        if (bounds === undefined) {
          const raw = await call('monitors')
          const all = Array.isArray(raw) ? raw.map(parseMonitor).filter((m): m is ScreenMonitor => m !== null) : []
          bounds = (all.find((m) => m.primary) ?? all[0])?.bounds
        }
        if (bounds === undefined) throw new ScreenReadError('failed', 'That screen was not found.')
        Object.assign(args, bounds)
      }
      const result = obj(await call('capture', args, 20_000))
      const png = result === null ? '' : result['png']
      if (typeof png !== 'string' || png === '') throw new ScreenReadError('failed', 'The screen could not be captured.')
      return Buffer.from(png, 'base64')
    },

    onInput(cb): () => void {
      listeners.add(cb)
      void syncHooks()
      return () => {
        if (!listeners.delete(cb)) return
        // The hooks leave with the last listener, at once.
        if (!listening()) void syncHooks()
      }
    },

    onScroll(cb): () => void {
      wheelListeners.add(cb)
      void syncHooks()
      return () => {
        if (wheelListeners.delete(cb) && !listening()) void syncHooks()
      }
    },

    setKeys(next: string[]): void {
      keys = [...next]
      keysChanged = true
      if (listening()) void syncHooks()
    },

    async idleMs(): Promise<number> {
      return (await this.helperState())?.idleMs ?? -1
    },

    async helperState() {
      try {
        const result = obj(await call('hello', {}, 5_000))
        if (result === null) return null
        return { version: str(result['version'], 20), elevated: result['elevated'] === true, hooks: result['hooks'] === true, idleMs: typeof result['idleMs'] === 'number' ? result['idleMs'] : -1 }
      } catch {
        return null
      }
    },

    dispose(): void {
      disposed = true
      listeners.clear()
      wheelListeners.clear()
      for (const watch of watches) watch.stopped = true
      watches.clear()
      sidecar.dispose()
    },
  }
}
