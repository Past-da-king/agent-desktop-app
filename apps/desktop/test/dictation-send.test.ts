/**
 * 18 Nov 2026: a message sent while a dictation was still being written down left without those words (on the phone it
 * left with the live caption). Send now waits for the dictation and sends the draft that includes its words.
 */
import type { DictationView } from '@agent/core'
import { describe, expect, it, vi } from 'vitest'

import { dictatingFor, sendAfterDictation, type DictationIo } from '../src/renderer/voice/dictationSettle'

function io(start: DictationView | null) {
  let view = start
  const listeners = new Set<() => void>()
  const stop = vi.fn((_chat: string) => set({ ...(view as DictationView), phase: 'finishing' }))
  const set = (next: DictationView | null): void => {
    view = next
    for (const l of [...listeners]) l()
  }
  const api: DictationIo = {
    view: () => view,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    stop,
  }
  return { api, set, stop }
}
const v = (phase: DictationView['phase'], chat: string | null = 'main'): DictationView => ({ phase, clean: false, text: 'x', interim: '', message: '', switchKeys: '', chat })

describe('send while a dictation is being written down', () => {
  it('waits for the words to land, then sends once', async () => {
    const f = io(v('listening'))
    const send = vi.fn(); const held = vi.fn()
    const p = sendAfterDictation('main', f.api, send, held)
    await Promise.resolve()
    expect(f.stop).toHaveBeenCalledWith('main')
    expect(send).not.toHaveBeenCalled()
    f.set(v('cleaning')); await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    f.set(v('done')); await p
    expect(send).toHaveBeenCalledTimes(1); expect(held).not.toHaveBeenCalled()
  })
  it('sends nothing when the words could not be had', async () => {
    const f = io(v('finishing')); const send = vi.fn(); const held = vi.fn()
    const p = sendAfterDictation('main', f.api, send, held)
    f.set({ ...v('error'), canRetry: true }); await p
    expect(send).not.toHaveBeenCalled(); expect(held).toHaveBeenCalledWith('failed')
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('gives up at the limit without sending', async () => {
    vi.useFakeTimers()
    const f = io(v('finishing')); const send = vi.fn(); const held = vi.fn()
    const p = sendAfterDictation('main', f.api, send, held, 5000)
    await vi.advanceTimersByTimeAsync(5001); await p
    expect(send).not.toHaveBeenCalled(); expect(held).toHaveBeenCalledWith('timeout')
    vi.useRealTimers()
  })
  it('sends at once with no dictation, or one for another chat', async () => {
    for (const start of [null, v('listening', 'other'), v('done')]) {
      const send = vi.fn()
      await sendAfterDictation('main', io(start).api, send, vi.fn())
      expect(send).toHaveBeenCalledTimes(1)
    }
    expect(dictatingFor(v('listening', 'other'), 'main')).toBe(false)
  })
  it('a dictation dismissed meanwhile sends what is in the draft', async () => {
    const f = io(v('finishing')); const send = vi.fn()
    const p = sendAfterDictation('main', f.api, send, vi.fn())
    f.set(null); await p
    expect(send).toHaveBeenCalledTimes(1)
  })
})
