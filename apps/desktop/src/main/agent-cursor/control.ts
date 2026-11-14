/**
 * Control of other windows WITHOUT his mouse, keyboard or focus (11 Nov 2026): the code behind screen_windows,
 * screen_read and screen_act. See docs/agent-cursor.md for the ladder.
 *
 *   1. window messages for text (WM_SETTEXT, EM_REPLACESEL), then characters, before the value pattern, because the
 *      value pattern can bring a window to the front (seen on Notepad);
 *   2. UI Automation patterns (invoke, toggle, select, expand, scroll), each inside the helper's focus guard;
 *   3. CDP for Chromium and Electron windows: the `cdp` hook (agent-cursor/cdp-rung.ts, the lead wires it);
 *   4. posted mouse, wheel and key messages to the child window under the point;
 *   5. the agent desktop for a program that ignores posted input: the `desktop` hook (the lead wires it);
 *   6. real input, only under the input lock (./input-lock.ts), and only when asked for AND allowed in Settings.
 *
 * Every action is verified by the helper (element state, windows, control tree, the window's own picture). A program
 * that ignores posted input is SAID to ignore it; nothing is claimed that did not change.
 */
import type { InjectStep, InputLock } from './input-lock'
import { CHROMIUM_CLASSES, needsAgentDesktopReason, RAW_INPUT_CLASSES, RAW_INPUT_PROCESSES } from './raw-input-apps'

export interface ScreenWindow {
  hwnd: string
  pid: number
  title: string
  process: string
  className: string
  rect: { x: number; y: number; width: number; height: number }
  minimised: boolean
  /** 'elevated' means it runs as administrator and this app does not: Windows blocks every message and read from here. */
  integrity: 'normal' | 'elevated'
  /** Why it needs the agent desktop (or null when posted input can work). */
  needs: string | null
}

export interface ScreenActRequest {
  hwnd?: string
  title?: string
  process?: string
  action: 'click' | 'double_click' | 'right_click' | 'type' | 'set_value' | 'toggle' | 'select' | 'expand' | 'collapse' | 'scroll' | 'key'
  name?: string
  role?: string
  nth?: number
  x?: number
  y?: number
  text?: string
  key?: string
  dy?: number
  state?: string
  append?: boolean
  /** Last resort: real input under the input lock, if Settings allows it. */
  realInput?: boolean
  owner?: string
  signal?: AbortSignal
}

export interface ScreenActAnswer {
  ok: boolean
  /** Which rung worked ('msg:settext', 'uia:toggle', 'cdp:click', 'post:mouse', 'desktop', 'real:lock'), when one did. */
  rung?: string
  evidence?: string
  /** Why not: needs_agent_desktop, elevated, ignored, no_window, no_element, disabled, minimised, bad_request, refused... */
  code?: string
  message: string
  tried?: Array<{ rung: string; result: string }>
  /** What the program did to his window, if anything. */
  focus?: { taken: boolean; givenBack: boolean; lostMs: number; rung?: string }
  /** His pointer and window, before and after: unchanged is the rule. */
  his: { cursorMoved: boolean; foregroundChanged: boolean }
  note?: string
  value?: string
  element?: string
  point?: { x: number; y: number }
}

export interface ScreenReadRequest {
  hwnd?: string
  title?: string
  process?: string
  /** Only elements whose name, role or value contain this. */
  filter?: string
  /** All named elements instead of the usable ones. */
  everything?: boolean
  max?: number
  /** Also a picture of the window (taken off screen: a covered window can be read). */
  picture?: boolean
}

export interface ScreenReadElement {
  role: string
  name: string
  value?: string
  rect: { x: number; y: number; width: number; height: number }
  enabled: boolean
  path: string
}

export interface ScreenReadAnswer {
  window: ScreenWindow
  seen: number
  elements: ScreenReadElement[]
  /** Path of the PNG, when asked for. */
  picture?: string
  /** 'window' = the window's own picture; 'screen' = it refused and this is the screen area (a window on top shows). */
  pictureHow?: string
}

/** The rungs the lead adds. Return null when the rung does not apply to this window. */
export type ExtraRung = (input: { window: ScreenWindow; request: ScreenActRequest }) => Promise<ScreenActAnswer | null>

