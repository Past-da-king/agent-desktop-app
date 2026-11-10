/**
 * A screen for the "show me how" tests: a ScreenReader over a list of elements a test changes as if a program reacted
 * to his clicks, an overlay that remembers every ring it was told to draw (and when), and a model that answers from a
 * script and counts how often it was asked. Nothing here is real: it is the fake side of main/showme/screen.ts.
 */
import { performance } from 'node:perf_hooks'

import type { GuideModel } from '../../src/main/showme/guide-model'
import { LOCATE_SYSTEM, PICK_SYSTEM, PLAN_SYSTEM } from '../../src/main/showme/planner'
import type { ActiveWindow, InputEvent, Rect, ScreenReader, UiNode } from '../../src/main/showme/screen'
import type { WalkOverlay } from '../../src/main/showme/walk'

export function node(id: string, name: string, role = 'button', bounds: Rect = { x: 100, y: 100, width: 120, height: 40 }, extra: Partial<UiNode> = {}): UiNode {
  return { id, name, role, bounds, enabled: true, offscreen: false, path: '', ...extra }
}

/** A column of buttons, one under the other, from their names. */
export function column(names: string[], at: { x: number; y: number } = { x: 200, y: 200 }, role = 'button'): UiNode[] {
  return names.map((name, i) => node(`n${i + 1}`, name, role, { x: at.x, y: at.y + i * 60, width: 160, height: 40 }))
}

export const WINDOW: ActiveWindow = { hwnd: 'w1', pid: 100, process: 'chrome.exe', title: 'Acme Desk - Google Chrome', url: 'https://desk.acme-example.io/home', bounds: { x: 0, y: 0, width: 1600, height: 1000 } }

export class FakeScreen implements ScreenReader {
  win: ActiveWindow
  private readonly lists = new Map<string, UiNode[]>()
  private readonly listeners = new Set<(event: InputEvent) => void>()
  private readonly watchers = new Set<{ hwnd: string; id: string; onMove: (rect: Rect | null) => void }>()
  private readonly reactions = new Map<string, () => void>()
  readonly calls = { tree: [] as string[], find: [] as string[], capture: 0 }
  isAvailable = true
  png: Buffer = fakePng(800, 500)

  constructor(nodes: UiNode[] = [], window: ActiveWindow = WINDOW) {
    this.win = window
    this.lists.set(window.hwnd, nodes)
  }

  get nodes(): UiNode[] {
    return this.lists.get(this.win.hwnd) ?? []
  }

  /** The program re-drew: these are its elements now. Watchers of an element that is gone hear null. */
  set(nodes: UiNode[], hwnd = this.win.hwnd): void {
    this.lists.set(hwnd, nodes)
    for (const watcher of [...this.watchers]) {
      if (watcher.hwnd !== hwnd) continue
      const now = nodes.find((each) => each.id === watcher.id)
      if (now === undefined) watcher.onMove(null)
    }
  }

  /** An element moved (a scroll, a resize). */
  move(id: string, bounds: Rect): void {
    const list = this.nodes
    const found = list.find((each) => each.id === id)
    if (found === undefined) return
    found.bounds = bounds
    for (const watcher of [...this.watchers]) if (watcher.hwnd === this.win.hwnd && watcher.id === id) watcher.onMove({ ...bounds })
  }

  /** What the program does when he clicks the element of this name. */
  after(name: string, reaction: () => void): void {
    this.reactions.set(name, reaction)
  }

  available = async (): Promise<boolean> => this.isAvailable
  activeWindow = async (): Promise<ActiveWindow | null> => this.win

  tree = async (hwnd: string): Promise<UiNode[]> => {
    this.calls.tree.push(hwnd)
    return (this.lists.get(hwnd) ?? []).map((each) => ({ ...each, bounds: { ...each.bounds } }))
  }

  find = async (hwnd: string, q: { name: string; role?: string; nth?: number }): Promise<UiNode | null> => {
    this.calls.find.push(`${hwnd}:${q.name}`)
    const hits = (this.lists.get(hwnd) ?? []).filter((each) => each.name.trim().toLowerCase() === q.name.trim().toLowerCase() && !each.offscreen)
    const hit = q.nth !== undefined ? hits[q.nth - 1] : hits.length === 1 ? hits[0] : undefined
    return hit === undefined ? null : { ...hit, bounds: { ...hit.bounds } }
  }

  watch(hwnd: string, target: UiNode, onMove: (rect: Rect | null) => void): () => void {
    const entry = { hwnd, id: target.id, onMove }
    this.watchers.add(entry)
    return () => {
      this.watchers.delete(entry)
    }
  }

  capture = async (): Promise<Buffer> => {
    this.calls.capture++
    return this.png
  }

