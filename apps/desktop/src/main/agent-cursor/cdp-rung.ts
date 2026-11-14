/**
 * The Chromium and Electron rung of screen_act (docs/agent-cursor.md, ladder step 3): the program was started with
 * --remote-debugging-port, so the page can be driven through the debugger. Input goes in as Input.dispatchMouseEvent,
 * dispatchKeyEvent and insertText: nothing touches his pointer, his keyboard or the window's focus (focus emulation makes
 * the page think it is focused). Every action is checked by reading the page afterwards.
 *
 * Coordinates arrive as SCREEN pixels (what the sidecar reports for an element) and are turned into page CSS pixels with
 * the page window's rectangle (probe `page`) and the page's devicePixelRatio.
 */

export interface CdpTarget {
  port: number
  /** The page window's rectangle in screen pixels (probe `page`). */
  page: { x: number; y: number; width: number; height: number }
  /** A part of the window title, to pick the right tab. */
  title?: string
}

export interface CdpResult {
  ok: boolean
  rung: 'cdp'
  evidence?: string
  reason?: string
}

interface Socket {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

export type SocketFactory = (url: string) => Socket

const defaultSocket: SocketFactory = (url) => new (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket(url)

export interface CdpDeps {
  fetchJson?: (url: string) => Promise<unknown>
  socket?: SocketFactory
}

export interface CdpAction {
  action: string
  /** Screen pixels of the element's middle, when there is one. */
  at?: { x: number; y: number }
  text?: string
  key?: string
  dy?: number
}

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

async function defaultFetch(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  return response.json()
}

/** Which actions this rung can do. Anything else goes on down the ladder. */
export function cdpCan(action: string): boolean {
  return ['click', 'double_click', 'right_click', 'type', 'set_value', 'key', 'scroll'].includes(action)
}

export async function cdpAct(target: CdpTarget, request: CdpAction, deps: CdpDeps = {}): Promise<CdpResult> {
  if (!cdpCan(request.action)) return { ok: false, rung: 'cdp', reason: `cdp does not do ${request.action}` }
  const getJson = deps.fetchJson ?? defaultFetch
  let list: unknown
  try {
    list = await getJson(`http://127.0.0.1:${target.port}/json`)
  } catch {
    return { ok: false, rung: 'cdp', reason: 'the debugger port did not answer' }
  }
  const pages = (Array.isArray(list) ? list : []).filter((p): p is { type: string; title: string; webSocketDebuggerUrl: string } => typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'page' && typeof (p as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === 'string')
  const wanted = (target.title ?? '').toLowerCase()
  const page = pages.find((p) => wanted !== '' && wanted.includes(String(p.title).toLowerCase()) && String(p.title) !== '') ?? pages[0]
  if (page === undefined) return { ok: false, rung: 'cdp', reason: 'no page to drive' }

  const socket = (deps.socket ?? defaultSocket)(page.webSocketDebuggerUrl)
  let nextId = 0
  const waiting = new Map<number, (value: { result?: unknown; error?: unknown }) => void>()
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('the debugger would not open')))
  })
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown }
      if (typeof message.id === 'number') waiting.get(message.id)?.(message)
    } catch {
      // not ours
    }
  })
  const send = (method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: unknown }> => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 6000)
      waiting.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expression: string): Promise<unknown> => {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true })
    const result = answer.result as { result?: { value?: unknown } } | undefined
    return result?.result?.value
  }

  try {
    await opened
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const ratio = Number(await evaluate('window.devicePixelRatio')) || 1
    const point = request.at === undefined ? null : { x: (request.at.x - target.page.x) / ratio, y: (request.at.y - target.page.y) / ratio }
    const mouse = async (type: string, params: Record<string, unknown>): Promise<void> => {
      await send('Input.dispatchMouseEvent', { type, x: point?.x ?? 0, y: point?.y ?? 0, ...params })
    }
    switch (request.action) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        if (point === null) return { ok: false, rung: 'cdp', reason: 'no place to click' }
        const button = request.action === 'right_click' ? 'right' : 'left'
        const clicks = request.action === 'double_click' ? 2 : 1
        const before = await evaluate(`(()=>{const e=document.elementFromPoint(${point.x},${point.y});return e?e.tagName+'|'+(e.id||'')+'|'+((e.innerText||e.value||'').slice(0,40)):''})()`)
        await mouse('mouseMoved', {})
        for (let n = 1; n <= clicks; n += 1) {
          await mouse('mousePressed', { button, clickCount: n })
          await mouse('mouseReleased', { button, clickCount: n })
        }
        return { ok: true, rung: 'cdp', evidence: `click delivered to ${String(before) || 'the page'} at ${Math.round(point.x)},${Math.round(point.y)}` }
      }
      case 'type':
      case 'set_value': {
        const text = request.text ?? ''
        if (point !== null) {
          await mouse('mousePressed', { button: 'left', clickCount: 1 })
          await mouse('mouseReleased', { button: 'left', clickCount: 1 })
        }
        if (request.action === 'set_value') {
          await evaluate('(()=>{const e=document.activeElement;if(e&&typeof e.select==="function")e.select();else document.execCommand("selectAll")})()')
        }
        await send('Input.insertText', { text })
        const held = await evaluate('(()=>{const e=document.activeElement;return e&&("value" in e)?String(e.value):(e?String(e.innerText||""):"")})()')
        const ok = typeof held === 'string' && (text === '' || held.includes(text) || (held.length > 0 && /^\*+$/.test(held)))
        return ok ? { ok: true, rung: 'cdp', evidence: 'the field holds the text now' } : { ok: false, rung: 'cdp', reason: 'ignored: the field does not hold the text after typing' }
      }
      case 'key': {
        const spec = KEYS[(request.key ?? '').toLowerCase()]
        if (spec === undefined) return { ok: false, rung: 'cdp', reason: `unknown key ${request.key ?? ''}` }
        const common = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk }
        await send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, ...(spec.text === undefined ? {} : { text: spec.text }) })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
        return { ok: true, rung: 'cdp', evidence: `key ${spec.key} delivered to the page` }
      }
      case 'scroll': {
        const before = Number(await evaluate('window.scrollY'))
        await mouse('mouseWheel', { deltaX: 0, deltaY: request.dy ?? 300 })
        await new Promise((resolve) => setTimeout(resolve, 150))
        const after = Number(await evaluate('window.scrollY'))
        return after !== before ? { ok: true, rung: 'cdp', evidence: `scrolled from ${before} to ${after}` } : { ok: false, rung: 'cdp', reason: 'ignored: the page did not move' }
      }
      default:
        return { ok: false, rung: 'cdp', reason: `cdp does not do ${request.action}` }
    }
  } catch (error) {
    return { ok: false, rung: 'cdp', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      socket.close()
    } catch {
      // already closed
    }
  }
}

