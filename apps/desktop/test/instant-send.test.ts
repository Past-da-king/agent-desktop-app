/**
 * Instant send (19 Nov 2026, Ayanda: "never make me wait"): a dictated message is in the chat at once with its live
 * caption, the whole take is written down in the background, the row is replaced in place and only then does the agent
 * read it. A failed or too-slow pass gives the agent the caption plus a note and the row a Retry.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, MAIN_CHAT, providerFor } from '@agent/core'
import { afterEach, describe, expect, it } from 'vitest'

import { startFakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { PendingTakes, FAILED_NOTE } from '../src/main/dictation/pending'
import { Store } from '../src/main/db'
import { takeInput, wholeExtra } from '../src/main/voice/ipc'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function rig(batch: ConstructorParameters<typeof PendingTakes>[0]['batch']) {
  const fake = await startFakeAi(() => ({ text: 'Done.' }))
  const db = new Store(':memory:')
  const runner = new Runner({
    store: db,
    settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, agentName: 'Hina' }),
    secrets: secretsView('test-key'),
    tools: buildToolset({ store: db }),
    providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
    timeZone: 'UTC',
  })
  const dir = mkdtempSync(join(tmpdir(), 'takes-'))
  dirs.push(dir)
  const takes = new PendingTakes({
    dir,
    batch,
    replace: (take, text) => runner.refineDictated(take.id, text, true),
    retrying: (take) => runner.markRefining(take.id, take.chat),
    retryFailed: (take) => runner.refineDictated(take.id, '', false, take.chat),
    log: () => undefined,
  })
  runner.setTakes(takes)
  const close = async (): Promise<void> => {
    runner.dispose()
    await sleep(30)
    db.close()
    await fake.close()
  }
  return { fake, db, runner, takes, close }
}

const pcm = Buffer.alloc(32_000 * 20, 1)
const userRow = async (db: Store) => (await db.list('chat_item')).find((item) => item.kind === 'user')!

describe('instant send: the runner', () => {
  it('the message is in the chat at once marked pending; the agent reads the CLEAN text, never the caption', async () => {
    let release: (text: string) => void = () => undefined
    const { fake, db, runner, takes, close } = await rig(() => new Promise((resolve) => (release = (text) => resolve({ ok: true, text }))))
    try {
      await runner.sendDictated('construction head the the', [], MAIN_CHAT, undefined, 'take1')
      const first = await userRow(db)
      expect(first.text).toBe('construction head the the')
      expect(JSON.parse(first.meta).dictation).toEqual({ id: 'take1', pending: true })
      await sleep(150)
      expect(fake.requests.length).toBe(0) // the agent is waiting for the clean text
      await takes.accept({ id: 'take1', chat: MAIN_CHAT, live: 'construction head the the', pcm })
      await sleep(100)
      expect(fake.requests.length).toBe(0) // the pass is still running
      release('The letterhead? Because Strat Edge has its own letterhead.')
      await waitFor(() => !runner.state(MAIN_CHAT).running && fake.requests.length > 0, 8_000)
      const row = await userRow(db)
      expect(row.text).toBe('The letterhead? Because Strat Edge has its own letterhead.')
      expect(JSON.parse(row.meta).dictation).toEqual({ id: 'take1', pending: false, final: true })
      const prompt = JSON.stringify(fake.requests)
      expect(prompt).toContain('Strat Edge has its own letterhead')
      expect(prompt).not.toContain('construction head')
    } finally {
      await close()
    }
  }, 15_000)

  it('a failed pass: the agent gets the caption and the note, the row says failed (Retry)', async () => {
    const { fake, db, runner, takes, close } = await rig(async () => ({ ok: false, error: 'busy' }))
    try {
      await runner.sendDictated('what I heard live', [], MAIN_CHAT, undefined, 'take2')
      await takes.accept({ id: 'take2', chat: MAIN_CHAT, live: 'what I heard live', pcm })
      await waitFor(() => !runner.state(MAIN_CHAT).running && fake.requests.length > 0, 8_000)
      const prompt = JSON.stringify(fake.requests)
      expect(prompt).toContain('what I heard live')
      expect(prompt).toContain(FAILED_NOTE)
      expect(JSON.parse((await userRow(db)).meta).dictation).toEqual({ id: 'take2', pending: false, failed: true })
    } finally {
      await close()
    }
  }, 15_000)

  it('a Retry shows Refining again, and a Retry that fails again goes back to Sent as heard', async () => {
    let release: (value: { ok: false; error: string }) => void = () => undefined
    let calls = 0
    const { db, runner, takes, close } = await rig(async () => {
      calls += 1
      return calls === 1 ? { ok: false, error: 'busy' } : new Promise<{ ok: false; error: string }>((resolve) => (release = resolve))
    })
    try {
      await runner.sendDictated('caption', [], MAIN_CHAT, undefined, 'take4')
      await takes.accept({ id: 'take4', chat: MAIN_CHAT, live: 'caption', pcm })
      for (let i = 0; i < 200 && !JSON.parse((await userRow(db)).meta).dictation?.failed; i += 1) await sleep(20)
      expect(JSON.parse((await userRow(db)).meta).dictation).toEqual({ id: 'take4', pending: false, failed: true })
      expect(await takes.retry('take4')).toBe(true)
      expect(JSON.parse((await userRow(db)).meta).dictation).toEqual({ id: 'take4', pending: true })
      expect((await userRow(db)).text).toBe('caption')
      for (let i = 0; i < 200 && calls < 2; i += 1) await sleep(10)
      release({ ok: false, error: 'busy again' })
      for (let i = 0; i < 200 && JSON.parse((await userRow(db)).meta).dictation?.pending; i += 1) await sleep(20)
      expect(JSON.parse((await userRow(db)).meta).dictation).toEqual({ id: 'take4', pending: false, failed: true })
      expect((await userRow(db)).text).toBe('caption')
    } finally {
      await close()
    }
  }, 20_000)

  it('a retry that works replaces the row in place', async () => {
    let ok = false
    const { db, runner, takes, close } = await rig(async () => (ok ? { ok: true, text: 'Clean now' } : { ok: false, error: 'busy' }))
    try {
      await runner.sendDictated('caption', [], MAIN_CHAT, undefined, 'take3')
      await takes.accept({ id: 'take3', chat: MAIN_CHAT, live: 'caption', pcm })
      for (let i = 0; i < 200 && (await takes.state('take3'))?.state !== 'failed'; i += 1) await sleep(20)
      ok = true
      expect(await takes.retry('take3')).toBe(true)
      for (let i = 0; i < 200 && (await userRow(db)).text !== 'Clean now'; i += 1) await sleep(20)
      expect((await userRow(db)).text).toBe('Clean now')
      expect(JSON.parse((await userRow(db)).meta).dictation).toEqual({ id: 'take3', pending: false, final: true })
    } finally {
      await close()
    }
  }, 20_000)
})

describe('instant send: the phone contract', () => {
  it('voice.transcribe second argument {whole, names, languages}', () => {
    expect(wholeExtra({ whole: true, names: ['Strat Edge', 4, 'SEI'], languages: ['en-ZA', 'zu-ZA'] })).toEqual({ whole: true, names: ['Strat Edge', 'SEI'], languages: ['en-ZA', 'zu-ZA'] })
    expect(wholeExtra(undefined)).toBeUndefined()
    expect(wholeExtra({ names: ['x'] })).toBeUndefined()
  })
  it('voice.takeAudio input is checked', () => {
    expect(takeInput({ id: 'a-1', chat: 'main', audio: new Uint8Array(4), caption: 'hi', names: ['SEI'] })).toMatchObject({ id: 'a-1', chat: 'main', caption: 'hi', names: ['SEI'] })
    expect(takeInput({ id: 'a-1', retry: true })).toEqual({ id: 'a-1', retry: true })
    expect(() => takeInput({ id: '../x' })).toThrow()
    expect(() => takeInput(null)).toThrow()
  })
})