  onInput(callback: (event: InputEvent) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  dispose(): void {
    this.listeners.clear()
  }

  get listening(): number {
    return this.listeners.size
  }

  get watching(): number {
    return this.watchers.size
  }

  emit(event: InputEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  /** He clicks the middle of the element of this name; the program then reacts. Returns when the click happened. */
  click(name: string): number {
    const target = this.nodes.find((each) => each.name === name)
    if (target === undefined) throw new Error(`Nothing on the fake screen is called ${name}`)
    const at = performance.now()
    this.emit({ kind: 'click', x: target.bounds.x + target.bounds.width / 2, y: target.bounds.y + target.bounds.height / 2, button: 'left', time: Date.now() })
    this.reactions.get(name)?.()
    return at
  }

  clickAt(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): number {
    const at = performance.now()
    this.emit({ kind: 'click', x, y, button, time: Date.now() })
    return at
  }

  key(key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): void {
    this.emit({ kind: 'key', key, ctrl: mods.ctrl === true, alt: mods.alt === true, shift: mods.shift === true, time: Date.now() })
  }

  paste(): void {
    this.emit({ kind: 'paste', time: Date.now() })
  }

  /** Another window comes to the front. */
  front(window: ActiveWindow, nodes?: UiNode[]): void {
    this.win = window
    if (nodes !== undefined) this.lists.set(window.hwnd, nodes)
    this.emit({ kind: 'foreground', window, time: Date.now() })
  }
}

export interface Shown {
  rect: Rect
  label: string
  step: number
  of: number
  fill?: { field: string; value?: string; sensitive?: boolean }
  onAct?: (outcome: 'done' | 'skipped') => void
  /** performance.now() when the ring was asked for. */
  t: number
}

export class FakeOverlay implements WalkOverlay {
  readonly shows: Shown[] = []
  readonly moves: Rect[] = []
  hides = 0
  /** What is drawn now. */
  current: Shown | null = null
  readonly ops: string[] = []

  show(spec: Omit<Shown, 't'>): void {
    const shown = { ...spec, rect: { ...spec.rect }, t: performance.now() }
    this.shows.push(shown)
    this.current = shown
    this.ops.push(`show:${spec.label}`)
  }

  move(rect: Rect): void {
    this.moves.push({ ...rect })
    if (this.current !== null) this.current = { ...this.current, rect: { ...rect } }
    this.ops.push('move')
  }

  hide(): void {
    this.hides++
    this.current = null
    this.ops.push('hide')
  }

  /** The rings of real steps (not the "working out the steps" one). */
  get rings(): Shown[] {
    return this.shows.filter((shown) => shown.label !== 'Working out the steps')
  }
}

export interface ModelCall {
  kind: 'plan' | 'pick' | 'locate' | 'other'
  system: string
  prompt: string
  image: boolean
}

/** A model that answers from a script: one function per kind of question, with an optional delay like a real one's. */
export class FakeModel implements GuideModel {
  name = 'Fake account · small-fast'
  vision = false
  delayMs = 0
  readonly calls: ModelCall[] = []
  plan: (prompt: string, n: number) => string = () => '{"steps":[]}'
  pick: (prompt: string) => string = () => 'NONE'
  locate: (prompt: string) => string = () => '{"none":true}'

  async complete(system: string, prompt: string, options?: { image?: Buffer; signal?: AbortSignal }): Promise<string> {
    const kind: ModelCall['kind'] = system === PLAN_SYSTEM ? 'plan' : system === PICK_SYSTEM ? 'pick' : system === LOCATE_SYSTEM ? 'locate' : 'other'
    this.calls.push({ kind, system, prompt, image: options?.image !== undefined })
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (options?.signal?.aborted === true) throw new Error('aborted')
    if (kind === 'plan') return this.plan(prompt, this.calls.filter((call) => call.kind === 'plan').length)
    if (kind === 'pick') return this.pick(prompt)
    if (kind === 'locate') return this.locate(prompt)
    return ''
  }

  count(kind: ModelCall['kind']): number {
    return this.calls.filter((call) => call.kind === kind).length
  }
}

/** The clipboard, as the guide uses it. */
export class FakeClipboard {
  text = ''
  cleared = 0
  readonly written: string[] = []
  read = (): string => this.text
  write = (text: string): void => {
    this.text = text
    this.written.push(text)
  }
  clear = (): void => {
    this.text = ''
    this.cleared++
  }
}

/** A PNG header of this size (enough for the engine to read the size from). */
export function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(33)
  png.writeUInt32BE(0x89504e47, 0)
  png.writeUInt32BE(0x0d0a1a0a, 4)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

/** Waits (really) until something is true, or fails with what was being waited for. */
export async function until(what: string, check: () => boolean, ms = 2_000): Promise<void> {
  const end = performance.now() + ms
  while (!check()) {
    if (performance.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
