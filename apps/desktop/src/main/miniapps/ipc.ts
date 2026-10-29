/**
 * Mini-apps to the window (IPC) and to linked devices (RPC, the phone's WebView). The window runs each open app in a
 * sandboxed frame and passes on what the frame says, tagged with the session main gave it; main decides everything
 * (host.ts). Pins, order, allow and delete from here are his own hands, so they ask nothing.
 */
import type { MiniAppCheck } from '@agent/core'

import { MINIAPP_CHANNELS, MINIAPP_RPC } from '../../shared/miniapps-channels'
import type { IpcMainLike } from '../ipc'
import type { DevicesHost } from '../devices/types'
import type { MiniAppHost, Push } from './host'
import type { MiniAppStore } from './store'

export interface MiniAppIpcDeps {
  host: () => MiniAppHost | null
  apps: MiniAppStore
  /** Sends a message to the open frame of a session in the window. */
  push: (sessionId: string, message: Parameters<Push>[0]) => void
  check: (appId: string) => Promise<MiniAppCheck | null>
  /** Hands his words to his agent, naming the app ("Edit by asking"). */
  askChange: (appId: string, name: string, text: string) => Promise<void>
}

export function registerMiniAppIpc(ipcMain: IpcMainLike, deps: MiniAppIpcDeps): void {
  const id = (value: unknown): string => (typeof value === 'string' && value.length < 80 ? value : '')
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [MINIAPP_CHANNELS.session]: async (appId) => {
      const host = deps.host()
      if (host === null) return null
      // The session id is the address main pushes to; it is filled in once it exists.
      let sid = ''
      const opened = host.openSession(id(appId), (message) => {
        if (sid !== '') deps.push(sid, message)
      }, 'window')
      sid = opened ?? ''
      return opened
    },
    [MINIAPP_CHANNELS.send]: async (sessionId, message) => {
      const host = deps.host()
      if (host === null || typeof message !== 'object' || message === null) return null
      return host.handle(id(sessionId), message as Record<string, unknown>)
    },
    [MINIAPP_CHANNELS.close]: async (sessionId) => {
      deps.host()?.closeSession(id(sessionId))
    },
    [MINIAPP_CHANNELS.pin]: async (appId, position) => {
      await deps.apps.pin(id(appId), typeof position === 'number' ? position : undefined)
    },
    [MINIAPP_CHANNELS.unpin]: async (appId) => {
      await deps.apps.unpin(id(appId))
    },
    [MINIAPP_CHANNELS.order]: async (ids) => {
      if (Array.isArray(ids)) await deps.apps.setOrder(ids.map(id).filter(Boolean))
    },
    [MINIAPP_CHANNELS.remove]: async (appId) => {
      await deps.apps.remove(id(appId))
    },
    [MINIAPP_CHANNELS.undo]: async (appId) => {
      const done = await deps.apps.undo(id(appId), { by: 'you' })
      return done.ok ? (done.note ?? 'Done.') : done.why
    },
    [MINIAPP_CHANNELS.allow]: async (appId, key, on) => {
      if (typeof key === 'string' && key.length < 200) await deps.apps.setAllowed(id(appId), key, on === true)
    },
    [MINIAPP_CHANNELS.check]: async (appId) => deps.check(id(appId)),
    [MINIAPP_CHANNELS.askChange]: async (appId, text) => {
      const app = await deps.apps.find(id(appId))
      if (app !== null && typeof text === 'string' && text.trim() !== '') await deps.askChange(app.id, app.name, text.trim().slice(0, 4000))
    },
    [MINIAPP_CHANNELS.info]: async () => ({ engine: deps.host()?.engine.kind ?? 'off' }),
  }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (_event, ...args) => handler(...args))
}

/**
 * The phone shows an app in its own locked-down WebView and runs its bridge here: open a session, pass each message,
 * close. Events for that session go back to that device only. The same checks as the window's.
 */
export function registerMiniAppRpc(host: DevicesHost, deps: { host: () => MiniAppHost | null; apps: MiniAppStore }): void {
  const sessionsOf = new Map<string, Set<string>>()
  host.addRpc(MINIAPP_RPC.session, async (deviceId, args) => {
    const miniapps = deps.host()
    if (miniapps === null) throw new Error('Mini-apps are not running here.')
    const appId = typeof args[0] === 'string' ? args[0] : ''
    let sid = ''
    const opened = miniapps.openSession(appId, (message) => {
      if (sid !== '') host.emit(deviceId, MINIAPP_RPC.push, { session: sid, message })
    }, 'device')
    if (opened === null) throw new Error('No such app.')
    sid = opened
    const mine = sessionsOf.get(deviceId) ?? new Set<string>()
    mine.add(opened)
    sessionsOf.set(deviceId, mine)
    return opened
  })
  host.addRpc(MINIAPP_RPC.call, async (deviceId, args) => {
    const miniapps = deps.host()
    const sid = typeof args[0] === 'string' ? args[0] : ''
    // A device only talks to the sessions it opened.
    if (miniapps === null || !(sessionsOf.get(deviceId)?.has(sid) ?? false)) throw new Error('That app is closed.')
    const message = typeof args[1] === 'object' && args[1] !== null ? (args[1] as Record<string, unknown>) : {}
    return miniapps.handle(sid, message)
  })
  host.addRpc(MINIAPP_RPC.close, async (deviceId, args) => {
    const sid = typeof args[0] === 'string' ? args[0] : ''
    if (sessionsOf.get(deviceId)?.delete(sid) === true) deps.host()?.closeSession(sid)
    return true
  })
  host.addRpc(MINIAPP_RPC.pin, async (_deviceId, args) => {
    const done = await deps.apps.pin(typeof args[0] === 'string' ? args[0] : '', typeof args[1] === 'number' ? args[1] : undefined)
    return done.ok
  })
  host.addRpc(MINIAPP_RPC.unpin, async (_deviceId, args) => {
    const done = await deps.apps.unpin(typeof args[0] === 'string' ? args[0] : '')
    return done.ok
  })
}
