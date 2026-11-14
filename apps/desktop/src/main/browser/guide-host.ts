/**
 * The guide's way into a tab: every frame of the page, cross-site ones included, each with the guide's own isolated
 * world, over the tab's debugger (guide.ts runs the loop over this). A cross-site frame lives in its own process; the
 * debugger reaches it through the flat session auto-attach opens for it (the Vault uses the same sessions). Kept to a
 * small link so it is tested without Electron.
 */
import { GUIDE_REPORT_BINDING, GUIDE_WORLD, parseReport, type GuideReport } from './guide-page'
import type { GuideFrame } from './guide'

/** The parts of a page's debugger the guide uses (vault-link.ts debuggerLink is one). */
export interface GuideLink {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
}

interface FrameNode {
  id: string
  url: string
  children: FrameNode[]
}

/**
 * The sessions of a tab's cross-site frames, kept from the moment the tab's debugger is set up (before the Vault
 * turns auto-attach on, so none is missed). One per tab.
 */
export class FrameSessions {
  private readonly sessions = new Map<string, { targetId: string; url: string; parent: string }>()
  private readonly off: () => void
  private readonly contexts = new Map<string, number>()
  private readonly reportListeners = new Set<(report: GuideReport) => void>()
  private binding = false

  constructor(private readonly link: GuideLink) {
    this.off = link.onEvent((method, params, rawSession) => {
      const sessionId = rawSession === '' ? undefined : rawSession
      if (method === 'Target.attachedToTarget') {
        const info = (params['targetInfo'] ?? {}) as Record<string, unknown>
        const sid = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
        if (sid !== '' && info['type'] === 'iframe') {
          // The session that announced it is the one its frame element lives in (the top page's: '').
          this.sessions.set(sid, { targetId: String(info['targetId'] ?? ''), url: String(info['url'] ?? ''), parent: sessionId ?? '' })
          if (this.binding) void this.bind(sid)
          // A cross-site frame inside a cross-site frame gets a session of its own too.
          void link.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }, sid).catch(() => undefined)
        }
      } else if (method === 'Target.detachedFromTarget') {
        const sid = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
        this.sessions.delete(sid)
        for (const key of [...this.contexts.keys()]) if (key.startsWith(`${sid}|`)) this.contexts.delete(key)
      } else if (method === 'Runtime.executionContextDestroyed') {
        const id = Number(params['executionContextId'])
        for (const [key, ctx] of this.contexts) if (ctx === id && key.startsWith(`${sessionId ?? ''}|`)) this.contexts.delete(key)
      } else if (method === 'Runtime.executionContextsCleared') {
        for (const key of [...this.contexts.keys()]) if (key.startsWith(`${sessionId ?? ''}|`)) this.contexts.delete(key)
      } else if (method === 'Runtime.bindingCalled') {
        if (params['name'] !== GUIDE_REPORT_BINDING || this.reportListeners.size === 0) return
        const report = parseReport(params['payload'])
        if (report !== null) for (const listener of [...this.reportListeners]) listener(report)
      } else if (method === 'Page.frameNavigated') {
        const frame = (params['frame'] ?? {}) as Record<string, unknown>
        this.contexts.delete(`${sessionId ?? ''}|${String(frame['id'] ?? '')}`)
      }
    })
  }

  /** Turns auto-attach on for the page (harmless when the Vault already did). */
  async start(): Promise<void> {
    await this.link.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }).catch(() => undefined)
  }

  stop(): void {
    this.off()
    this.reportListeners.clear()
  }

  /**
   * Hears every frame's report of where its target is (a step drawn outside the page). The report function exists
   * only in the guide's own world of each frame, never in the site's.
   */
  onReport(listener: (report: GuideReport) => void): () => void {
    this.reportListeners.add(listener)
    if (!this.binding) {
      this.binding = true
      void this.bind(undefined)
      for (const sid of this.sessions.keys()) void this.bind(sid)
    }
    return () => {
      this.reportListeners.delete(listener)
    }
  }

  private async bind(sid: string | undefined): Promise<void> {
    await this.link.send('Runtime.addBinding', { name: GUIDE_REPORT_BINDING, executionContextName: GUIDE_WORLD }, sid).catch(() => undefined)
  }

  /**
   * Where a frame's viewport is inside the TOP page's viewport (CSS px): the content box of each frame element on
   * the way up. Within one process the debugger answers in that process's root viewport, so only the frame's own
   * element and then one element per cross-site hop are read. Null when it cannot be worked out (a frame gone).
   */
  async frameBox(key: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const bar = key.indexOf('|')
    let sid = key.slice(0, bar)
    const frameId = key.slice(bar + 1)
    let x = 0
    let y = 0
    let size: { width: number; height: number } | null = null
    const add = async (frame: string, inSession: string): Promise<boolean> => {
      const box = await this.ownerBox(frame, inSession).catch(() => null)
      if (box === null) return false
      x += box.x
      y += box.y
      if (size === null) size = { width: box.width, height: box.height }
      return true
    }
    const root = sid === '' ? null : (this.sessions.get(sid)?.targetId ?? null)
    if (sid === '' || frameId !== root) {
      // A frame inside its process's root page.
      if (!(await add(frameId, sid))) return null
    }
    for (let hops = 0; sid !== '' && hops < 8; hops++) {
      const info = this.sessions.get(sid)
      if (info === undefined) return null
      if (!(await add(info.targetId, info.parent))) return null
      sid = info.parent
    }
    const got = size as { width: number; height: number } | null
    return got === null ? null : { x, y, width: got.width, height: got.height }
  }

  private async ownerBox(frameId: string, sid: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const session = sid === '' ? undefined : sid
    const owner = (await this.link.send('DOM.getFrameOwner', { frameId }, session)) as Record<string, unknown>
    const backendNodeId = Number(owner?.['backendNodeId'])
    if (!Number.isFinite(backendNodeId)) return null
    const got = (await this.link.send('DOM.getBoxModel', { backendNodeId }, session)) as Record<string, unknown>
    const quad = ((got?.['model'] ?? {}) as Record<string, unknown>)['content']
    if (!Array.isArray(quad) || quad.length < 8 || !quad.every((n) => typeof n === 'number')) return null
    const q = quad as number[]
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!]
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!]
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
  }

  /** Every frame, in page order: the top page's tree, with each cross-site frame's own tree put in its place. */
  async frames(): Promise<GuideFrame[]> {
    const top = await this.tree(undefined)
    const bySession = new Map<string, { sid: string; tree: FrameNode | null }>()
    await Promise.all(
      [...this.sessions].map(async ([sid, info]) => {
        bySession.set(info.targetId, { sid, tree: await this.tree(sid).catch(() => null) })
      }),
    )
    const out: GuideFrame[] = []
    const used = new Set<string>()
    const walk = (node: FrameNode, sid: string | undefined, isTop: boolean): void => {
      const remote = sid === undefined ? bySession.get(node.id) : undefined
      if (remote !== undefined && remote.tree !== null && !used.has(remote.sid)) {
        used.add(remote.sid)
        walk(remote.tree, remote.sid, false)
        return
      }
      out.push({ key: `${sid ?? ''}|${node.id}`, url: node.url, top: isTop })
      for (const child of node.children) walk(child, sid, false)
    }
    if (top !== null) walk(top, undefined, true)
    // Cross-site frames the top tree does not list (one inside another): after the rest.
    for (const { sid, tree } of bySession.values()) if (tree !== null && !used.has(sid)) {
      used.add(sid)
      walk(tree, sid, false)
    }
    return out
  }

  /** Runs a guide script in a frame's guide world, awaiting its promise. A world gone with its document is made again once. */
  async evaluate(key: string, code: string): Promise<unknown> {
    const contextId = await this.context(key)
    const sid = key.slice(0, key.indexOf('|'))
    const answer = (await this.link.send('Runtime.evaluate', { expression: code, contextId, awaitPromise: true, returnByValue: true }, sid === '' ? undefined : sid)) as Record<string, unknown>
    const exception = answer?.['exceptionDetails'] as Record<string, unknown> | undefined
    if (exception === undefined) return (answer?.['result'] as Record<string, unknown> | undefined)?.['value']
    const text = String((exception['exception'] as Record<string, unknown> | undefined)?.['description'] ?? exception['text'] ?? 'the script failed')
    throw new Error(text.slice(0, 300))
  }

  /** Called when an evaluate failed because the world went: it is made again on the next call. */
  forget(key: string): void {
    this.contexts.delete(key)
  }

  private async context(key: string): Promise<number> {
    const known = this.contexts.get(key)
    if (known !== undefined) return known
    const bar = key.indexOf('|')
    const sid = key.slice(0, bar)
    const frameId = key.slice(bar + 1)
    const made = (await this.link.send('Page.createIsolatedWorld', { frameId, worldName: GUIDE_WORLD, grantUniveralAccess: false }, sid === '' ? undefined : sid)) as Record<string, unknown>
    const id = Number(made?.['executionContextId'])
    if (!Number.isFinite(id)) throw new Error('No world for that frame.')
    this.contexts.set(key, id)
    return id
  }

  private async tree(sid: string | undefined): Promise<FrameNode | null> {
    const raw = (await this.link.send('Page.getFrameTree', {}, sid)) as Record<string, unknown>
    const conv = (entry: unknown): FrameNode | null => {
      const o = (entry ?? {}) as Record<string, unknown>
      const frame = (o['frame'] ?? {}) as Record<string, unknown>
      if (typeof frame['id'] !== 'string') return null
      const kids = Array.isArray(o['childFrames']) ? o['childFrames'].map(conv).filter((x): x is FrameNode => x !== null) : []
      return { id: frame['id'], url: String(frame['url'] ?? ''), children: kids }
    }
    return conv(raw?.['frameTree'])
  }
}

/**
 * evaluate with one retry when the frame's world was already gone when asked (a document that changed since the world
 * was made). A world destroyed WHILE a script waits in it is not retried: that is the page navigating, and the
 * guide reads it as such.
 */
export async function evaluateIn(frames: FrameSessions, key: string, code: string): Promise<unknown> {
  try {
    return await frames.evaluate(key, code)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/Cannot find context|No world|No frame with given id/i.test(message)) throw error
    frames.forget(key)
    return frames.evaluate(key, code)
  }
}
