/**
 * What the input lock (./input-lock.ts) needs from the app, made from the screen helper and a notice. Electron-free:
 * index.ts passes the toast. The helper's "inject" op does the real work and guards itself too.
 */
import type { InjectRequest, InjectResult, InputInjector, LockNotice, LockPresence } from './input-lock'

export interface LockHelper {
  call(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  idleMs(): Promise<number>
}

/** A toast with a way to say Not now (clicking it). Returns a function that closes it. */
export type ShowNotice = (title: string, body: string, onNotNow: () => void) => () => void

export function lockPresence(helper: LockHelper): LockPresence {
  return { idleMs: () => helper.idleMs().catch(() => -1) }
}

export function lockNotice(show: ShowNotice, timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }): LockNotice {
  return {
    ask: (notice, signal) =>
      new Promise((resolve) => {
        let done = false
        let timer: unknown = null
        const finish = (verdict: 'go' | 'not_now'): void => {
          if (done) return
          done = true
          if (timer !== null) timers.clear(timer)
          signal.removeEventListener('abort', onAbort)
          close()
          resolve(verdict)
        }
        const onAbort = (): void => finish('go')
        const close = show('Agent needs your mouse and keyboard', notice.text + ' Click here for Not now.', () => finish('not_now'))
        timer = timers.set(() => finish('go'), notice.graceMs)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
  }
}

const num = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0)

export function lockInjector(helper: LockHelper): InputInjector {
  return {
    inject: async (request: InjectRequest): Promise<InjectResult> => {
      const raw = (await helper.call('inject', { hwnd: request.hwnd, pid: request.pid, minIdleMs: request.minIdleMs, steps: request.steps }, 60_000)) as Record<string, unknown> | null
      const r = raw ?? {}
      return {
        done: num(r['done']),
        of: num(r['of']),
        aborted: r['aborted'] === true,
        ...(typeof r['why'] === 'string' ? { why: r['why'] } : {}),
        cursorRestored: r['cursorRestored'] === true,
        foregroundRestored: r['foregroundRestored'] === true,
      }
    },
  }
}
