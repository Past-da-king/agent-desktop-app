/**
 * A view to put on screen (RouteTarget), read from untrusted input: the agent's app_action window.show, or the
 * window itself. Pure, so the main process and the renderer bridges check it the same way.
 */
import { ROUTE_VIEWS, type RouteTarget } from '@agent/core'

const ID = /^[A-Za-z0-9_.:-]{0,128}$/

/**
 * window.show and onRoute for a window with no main process of its own behind it (the browser preview, a linked
 * device's window): show puts the view on this window's own screen.
 */
export function localRoutes(): { show: (raw: RouteTarget) => Promise<boolean>; onRoute: (cb: (target: RouteTarget) => void) => () => void } {
  const listeners = new Set<(target: RouteTarget) => void>()
  return {
    show: async (raw) => {
      const target = parseRouteTarget(raw)
      if (target === null) return false
      for (const listener of [...listeners]) listener(target)
      return true
    },
    onRoute: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

/**
 * `{ view, id }`, or a plain chat id string. The main chat may be named `main` or ''. Anything else is null.
 * `view: 'chat'` also takes `chat` for the id, the way the agent tends to say it.
 */
export function parseRouteTarget(raw: unknown): RouteTarget | null {
  if (typeof raw === 'string') return parseRouteTarget({ view: 'chat', id: raw })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const view = input['view']
  if (typeof view !== 'string' || !(ROUTE_VIEWS as readonly string[]).includes(view)) return null
  const given = input['id'] ?? (view === 'chat' ? input['chat'] : undefined) ?? ''
  if (typeof given !== 'string') return null
  const id = given.trim()
  if (!ID.test(id)) return null
  if ((view === 'project' || view === 'helper') && id === '') return null
  return { view: view as RouteTarget['view'], id: view === 'chat' && id === 'main' ? '' : id }
}
