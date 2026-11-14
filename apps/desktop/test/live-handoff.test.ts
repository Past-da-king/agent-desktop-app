import type { ChatItem } from '@agent/core'
import { describe, expect, it } from 'vitest'

import { foldLiveHandoffs, handoffsOfCall, isLiveHandoff } from '../src/renderer/lib/live'
import { liveFromInput, liveFromMeta, liveLabel, viaFromMeta } from '../src/shared/sender'
import { originWithLive } from '../src/main/devices/origin'
import { deviceCall } from '../src/main/voice/ipc'
import { callText } from '../src/main/voice/service'

function row(over: Partial<ChatItem> & { id: string }): ChatItem {
  return { kind: 'user', text: '', createdAt: 1, meta: '{}', ...over } as ChatItem
}

describe('live voice hand-off: wire contract', () => {
  it('reads origin and spoken at the top level, in meta, in metadata, or as one live object', () => {
    const want = { spoken: 'update the report', session: 's1' }
    expect(liveFromInput({ text: 'x', origin: 'live_voice', spoken: 'update the report', session: 's1' })).toEqual(want)
    expect(liveFromInput({ meta: { origin: 'live_voice', spoken: 'update the report', session: 's1' } })).toEqual(want)
    expect(liveFromInput({ metadata: JSON.stringify({ origin: 'live_voice', spoken: 'update the report', session: 's1' }) })).toEqual(want)
    expect(liveFromInput({ live: { spoken: 'update the report', session: 's1' } })).toEqual(want)
  })
  it('spoken and session are optional', () => {
    expect(liveFromInput({ origin: 'live_voice' })).toEqual({ spoken: '', session: '' })
  })
  it('anything else is his own message', () => {
    expect(liveFromInput({ text: 'hi' })).toBeNull()
    expect(liveFromInput({ origin: 'keyboard', spoken: 'x' })).toBeNull()
    expect(liveFromInput(undefined)).toBeNull()
    expect(liveFromInput('live_voice')).toBeNull()
  })
  it('rides on the origin, unchanged for ordinary sends', () => {
    const origin = { deviceId: 'd', name: 'A35', kind: 'phone', platform: 'android', screenWidth: 400, canOpenLinks: true, canReceiveFiles: true } as never
    expect(originWithLive(origin, { text: 'x' })).toBe(origin)
    expect(originWithLive(origin, { origin: 'live_voice', spoken: 'hello' })).toMatchObject({ name: 'A35', live: { spoken: 'hello', session: '' } })
  })
  it('the agent is told it is a paraphrase and what he actually said', () => {
    const label = liveLabel({ spoken: 'update the EOD', session: '' })
    expect(label).toContain('paraphrase')
    expect(label).toContain('He actually said: "update the EOD"')
    expect(liveLabel({ spoken: '', session: '' })).toContain('not kept')
  })
  it('keeps the call record: source, session and hand-offs', () => {
    const call = deviceCall({
      startedAt: 1000,
      durationMs: 90_000,
      lines: [{ who: 'you', text: 'hi', at: 1 }],
      source: 'live',
      session: 's1',
      handoffs: [{ request: 'Update the EOD report', spoken: 'do the EOD', at: 5 }, { request: '  ' }],
    })
    expect(call.source).toBe('live')
    expect(call.session).toBe('s1')
    expect(call.handoffs).toEqual([{ request: 'Update the EOD report', spoken: 'do the EOD', at: 5 }])
    expect(deviceCall({ startedAt: 1, durationMs: 0, lines: [] }).source).toBeUndefined()
    expect(callText(2, 180_000, true)).toBe('Live voice, 3 min')
    expect(callText(2, 180_000)).toBe('Call, 3 min')
  })
})

describe('live voice hand-off: the chat', () => {
  const live = (id: string, text: string, spoken: string, session: string, at: number): ChatItem =>
    row({ id, text, createdAt: at, meta: JSON.stringify({ via: { from: 'call', name: 'A35', chat: '' }, live: { spoken, session } }) })

  it('a stored hand-off reads as a call hand-off, never his own', () => {
    const r = live('a', 'Update the EOD report', 'do the EOD', 's1', 5)
    expect(isLiveHandoff(r)).toBe(true)
    expect(viaFromMeta(JSON.parse(r.meta))?.from).toBe('call')
    expect(liveFromMeta(JSON.parse(r.meta))).toEqual({ spoken: 'do the EOD', session: 's1' })
    expect(isLiveHandoff(row({ id: 'b', text: 'hello' }))).toBe(false)
  })
  it('folds into the saved call block with the same session; no standalone bubble remains', () => {
    const call = row({ id: 'c', kind: 'call', createdAt: 1, meta: JSON.stringify({ source: 'live', session: 's1', durationMs: 60_000, lines: [] }) })
    const out = foldLiveHandoffs([row({ id: 'u', text: 'mine', createdAt: 0 }), call, live('a', 'Update the EOD report', 'do the EOD', 's1', 5), live('b', 'Check mail', '', 's1', 9)])
    expect(out.map((r) => r.id)).toEqual(['u', 'c'])
    expect(handoffsOfCall(JSON.parse(out[1]!.meta))).toEqual([
      { request: 'Update the EOD report', spoken: 'do the EOD', at: 5 },
      { request: 'Check mail', spoken: '', at: 9 },
    ])
  })
  it('a session still going shows as one collapsed Live voice call block at its first hand-off', () => {
    const out = foldLiveHandoffs([live('a', 'One', 'uno', 's2', 5), row({ id: 'x', kind: 'agent', createdAt: 6 }), live('b', 'Two', '', 's2', 9)])
    expect(out.map((r) => [r.id, r.kind])).toEqual([
      ['a', 'call'],
      ['x', 'agent'],
    ])
    const meta = JSON.parse(out[0]!.meta) as Record<string, unknown>
    expect(meta['pending']).toBe(true)
    expect(handoffsOfCall(meta)).toHaveLength(2)
  })
  it('leaves a thread with no hand-offs alone', () => {
    const rows = [row({ id: 'u', text: 'hi' })]
    expect(foldLiveHandoffs(rows)).toBe(rows)
  })
})