/** The ladder step: needs the helper's `probe` (debug port, page rectangle) and `find` (the element's rectangle). */
export function makeCdpRung(
  call: (op: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
  deps: CdpDeps = {},
): (input: { window: { hwnd: string; title: string }; request: { action: string; name?: string; role?: string; nth?: number; x?: number; y?: number; text?: string; key?: string; dy?: number } }) => Promise<{ ok: boolean; rung: string; evidence: string; message: string; his: { cursorMoved: boolean; foregroundChanged: boolean } } | null> {
  const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const rect = (v: unknown): CdpTarget['page'] | null => {
    const r = rec(v)
    return typeof r['x'] === 'number' && typeof r['y'] === 'number' && typeof r['width'] === 'number' && typeof r['height'] === 'number' ? { x: r['x'], y: r['y'], width: r['width'], height: r['height'] } : null
  }
  return async ({ window, request }) => {
    if (!cdpCan(request.action)) return null
    const probe = rec(await call('probe', { hwnd: window.hwnd }))
    const port = typeof probe['debugPort'] === 'number' ? probe['debugPort'] : 0
    const page = rect(probe['page'])
    if (port <= 0 || page === null) return null
    let at: { x: number; y: number } | undefined
    if (request.name !== undefined && request.name !== '') {
      const node = rec(rec(await call('find', { hwnd: window.hwnd, name: request.name, nth: request.nth ?? 1, ...(request.role === undefined ? {} : { role: request.role }) }))['node'])
      const r = rect(node['bounds'])
      if (r === null) return null
      at = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    } else if (request.x !== undefined && request.y !== undefined) {
      const frame = rect(rec(await call('place', { hwnd: window.hwnd }))['bounds'])
      if (frame !== null) at = { x: frame.x + request.x, y: frame.y + request.y }
    }
    const done = await cdpAct({ port, page, title: window.title }, { action: request.action, ...(at === undefined ? {} : { at }), ...(request.text === undefined ? {} : { text: request.text }), ...(request.key === undefined ? {} : { key: request.key }), ...(request.dy === undefined ? {} : { dy: request.dy }) }, deps)
    if (!done.ok) return null
    return { ok: true, rung: `cdp:${request.action}`, evidence: done.evidence ?? '', message: `Done through the page debugger (${done.evidence ?? 'checked'}). His mouse, keyboard and focus were not used.`, his: { cursorMoved: false, foregroundChanged: false } }
  }
}