export interface TakerMemory {
  /** The rungs known to take his window focus on this program and window class. */
  avoid(process: string, className: string): string[]
  add(process: string, className: string, rung: string): void
}

export function memoryTakers(initial: Array<[string, string, string]> = [], onChange?: (all: Array<[string, string, string]>) => void): TakerMemory {
  const all = new Map<string, [string, string, string]>()
  const key = (p: string, c: string, r: string): string => p.toLowerCase() + '|' + c + '|' + r
  for (const item of initial) all.set(key(...item), item)
  return {
    avoid: (process, className) => [...all.values()].filter(([p, c]) => p.toLowerCase() === process.toLowerCase() && c === className).map(([, , rung]) => rung),
    add: (process, className, rung) => {
      all.set(key(process, className, rung), [process, className, rung])
      onChange?.([...all.values()])
    },
  }
}

export interface ScreenControlDeps {
  /** The helper: tools/agent-screen over JSON lines (showme/native/windows.ts call). */
  call: (op: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>
  /** Save a picture, return its path. */
  savePicture: (png: Buffer) => Promise<string>
  takers?: TakerMemory
  lock?: InputLock | null
  /** Setting agentRealInput. */
  realInputAllowed?: () => boolean
  /** CDP for Chromium and Electron windows (the lead). */
  cdp?: ExtraRung
  /** The agent's own desktop (the lead). */
  desktop?: ExtraRung
  /** The agent cursor (agent-cursor/cursor.ts, the other builder): where the agent is acting. */
  cursor?: { show(id: string, spec: { at?: { x: number; y: number }; label?: string; who?: string }): Promise<void>; click(id: string): void }
  now?: () => number
}

const rec = (raw: unknown): Record<string, unknown> | null => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null)
const text = (raw: unknown, max = 600): string => (typeof raw === 'string' ? raw.slice(0, max) : '')
const num = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0)
const rectOf = (raw: unknown): { x: number; y: number; width: number; height: number } => {
  const r = rec(raw) ?? {}
  return { x: num(r['x']), y: num(r['y']), width: num(r['width']), height: num(r['height']) }
}

export function parseScreenWindow(raw: unknown): ScreenWindow | null {
  const w = rec(raw)
  if (w === null || typeof w['hwnd'] !== 'string') return null
  const process = text(w['process'], 260)
  const className = text(w['className'], 256)
  const elevated = w['elevated'] === true
  const needs = elevated ? 'it runs as administrator and this app does not, so Windows blocks every message and read from here' : needsAgentDesktopReason(process, className)
  return { hwnd: w['hwnd'], pid: num(w['pid']), title: text(w['title'], 300), process, className, rect: rectOf(w['bounds']), minimised: w['minimized'] === true || w['minimised'] === true, integrity: elevated ? 'elevated' : 'normal', needs }
}

const UWP_CLASSES: readonly string[] = ['ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow']
const UWP_AVOID: readonly string[] = ['uia:invoke', 'uia:toggle', 'uia:select', 'uia:expand', 'uia:default', 'uia:value', 'uia:contextmenu']

export class ScreenControl {
  constructor(private readonly deps: ScreenControlDeps) {}

  async windows(): Promise<ScreenWindow[]> {
    const raw = await this.deps.call('windows', { minimised: true })
    return (Array.isArray(raw) ? raw : []).map(parseScreenWindow).filter((w): w is ScreenWindow => w !== null)
  }

  /** The window the caller means, re-read now (a handle can be reused by another program). */
  async resolve(query: { hwnd?: string; title?: string; process?: string }): Promise<{ window: ScreenWindow } | { error: string; code: string }> {
    const all = await this.windows()
    if (query.hwnd !== undefined && query.hwnd !== '') {
      const found = all.find((w) => w.hwnd.toLowerCase() === query.hwnd?.toLowerCase())
      return found === undefined ? { error: 'There is no window ' + query.hwnd + ' now. List the windows again with screen_windows.', code: 'no_window' } : { window: found }
    }
    const title = query.title?.toLowerCase() ?? ''
    const proc = query.process?.toLowerCase() ?? ''
    if (title === '' && proc === '') return { error: 'Say which window: its hwnd from screen_windows, or part of its title or its process name.', code: 'bad_request' }
    const hits = all.filter((w) => (title === '' || w.title.toLowerCase().includes(title)) && (proc === '' || w.process.toLowerCase() === proc || w.process.toLowerCase().includes(proc)))
    if (hits.length === 0) return { error: 'No window matches. List the windows with screen_windows.', code: 'no_window' }
    if (hits.length > 1) return { error: 'More than one window matches (' + hits.slice(0, 6).map((w) => w.hwnd + ' "' + w.title.slice(0, 40) + '"').join(', ') + '). Pass the hwnd.', code: 'ambiguous' }
    return { window: hits[0] as ScreenWindow }
  }

