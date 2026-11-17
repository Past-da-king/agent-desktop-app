/**
 * A Live call is written into the main chat as it happens, under its session, as ONE call row; callSave at the end finishes
 * that row instead of adding a second; and the main agent reads the recent calls in full on its next turn.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ChatItem } from '@agent/core'

import { Store } from '../src/main/db'
import { liveCallSection, liveTurn, sessionOf } from '../src/main/runtime/live-calls'
import { SettingsStore } from '../src/main/settings'
import { deviceCall } from '../src/main/voice/ipc'
import { VoiceService } from '../src/main/voice/service'
import { RPC_ALLOWED } from '../src/shared/rpc-methods'

const T0 = 1_700_000_000_000

describe('live call turns in the main chat', () => {
  let dir = ''
  let store: Store
  let voice: VoiceService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-live-turns-'))
    store = new Store(join(dir, 'agent.db'))
    const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test' })
    voice = new VoiceService({
      secrets: { get: () => null, set: () => undefined, delete: () => undefined },
      settings,
      store,
      runner: { send: async () => undefined, state: () => ({ running: false, waiting: [] }) },
      emit: () => undefined,
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      now: () => T0,
    })
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const turn = (index: number, who: 'you' | 'agent', text: string, session = 'live-aaa') => liveTurn({ session, startedAt: T0, index, who, text, at: T0 + index * 1000 })
  const calls = async (): Promise<ChatItem[]> => (await store.list('chat_item')).filter((row) => row.kind === 'call')

  it('writes each turn as it finalises into ONE collapsed Live call row for the session', async () => {
    await voice.callTurn(turn(0, 'you', "Yo, my guy, did we upload Thuli's PDF to NSFAS?"))
    await voice.callTurn(turn(1, 'agent', 'On it.'))
    const rows = await calls()
    expect(rows).toHaveLength(1)
    expect(sessionOf(rows[0] as ChatItem)).toBe('live-aaa')
    const meta = JSON.parse((rows[0] as ChatItem).meta) as { lines: Array<{ who: string; text: string }>; source: string }
    expect(meta.source).toBe('live')
    expect(meta.lines.map((l) => l.text)).toEqual(["Yo, my guy, did we upload Thuli's PDF to NSFAS?", 'On it.'])
    // never a user bubble: nothing but the call row exists for the call's words
    expect((await store.list('chat_item')).filter((row) => row.kind === 'user')).toHaveLength(0)
  })

  it('a re-sent turn updates its line and two turns arriving together still make one row', async () => {
    await Promise.all([voice.callTurn(turn(0, 'you', 'Did we')), voice.callTurn(turn(1, 'agent', 'On it.'))])
    await voice.callTurn(turn(0, 'you', 'Did we upload it?'))
    const rows = await calls()
    expect(rows).toHaveLength(1)
    const meta = JSON.parse((rows[0] as ChatItem).meta) as { lines: Array<{ text: string }> }
    expect(meta.lines.map((l) => l.text)).toEqual(['Did we upload it?', 'On it.'])
  })

  it('voice.callSave at the end finishes the same row: no duplicate, hand-offs folded in', async () => {
    await voice.callTurn(turn(0, 'you', 'Upload the form'))
    await voice.callTurn(turn(1, 'agent', 'On it.'))
    const record = deviceCall({
      startedAt: T0,
      durationMs: 90_000,
      source: 'live',
      session: 'live-aaa',
      lines: [
        { who: 'you', text: 'Upload the form', at: T0 },
        { who: 'agent', text: 'On it.', at: T0 + 1000 },
        { who: 'you', text: 'Thanks', at: T0 + 2000 },
      ],
      handoffs: [{ request: 'Upload the form', spoken: 'Upload the form', at: T0 + 500 }],
    })
    await voice.callSave(record)
    const rows = await calls()
    expect(rows).toHaveLength(1)
    const meta = JSON.parse((rows[0] as ChatItem).meta) as { lines: unknown[]; handoffList: unknown[]; session: string }
    expect(meta.lines).toHaveLength(3)
    expect(meta.handoffList).toHaveLength(1)
    expect(meta.session).toBe('live-aaa')
    // a late re-send of a turn after the final record still lands on its own line
    await voice.callTurn(turn(2, 'you', 'Thanks a lot'))
    expect(await calls()).toHaveLength(1)
    expect(((JSON.parse(((await calls())[0] as ChatItem).meta) as { lines: Array<{ text: string }> }).lines)[2]?.text).toBe('Thanks a lot')
  })

  it('the main agent reads the real words of the call on its next turn (what did I ask on the call?)', async () => {
    await voice.callTurn(turn(0, 'you', "Yo, my guy, did we upload Thuli's PDF to NSFAS?"))
    await voice.callTurn(turn(1, 'agent', 'On it.'))
    const prompt = liveCallSection(await calls(), T0 + 60_000)
    expect(prompt).toContain("He said: Yo, my guy, did we upload Thuli's PDF to NSFAS?")
    expect(prompt).toContain('The voice said: On it.')
    expect(prompt).toContain('live-aaa')
    // an old call is no longer background; no call, no section
    expect(liveCallSection(await calls(), T0 + 3 * 24 * 3_600_000)).toBe('')
    expect(liveCallSection([], T0)).toBe('')
  })

  it('checks what a device sends and lets only a paired device call it', () => {
    expect(() => liveTurn({ session: '', startedAt: T0, index: 0, who: 'you', text: 'x', at: T0 })).toThrow()
    expect(() => liveTurn({ session: 's', startedAt: T0, index: 0, who: 'system', text: 'x', at: T0 })).toThrow()
    expect(() => liveTurn({ session: 's', startedAt: T0, index: -1, who: 'you', text: 'x', at: T0 })).toThrow()
    expect(RPC_ALLOWED.has('voice.callTurn')).toBe(true)
  })
})
