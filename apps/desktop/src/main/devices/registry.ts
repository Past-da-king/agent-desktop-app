/**
 * Every ipcMain.handle registration, kept by channel, so the same handler can also be called by name over the
 * wire (rpc.ts). main/index.ts passes its ipcMain through `recordHandlers` once; ipc.ts and the feature ipc files
 * are unchanged. A wire call reaches the handler with a stand-in event that names the calling device.
 */
import type { MessageOrigin } from './types'

export type Handler = (event: unknown, ...args: unknown[]) => unknown

export interface IpcRecorderTarget {
  handle(channel: string, listener: Handler): void
  removeHandler?(channel: string): void
  on?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/** The stand-in event a wire call hands the handler: no window, and who sent it. */
export interface WireEvent {
  sender: null
  wire: { deviceId: string; origin: MessageOrigin }
}

export class HandlerRegistry {
  private readonly handlers = new Map<string, Handler>()

  record(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener)
  }

  forget(channel: string): void {
    this.handlers.delete(channel)
  }

  get(channel: string): Handler | null {
    return this.handlers.get(channel) ?? null
  }

  has(channel: string): boolean {
    return this.handlers.has(channel)
  }
}

/** The app's one registry (main process). */
export const handlerRegistry = new HandlerRegistry()

/**
 * Wraps an ipcMain so every handler it registers is also kept in `registry`. Everything else passes through, so
 * the result is a drop-in ipcMain for registerIpc and the feature ipc files.
 */
export function recordHandlers<T extends IpcRecorderTarget>(ipc: T, registry: HandlerRegistry = handlerRegistry): T {
  return new Proxy(ipc, {
    get(target, prop, receiver) {
      if (prop === 'handle') {
        return (channel: string, listener: Handler): void => {
          registry.record(channel, listener)
          target.handle(channel, listener)
        }
      }
      if (prop === 'removeHandler') {
        return (channel: string): void => {
          registry.forget(channel)
          target.removeHandler?.(channel)
        }
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** The calling device when a handler runs for a wire call, else null (the window on this computer). */
export function wireOf(event: unknown): WireEvent['wire'] | null {
  if (typeof event !== 'object' || event === null) return null
  const wire = (event as { wire?: unknown }).wire
  if (typeof wire !== 'object' || wire === null) return null
  const value = wire as WireEvent['wire']
  return typeof value.deviceId === 'string' ? value : null
}