  async read(request: ScreenReadRequest): Promise<ScreenReadAnswer | { error: string; code: string }> {
    const found = await this.resolve(request)
    if ('error' in found) return found
    const window = found.window
    if (window.integrity === 'elevated') return { error: 'That window ' + window.needs + '. It needs the agent desktop.', code: 'elevated' }
    const max = Math.max(1, Math.min(1500, Math.floor(request.max ?? 250)))
    const filter = request.filter?.toLowerCase() ?? ''
    const treeRaw = rec(await this.deps.call('tree', { hwnd: window.hwnd, max: filter === '' ? max : 3000, interactiveOnly: request.everything !== true }, 20_000)) ?? {}
    let elements: ScreenReadElement[] = (Array.isArray(treeRaw['nodes']) ? (treeRaw['nodes'] as unknown[]) : []).map((n) => {
      const node = rec(n) ?? {}
      return { role: text(node['role'], 40), name: text(node['name'], 200), ...(typeof node['value'] === 'string' ? { value: text(node['value'], 200) } : {}), rect: rectOf(node['bounds']), enabled: node['enabled'] !== false, path: text(node['path'], 200) }
    })
    if (filter !== '') elements = elements.filter((e) => e.name.toLowerCase().includes(filter) || e.role.toLowerCase().includes(filter) || (e.value ?? '').toLowerCase().includes(filter)).slice(0, max)
    const answer: ScreenReadAnswer = { window, seen: num(treeRaw['seen']), elements }
    if (request.picture === true && !window.minimised) {
      const shot = rec(await this.deps.call('capture', { hwnd: window.hwnd, maxWidth: 1400 }, 20_000))
      if (shot !== null && typeof shot['png'] === 'string') {
        answer.picture = await this.deps.savePicture(Buffer.from(shot['png'], 'base64'))
        answer.pictureHow = text(shot['how'], 20)
      }
    }
    return answer
  }

