/**
 * 30 Oct 2026: a message box dictation of 1,980 characters was logged as 'inserted' and never reached his message. It
 * was typed into whatever had the focus, and nothing checked. Now the words go to the chat the microphone belongs to,
 * count as added only when that window answers, and otherwise stay offered back by the box, also after a restart.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { draftFromBox, draftHolds, joinDraft } from '../src/shared/box-draft'
import { BoxDelivery, dictationRoute, type BoxTarget } from '../src/main/dictation/box'
import { Recordings } from '../src/main/recordings/store'
import { DRAFT_FLUSH_MS, createDrafts, type DraftStorage } from '../src/renderer/state/useDrafts'

function memoryStorage(seed: Record<string, string> = {}): DraftStorage & { data: Map<string, string>; failing: boolean } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    failing: false,
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) {
      if (this.failing) throw new Error('quota')
      data.set(key, value)
    },
    removeItem: (key) => void data.delete(key),
  }
}

function fakeWindow(answer?: (message: { id: string }) => void): BoxTarget & { sent: unknown[]; fire(event: string): void } {
  const listeners = new Map<string, () => void>()
  return {
    sent: [],
    isDestroyed: () => false,
    send(_channel, payload) {
      this.sent.push(payload)
      answer?.(payload)
    },
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event) => listeners.delete(event),
    fire: (event) => listeners.get(event)?.(),
  }
}

describe('where a dictation goes', () => {
  it('the message box microphone always goes to its own chat, whatever window is in front', () => {
    expect(dictationRoute({ source: 'mic', chat: 'c1', ownWindow: true })).toEqual({ to: 'box', chat: 'c1' })
    expect(dictationRoute({ source: 'mic', chat: 'c1', ownWindow: false })).toEqual({ to: 'box', chat: 'c1' })
  })

  it('only the shortcut types into another app', () => {
    expect(dictationRoute({ source: 'shortcut', chat: null, ownWindow: false })).toEqual({ to: 'other-app' })
    expect(dictationRoute({ source: 'shortcut', chat: null, ownWindow: true })).toEqual({ to: 'here' })
  })
})

describe('words count as added only when the window says so', () => {
  const message = { id: 'r1', into: 'box' as const, chat: 'c1', text: 'hello' }
  afterEach(() => vi.useRealTimers())

  it('waits for the answer', async () => {
    const box = new BoxDelivery('ch')
    const window = fakeWindow((sent) => queueMicrotask(() => box.answer(sent.id, true)))
    await expect(box.deliver(window, message)).resolves.toBe('confirmed')
    expect(window.sent).toEqual([message])
  })

  it('a window that says no is not confirmed', async () => {
    const box = new BoxDelivery('ch')
    await expect(box.deliver(fakeWindow((sent) => queueMicrotask(() => box.answer(sent.id, false))), message)).resolves.toBe('refused')
  })

  it('no answer (the window is reloading) is not confirmed, and a late answer is told apart', async () => {
    vi.useFakeTimers()
    const box = new BoxDelivery('ch', 1000)
    const result = box.deliver(fakeWindow(), message)
    await vi.advanceTimersByTimeAsync(1001)
    await expect(result).resolves.toBe('timeout')
    expect(box.answer('r1', true)).toBe(false)
  })

  it('a window that crashes or closes on the way is not confirmed', async () => {
    const box = new BoxDelivery('ch')
    const window = fakeWindow()
    const crashed = box.deliver(window, message)
    window.fire('render-process-gone')
    await expect(crashed).resolves.toBe('gone')
    await expect(box.deliver({ ...fakeWindow(), isDestroyed: () => true }, message)).resolves.toBe('gone')
  })
})

describe('the box text', () => {
  it('a dictation only adds, with one space', () => {
    expect(joinDraft('', 'hello')).toBe('hello')
    expect(joinDraft('mine', 'hello')).toBe('mine hello')
    expect(joinDraft('mine\n', 'hello')).toBe('mine\nhello')
    expect(draftHolds('mine hello', 'hello')).toBe(true)
    expect(draftHolds('mine', 'hello')).toBe(false)
  })

  it('live words are shown, never stored as his text', () => {
    expect(draftFromBox('mine live words', 'mine', 'live words')).toBe('mine')
    expect(draftFromBox('mineX live words', 'mine', 'live words')).toBe('mineX')
    expect(draftFromBox('mi live words', 'mine', 'live words')).toBe('mi')
    expect(draftFromBox('mine live wordsX', 'mine', 'live words')).toBe('mineX')
    expect(draftFromBox('mine live', 'mine', 'live words')).toBe('mine')
    expect(draftFromBox('', 'mine', 'live words')).toBe('')
    expect(draftFromBox('typed', 'mine', '')).toBe('typed')
  })
})

describe('drafts, per chat and on disk', () => {
  it('a dictation reaches a chat that is not on screen and leaves the others alone', () => {
    const drafts = createDrafts(memoryStorage())
    drafts.getState().setText('open', 'typing here')
    expect(drafts.getState().addWords('other', 'for the other chat', 'r1')).toBe(true)
    expect(drafts.getState().texts['open']).toBe('typing here')
    expect(drafts.getState().texts['other']).toBe('for the other chat')
    expect(drafts.getState().added['other']).toBe(1)
  })

  it('survives a reload and a restart: the next store reads what the last one wrote', () => {
    const storage = memoryStorage()
    const first = createDrafts(storage)
    first.getState().setText('c1', 'half a thought')
    first.getState().addWords('c1', 'and the rest', 'r1')
    first.getState().setFiles('c1', [{ path: 'C:/a.txt', name: 'a.txt', mime: 'text/plain', size: 1 }])
    const second = createDrafts(storage)
    expect(second.getState().texts['c1']).toBe('half a thought and the rest')
    expect(second.getState().files['c1']?.[0]?.name).toBe('a.txt')
    expect(second.getState().applied('r1')).toBe(true)
  })

  it('the same recording is never added twice', () => {
    const drafts = createDrafts(memoryStorage())
    expect(drafts.getState().addWords('c1', 'once', 'r1')).toBe(true)
    expect(drafts.getState().addWords('c1', 'once', 'r1')).toBe(true)
    expect(drafts.getState().texts['c1']).toBe('once')
  })

  it('words that could not be stored are refused, so the box offers them back', () => {
    const storage = memoryStorage()
    const drafts = createDrafts(storage)
    storage.failing = true
    expect(drafts.getState().addWords('c1', 'nowhere', 'r1')).toBe(false)
    expect(drafts.getState().texts['c1']).toBeUndefined()
    expect(drafts.getState().applied('r1')).toBe(false)
    expect(createDrafts(null).getState().addWords('c1', 'no storage', 'r2')).toBe(false)
  })

  it('a message stays on disk until it was accepted, and comes back if it was refused', () => {
    const storage = memoryStorage()
    const drafts = createDrafts(storage)
    const key = 'agent.draft.v1.c1'
    drafts.getState().setText('c1', 'my message')
    drafts.getState().sending('c1')
    expect(drafts.getState().texts['c1']).toBe('')
    expect(storage.data.get(key)).toBe('my message')
    // A crash now: the next start has it.
    expect(createDrafts(storage).getState().texts['c1']).toBe('my message')
    drafts.getState().setText('c1', 'next one')
    expect(storage.data.get(key)).toBe('my message next one')
    drafts.getState().accepted('c1')
    expect(storage.data.get(key)).toBe('next one')
    drafts.getState().setText('c1', '')
    expect(storage.data.has(key)).toBe(false)

    drafts.getState().setText('c1', 'refused one')
    drafts.getState().sending('c1')
    drafts.getState().setText('c1', 'typed since')
    drafts.getState().refused('c1')
    expect(drafts.getState().texts['c1']).toBe('refused one typed since')
    expect(storage.data.get(key)).toBe('refused one typed since')
  })

  it('asks for the draft to reach the disk soon after a change, not at every key', () => {
    vi.useFakeTimers()
    try {
      let flushed = 0
      const drafts = createDrafts(memoryStorage(), () => void (flushed += 1))
      drafts.getState().setText('c1', 'a')
      drafts.getState().setText('c1', 'ab')
      expect(flushed).toBe(0)
      vi.advanceTimersByTime(DRAFT_FLUSH_MS)
      expect(flushed).toBe(1)
      drafts.getState().addWords('c1', 'said', 'r1')
      vi.advanceTimersByTime(DRAFT_FLUSH_MS)
      expect(flushed).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dictation landing while a message is on its way keeps both on disk', () => {
    const storage = memoryStorage()
    const drafts = createDrafts(storage)
    drafts.getState().setText('c1', 'going')
    drafts.getState().sending('c1')
    expect(drafts.getState().addWords('c1', 'just said', 'r1')).toBe(true)
    expect(drafts.getState().texts['c1']).toBe('just said')
    expect(storage.data.get('agent.draft.v1.c1')).toBe('going just said')
    drafts.getState().accepted('c1')
    expect(storage.data.get('agent.draft.v1.c1')).toBe('just said')
  })
})

describe('recordings that never reached the box', () => {
  const made: string[] = []
  const store = (): Recordings => {
    const root = mkdtempSync(join(tmpdir(), 'rec-box-'))
    made.push(root)
    return new Recordings({ root, flushMs: 10_000 })
  }
  afterEach(() => {
    for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const pcm = Buffer.alloc(3200, 1)

  it('a finished one is offered until it is confirmed, also from a new start', async () => {
    const recordings = store()
    const rec = recordings.begin({ source: 'mic', chat: 'c1', delivery: 'pending' })
    rec.audio(pcm)
    rec.words('so far')
    // Still on its way: not offered yet.
    expect(await recordings.undelivered()).toEqual([])
    await rec.stop()
    await rec.final('the final words')
    const after = new Recordings({ root: recordings.root })
    const list = await after.undelivered()
    expect(list.map((item) => [item.id, item.chat, item.text])).toEqual([[rec.id, 'c1', 'the final words']])
    await after.setDelivery(rec.id, 'confirmed')
    expect(await after.undelivered()).toEqual([])
    expect(await new Recordings({ root: recordings.root }).undelivered()).toEqual([])
  })

  it('confirmed right after the final words stays confirmed', async () => {
    const recordings = store()
    const rec = recordings.begin({ source: 'mic', chat: 'c1', delivery: 'pending' })
    rec.audio(pcm)
    await rec.stop()
    void rec.final('words')
    await rec.delivered('confirmed')
    await rec.flushed()
    expect(await recordings.undelivered()).toEqual([])
  })

  it('put away is not offered again', async () => {
    const recordings = store()
    const rec = recordings.begin({ source: 'mic', chat: 'c1', delivery: 'pending' })
    rec.audio(pcm)
    await rec.final('words')
    await recordings.setDelivery(rec.id, 'dismissed')
    expect(await recordings.undelivered()).toEqual([])
  })

  it('one he cancelled is not offered, in either way of cancelling; a Retry that finds the words is', async () => {
    const recordings = store()
    const listening = recordings.begin({ source: 'mic', chat: 'c1', delivery: 'pending' })
    listening.audio(pcm)
    listening.words('said')
    await listening.stop('cancelled')
    await listening.failed('Cancelled before the words were final.')
    const finishing = recordings.begin({ source: 'mic', chat: 'c2', delivery: 'pending' })
    finishing.audio(pcm)
    finishing.words('said too')
    await finishing.stop()
    await finishing.failed('Cancelled while the words were coming.', true)
    expect(await recordings.undelivered()).toEqual([])
    await finishing.final('retried words')
    expect((await recordings.undelivered()).map((item) => item.text)).toEqual(['retried words'])
  })

  it('one that failed with some words offers those; one with none offers nothing yet', async () => {
    const recordings = store()
    const some = recordings.begin({ source: 'mic', chat: 'c1', delivery: 'pending' })
    some.audio(pcm)
    some.words('the part it heard')
    await some.stop()
    await some.failed('No words came back.')
    const none = recordings.begin({ source: 'mic', chat: 'c2', delivery: 'pending' })
    none.audio(pcm)
    await none.stop()
    await none.failed('No words came back.')
    expect((await recordings.undelivered()).map((item) => item.text)).toEqual(['the part it heard'])
  })

  it('a crash while recording: recovered, then offered with its words', async () => {
    const recordings = store()
    const rec = recordings.begin({ source: 'mic', chat: 'c1', delivery: 'pending' })
    rec.audio(pcm)
    rec.words('before the crash')
    await rec.flushed()
    const after = new Recordings({ root: recordings.root })
    expect(await after.undelivered()).toEqual([])
    const { words } = await after.recover({ transcribe: async () => ({ ok: true, text: 'whole words from the audio' }) })
    await words
    expect((await after.undelivered()).map((item) => item.text)).toEqual(['whole words from the audio'])
  })

  it('recordings from before this, or for another app, are never offered', async () => {
    const recordings = store()
    const old = recordings.begin({ source: 'mic', chat: 'c1' })
    old.audio(pcm)
    await old.final('from before the fix')
    const other = recordings.begin({ source: 'shortcut', target: 'another app' })
    other.audio(pcm)
    await other.final('typed in another app')
    expect(await recordings.undelivered()).toEqual([])
  })
})
