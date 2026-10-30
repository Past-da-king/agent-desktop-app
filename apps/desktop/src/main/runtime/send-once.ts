/**
 * chat.sendOnce (docs/devices-protocol.md s8): a phone's message that carries its own id, so the phone can try the next
 * brain when one stops answering and the message still runs exactly once.
 *
 * - Answered as soon as the message is stored and its turn holds a lease, never after the run. That is what lets the
 *   phone give up on a frozen brain within seconds; chat.send only answers when the whole turn has ended.
 * - The user row and the lease take ids from the phone's id, so two brains can only ever write the same two rows.
 * - A frame that sat in the socket while this brain was frozen is dropped when the caller has gone (it was given to
 *   another brain) or when it is too old to be sure. A phone still connected hears `stale` and repeats it with `fresh`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface SendScope {
  rowId: string
  leaseId: string
  /** The first user row of this send has been written (later ones in the run are ordinary rows). */
  rowUsed: boolean
  /** A new turn will say when it is accepted, after its lease is stored. */
  viaBegin: boolean
  accepted: () => void
}

/** The send this code is running for, so the id reaches the row and the lease through every route a message can take. */
export const sendScope = new AsyncLocalStorage<SendScope>()

/** Long enough for a close already on its way to be read once the thread is free. */
export const SEND_SETTLE_MS = 200
/** A frame older than this may already be with another brain. The phone gives up on a brain well before it. */
export const SEND_MAX_AGE_MS = 15_000

const SEND_ID = /^[A-Za-z0-9_-]{8,64}$/

export function sendRowId(sendId: string): string {
  return `send-${sendId}`
}

export function sendLeaseId(sendId: string): string {
  return `lease-send-${sendId}`
}

export interface SendOnceResult {
  accepted: boolean
  duplicate?: boolean
  stale?: boolean
}

export interface SendOnceDeps {
  exists: (rowId: string) => Promise<boolean>
  now?: () => number
  settleMs?: number
  log?: (error: unknown) => void
}

export interface SendOnceCall {
  sendId: unknown
  sentAt?: unknown
  fresh?: boolean
  isOpen?: (() => boolean) | undefined
}

export function makeSendOnce(deps: SendOnceDeps): (call: SendOnceCall, send: () => Promise<void>) => Promise<SendOnceResult> {
  const now = deps.now ?? Date.now
  const going = new Map<string, Promise<SendOnceResult>>()
  return async (call, send) => {
    const sendId = call.sendId
    if (typeof sendId !== 'string' || !SEND_ID.test(sendId)) throw new Error('A bad send id.')
    const received = now()
    await new Promise((resolve) => setTimeout(resolve, deps.settleMs ?? SEND_SETTLE_MS))
    if (call.isOpen?.() === false) throw new Error('The caller has gone.')
    const same = going.get(sendId)
    if (same !== undefined) return { ...(await same), duplicate: true }
    if (await deps.exists(sendRowId(sendId))) return { accepted: true, duplicate: true }
    if (call.fresh !== true && typeof call.sentAt === 'number' && received - call.sentAt > SEND_MAX_AGE_MS) return { accepted: false, stale: true }
    const work = new Promise<SendOnceResult>((resolve, reject) => {
      const scope: SendScope = { rowId: sendRowId(sendId), leaseId: sendLeaseId(sendId), rowUsed: false, viaBegin: false, accepted: () => resolve({ accepted: true }) }
      sendScope.run(scope, () => {
        send().then(
          // Sent on elsewhere ('@Acme ...') or to nothing to do: done is accepted too.
          () => resolve({ accepted: true }),
          (error: unknown) => {
            // Before it was accepted the phone hears why. After that the run's own error is in the chat.
            reject(error instanceof Error ? error : new Error(String(error)))
            deps.log?.(error)
          },
        )
      })
    })
    going.set(sendId, work)
    try {
      return await work
    } finally {
      going.delete(sendId)
    }
  }
}