  async act(request: ScreenActRequest): Promise<ScreenActAnswer> {
    const his = { cursorMoved: false, foregroundChanged: false }
    const refuse = (code: string, message: string): ScreenActAnswer => ({ ok: false, code, message, his })
    const found = await this.resolve(request)
    if ('error' in found) return refuse(found.code, found.error)
    const window = found.window
    const who = request.owner ?? 'agent'
    if (window.needs !== null) {
      const fromDesktop = await this.deps.desktop?.({ window, request })
      if (fromDesktop) return fromDesktop
      return refuse(window.integrity === 'elevated' ? 'elevated' : 'needs_agent_desktop', 'Needs the agent desktop: ' + window.needs + '. Posted input cannot reach it and real input is not used.')
    }
    if (window.minimised && request.x !== undefined) return refuse('minimised', 'That window is minimised, so nothing in it has a place to click. Act on an element by name instead.')

    // Show where the agent is acting (the other builder's cursor), before the action.
    if (this.deps.cursor !== undefined && request.x !== undefined && request.y !== undefined && !window.minimised) {
      void this.deps.cursor.show(who, { at: { x: window.rect.x + request.x, y: window.rect.y + request.y }, label: request.action, who }).catch(() => undefined)
    }

    // 3. CDP for Chromium and Electron: before the OS-level rungs (never needs the window to be in front).
    if (this.deps.cdp !== undefined && CHROMIUM_CLASSES.includes(window.className)) {
      const viaCdp = await this.deps.cdp({ window, request })
      if (viaCdp !== null && viaCdp.ok) return this.shown(viaCdp, who)
    }

    const avoid = [...(this.deps.takers?.avoid(window.process, window.className) ?? [])]
    // A packaged (UWP) program that is not in front takes the keyboard on its first UI Automation call and a window message
    // cannot always give it back in time (Calculator, 11 Nov 2026: 200 to 300 ms lost in 3 of 5 runs). So its UIA rungs are
    // skipped until it is in front anyway: posted input first, then the agent desktop. Never retried once it has stolen focus.
    if (UWP_CLASSES.includes(window.className)) {
      const place = rec(await this.deps.call('place', { hwnd: window.hwnd }).catch(() => null)) ?? {}
      if (place['foreground'] !== true) for (const rung of UWP_AVOID) if (!avoid.includes(rung)) avoid.push(rung)
    }
    const args: Record<string, unknown> = {
      hwnd: window.hwnd,
      pid: window.pid,
      action: request.action,
      avoid,
      rawProcesses: [...RAW_INPUT_PROCESSES],
      rawClasses: [...RAW_INPUT_CLASSES],
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.nth === undefined ? {} : { nth: request.nth }),
      ...(request.x === undefined ? {} : { x: request.x }),
      ...(request.y === undefined ? {} : { y: request.y }),
      ...(request.text === undefined ? {} : { text: request.text }),
      ...(request.key === undefined ? {} : { key: request.key }),
      ...(request.dy === undefined ? {} : { dy: request.dy }),
      ...(request.state === undefined ? {} : { state: request.state }),
      ...(request.append === undefined ? {} : { append: request.append }),
    }
    let raw: unknown
    try {
      raw = await this.deps.call('act', args, 20_000)
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? ((error as { code: string }).code) : 'failed'
      const message = error instanceof Error ? error.message : String(error)
      if (code === 'raw_input' || code === 'elevated') {
        const fromDesktop = await this.deps.desktop?.({ window, request })
        if (fromDesktop) return fromDesktop
        return refuse(code === 'elevated' ? 'elevated' : 'needs_agent_desktop', 'Needs the agent desktop: ' + message)
      }
      return refuse(code, message)
    }
    const answer = this.parse(raw, window)
    if (answer.ok) return this.shown(answer, who)

