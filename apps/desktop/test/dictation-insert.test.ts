import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { insertBounded, type InsertTarget } from '../src/main/dictation/insert'

/** A window's webContents whose insert the test settles, or never settles (a renderer that died mid-insert). */
function target(settle: 'ok' | 'never' | 'reject' | 'throw' = 'never'): InsertTarget & { emitter: EventEmitter; destroyed: boolean; inserted: string[] } {
  const emitter = new EventEmitter()
  const self = {
    emitter,
    destroyed: false,
    inserted: [] as string[],
    insertText(text: string): Promise<void> {
      if (settle === 'throw') throw new Error('Object has been destroyed')
      self.inserted.push(text)
      if (settle === 'ok') return Promise.resolve()
      if (settle === 'reject') return Promise.reject(new Error('no'))
      return new Promise<void>(() => undefined)
    },
    isDestroyed: () => self.destroyed,
    once: (event: string, listener: () => void) => emitter.once(event, listener),
    removeListener: (event: string, listener: () => void) => emitter.removeListener(event, listener),
  }
  return self
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('insertBounded', () => {
  it('reports inserted when the window takes the words, and leaves no listeners behind', async () => {
    const t = target('ok')
    await expect(insertBounded(t, 'hello')).resolves.toBe('inserted')
    expect(t.inserted).toEqual(['hello'])
    expect(t.emitter.listenerCount('render-process-gone')).toBe(0)
    expect(t.emitter.listenerCount('destroyed')).toBe(0)
  })

  it('ends at once when the renderer crashes while the words are on their way (27 Oct 2026)', async () => {
    const t = target('never')
    const result = insertBounded(t, 'Create the SharePoint file.')
    t.emitter.emit('render-process-gone')
    await expect(result).resolves.toBe('gone')
  })

  it('ends when the window is destroyed mid-insert', async () => {
    const t = target('never')
    const result = insertBounded(t, 'x')
    t.emitter.emit('destroyed')
    await expect(result).resolves.toBe('gone')
  })

  it('never waits past the limit, even when nothing says the renderer went', async () => {
    const t = target('never')
    const result = insertBounded(t, 'x', 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(result).resolves.toBe('timeout')
  })

  it('does not try a window that is already gone, and survives an insert that throws or rejects', async () => {
    const gone = target('ok')
    gone.destroyed = true
    await expect(insertBounded(gone, 'x')).resolves.toBe('gone')
    expect(gone.inserted).toEqual([])
    await expect(insertBounded(target('throw'), 'x')).resolves.toBe('failed')
    await expect(insertBounded(target('reject'), 'x')).resolves.toBe('failed')
  })
})