    // The program ignored everything posted. Say so; then the agent desktop, then (only if asked and allowed) the lock.
    const fromDesktop = await this.deps.desktop?.({ window, request })
    if (fromDesktop?.ok === true) return this.shown({ ...fromDesktop, tried: [...(answer.tried ?? []), ...(fromDesktop.tried ?? [])] }, who)
    if (request.realInput === true) return this.viaLock(request, window, answer)
    return { ...answer, ok: false, code: answer.code ?? 'ignored', message: answer.code === 'ignored' || answer.code === undefined ? 'This program ignores posted input: every rung was tried and nothing changed. It needs the agent desktop.' : answer.message }
  }

  private shown(answer: ScreenActAnswer, who: string): ScreenActAnswer {
    this.deps.cursor?.click(who)
    return answer
  }

  private parse(raw: unknown, window: ScreenWindow): ScreenActAnswer {
    const r = rec(raw) ?? {}
    const cursor = rec(r['cursor']) ?? {}
    const before = rec(cursor['before']) ?? {}
    const after = rec(cursor['after']) ?? {}
    const fg = rec(r['foreground']) ?? {}
    const taken = fg['taken'] === true
    const rung = typeof r['rung'] === 'string' ? r['rung'] : undefined
    const tookOn = typeof fg['tookOn'] === 'string' ? fg['tookOn'] : rung
    if (taken && tookOn !== undefined) this.deps.takers?.add(window.process, window.className, tookOn)
    const tried = (Array.isArray(r['tried']) ? (r['tried'] as unknown[]) : []).map((t) => ({ rung: text(rec(t)?.['rung'], 40), result: text(rec(t)?.['result'], 120) }))
    const ok = r['ok'] === true
    const point = rec(r['point'])
    const answer: ScreenActAnswer = {
      ok,
      ...(rung === undefined ? {} : { rung }),
      ...(typeof r['evidence'] === 'string' ? { evidence: r['evidence'] } : {}),
      ...(ok ? {} : { code: typeof r['reason'] === 'string' ? (r['reason'] as string) : 'ignored' }),
      message: ok ? 'Done through ' + String(rung) + '; seen: ' + text(r['evidence'], 40) + '.' : 'Nothing changed.',
      tried,
      focus: { taken, givenBack: fg['givenBack'] === true, lostMs: num(fg['lostMs']), ...(tookOn === undefined || !taken ? {} : { rung: tookOn }) },
      his: { cursorMoved: num(before['x']) !== num(after['x']) || num(before['y']) !== num(after['y']), foregroundChanged: typeof fg['before'] === 'string' && typeof fg['after'] === 'string' && fg['before'] !== fg['after'] },
      ...(typeof r['note'] === 'string' ? { note: r['note'] } : {}),
      ...(typeof r['value'] === 'string' ? { value: r['value'] } : {}),
      ...(typeof r['element'] === 'string' ? { element: r['element'] } : {}),
      ...(point === null ? {} : { point: { x: num(point['x']), y: num(point['y']) } }),
    }
    if (taken) answer.note = (answer.note === undefined ? '' : answer.note + ' ') + 'That program brought itself to the front on ' + String(tookOn) + (fg['givenBack'] === true ? '; his window was given back after ' + num(fg['lostMs']) + ' ms' : ' and his window could NOT be given back') + '. That rung is now skipped for this program.'
    return answer
  }

  /** Rung 6. Needs the setting AND the ask; goes through the lock, which tells him and waits for him to be idle. */
  private async viaLock(request: ScreenActRequest, window: ScreenWindow, posted: ScreenActAnswer): Promise<ScreenActAnswer> {
    const his = posted.his
    const ignored = { ...posted, ok: false, his }
    if (this.deps.lock === undefined || this.deps.lock === null || this.deps.realInputAllowed?.() !== true) {
      return { ...ignored, code: 'real_input_off', message: 'Posted input was ignored, and real input is switched off in Settings, so nothing more was tried.' }
    }
    const step = await this.stepFor(request, window)
    if ('error' in step) return { ...ignored, code: 'bad_request', message: step.error }
    const outcome = await this.deps.lock.request({ hwnd: window.hwnd, pid: window.pid, what: request.action.replace('_', ' ') + (request.name === undefined ? '' : ' "' + request.name + '"'), windowTitle: window.title.slice(0, 60) || window.process, steps: [step], owner: request.owner ?? 'The agent', ...(request.signal === undefined ? {} : { signal: request.signal }) })
    if (!outcome.ok) return { ...ignored, code: 'real_input_' + outcome.code, message: outcome.message }
    return { ok: true, rung: 'real:lock', message: 'Done with real input under the input lock' + (outcome.restored ? '; his pointer and window were put back.' : '; his pointer or window could NOT be put back.'), tried: posted.tried ?? [], his: { cursorMoved: !outcome.result.cursorRestored, foregroundChanged: !outcome.result.foregroundRestored } }
  }

  private async stepFor(request: ScreenActRequest, window: ScreenWindow): Promise<InjectStep | { error: string }> {
    let x = request.x
    let y = request.y
    if ((x === undefined || y === undefined) && request.name !== undefined) {
      const hit = rec(await this.deps.call('find', { hwnd: window.hwnd, name: request.name, ...(request.role === undefined ? {} : { role: request.role }), ...(request.nth === undefined ? {} : { nth: request.nth }) }))
      const node = rec(hit?.['node'])
      const b = rectOf(node?.['bounds'])
      if (node === null || b.width === 0) return { error: 'Nothing in that window is called "' + request.name + '".' }
      x = b.x + Math.round(b.width / 2) - window.rect.x
      y = b.y + Math.round(b.height / 2) - window.rect.y
    }
    switch (request.action) {
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'toggle':
      case 'select':
      case 'expand':
      case 'collapse':
        if (x === undefined || y === undefined) return { error: 'Say where: an element name, or x and y inside the window.' }
        return { do: request.action === 'double_click' || request.action === 'right_click' ? request.action : 'click', x, y }
      case 'type':
      case 'set_value':
        return { do: 'type', text: request.text ?? '' }
      case 'scroll':
        return { do: 'scroll', dy: request.dy ?? 300 }
      case 'key':
        return { do: 'key', key: request.key ?? '' }
    }
  }
}
