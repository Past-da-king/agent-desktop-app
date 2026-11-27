/**
 * Voice notes when a Gemini key runs out of allowance (27 Nov 2026).
 *
 * Google's free speech allowance is ten calls a day per speech model per key. One exhausted key used to take every
 * voice note down until midnight in California, although the Vault held backup keys made for exactly that. A note now
 * walks the ordered list (the voice key in Settings, then the Vault backups named
 * "Gemini API key: A.O.S voice-note backup ..."), a key that answers 429 / RESOURCE_EXHAUSTED rests until its
 * allowance is back, and only when every key rests does the note fail.
 *
 * Everything here is a fake provider and a real store on disk: no network, no key leaves the test.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { SettingsStore } from '../src/main/settings'
import { VaultStore } from '../src/main/vault/store'
import { quotaOf } from '../src/main/voice/gemini'
import { BACKUP_PREFIX, MAX_REST_MS, SHORT_REST_MS, VoiceKeyring, fingerprint, nextPacificMidnight, restUntil, vaultBackupKeys } from '../src/main/voice/keyring'
import { VoiceService } from '../src/main/voice/service'

const DAILY = 'Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per day on Free Tier). Please retry in 9h29m19s'
const PER_MINUTE = 'Rate limit exceeded for model gemini-3.8-flash-tts (limit: 10 requests per minute on Free Tier). Please retry in 30s'
const AUDIO = Buffer.alloc(4800, 7).toString('base64')

/** A fake Gemini: each key can be told to answer out of quota, and every request is kept. */
function fakeGemini() {
  const state = new Map<string, 'day' | 'minute' | 'reject'>()
  const calls: Array<{ key: string; url: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const key = headers['x-goog-api-key'] ?? ''
    calls.push({ key, url })
    if (url.includes('/models?')) {
      if (state.get(key) === 'reject') return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 })
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash-tts' }, { name: 'models/gemini-3.1-flash-tts-preview' }] }))
    }
    const answer = state.get(key)
    if (answer === 'reject') return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 })
    if (answer !== undefined) {
      return new Response(
        JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: answer === 'day' ? DAILY : PER_MINUTE } }),
        { status: 429 },
      )
    }
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: AUDIO }] }] }))
  }) as typeof fetch
  return { fetchImpl, calls, state, said: () => calls.filter((call) => call.url.includes('/interactions')).map((call) => call.key) }
}

describe('a voice note when a key runs out', () => {
  let dir = ''
  let store: Store
  let settings: SettingsStore
  let secrets: Map<string, string>
  let clock = 0
  let gemini: ReturnType<typeof fakeGemini>

  const service = (backups: string[]): VoiceService =>
    new VoiceService({
      secrets: {
        get: (name: string) => secrets.get(name) ?? null,
        set: (name: string, value: string) => void secrets.set(name, value),
        delete: (name: string) => void secrets.delete(name),
      },
      settings,
      store,
      runner: { send: async () => undefined, state: () => ({ running: false, waiting: [] }) },
      emit: () => undefined,
      now: () => clock,
      platform: 'linux',
      notesDir: join(dir, 'voice-notes'),
      backupKeys: () => backups,
      fetchImpl: gemini.fetchImpl,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-voice-keys-'))
    store = new Store(join(dir, 'agent.db'))
    settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test' })
    secrets = new Map()
    // 27 Nov 2026, 22:45 UTC: the middle of the afternoon in California.
    clock = Date.UTC(2026, 10, 27, 22, 45)
    gemini = fakeGemini()
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('says the same script with the next key when the first is out of quota', async () => {
    const voice = service(['backup-one', 'backup-two'])
    voice.setKey('main-key')
    gemini.state.set('main-key', 'day')

    const made = await voice.note('Morning. Two quick ones.', 'warm')
    expect(made.ok).toBe(true)
    // The main key was tried first, then the first backup said the note.
    expect(gemini.said()).toEqual(['main-key', 'backup-one'])
  })

  it('never asks the exhausted key again for the rest of the day', async () => {
    const voice = service(['backup-one'])
    voice.setKey('main-key')
    gemini.state.set('main-key', 'day')
    expect((await voice.note('One.', '')).ok).toBe(true)
    gemini.calls.length = 0

    expect((await voice.note('Two.', '')).ok).toBe(true)
    // Not one request carried the exhausted key, not even the model listing.
    expect(gemini.calls.filter((call) => call.key === 'main-key')).toEqual([])
    expect(gemini.said()).toEqual(['backup-one'])
  })

  it('tries the exhausted key again once the daily quota has reset', async () => {
    const voice = service(['backup-one'])
    voice.setKey('main-key')
    gemini.state.set('main-key', 'day')
    expect((await voice.note('One.', '')).ok).toBe(true)

    // A minute before the next midnight in California it is still resting.
    clock = nextPacificMidnight(clock) - 60_000
    gemini.calls.length = 0
    expect((await voice.note('Two.', '')).ok).toBe(true)
    expect(gemini.said()).toEqual(['backup-one'])

    // The allowance is back, so the voice key speaks again.
    clock = nextPacificMidnight(clock)
    gemini.state.delete('main-key')
    gemini.calls.length = 0
    expect((await voice.note('Three.', '')).ok).toBe(true)
    expect(gemini.said()[0]).toBe('main-key')
  })

  it('rests a key for a minute after a per-minute limit, not for a day', async () => {
    const voice = service(['backup-one'])
    voice.setKey('main-key')
    gemini.state.set('main-key', 'minute')
    expect((await voice.note('One.', '')).ok).toBe(true)

    // The refusal asked for 30 seconds, so 29 later the key is still resting.
    clock += 29_000
    gemini.calls.length = 0
    expect((await voice.note('Two.', '')).ok).toBe(true)
    expect(gemini.said()).toEqual(['backup-one'])

    clock += 2_000
    gemini.state.delete('main-key')
    gemini.calls.length = 0
    expect((await voice.note('Three.', '')).ok).toBe(true)
    expect(gemini.said()[0]).toBe('main-key')
  })

  it('fails only when every key is out of quota, and says so plainly', async () => {
    const voice = service(['backup-one'])
    voice.setKey('main-key')
    gemini.state.set('main-key', 'day')
    gemini.state.set('backup-one', 'day')

    const made = await voice.note('One.', '')
    expect(made.ok).toBe(false)
    if (made.ok) throw new Error('unreachable')
    expect(made.error).toContain('Every Gemini key')
    // Each key was asked once; with both resting nothing was hammered at Google.
    expect(gemini.said()).toEqual(['main-key', 'backup-one'])
    expect(gemini.said()).not.toContain('main-key\n')
  })

  it('does not hide a wrong key behind a backup that works', async () => {
    const voice = service(['backup-one'])
    voice.setKey('wrong-key')
    gemini.state.set('wrong-key', 'reject')

    const made = await voice.note('One.', '')
    expect(made.ok).toBe(false)
    if (made.ok) throw new Error('unreachable')
    expect(made.error).toBe('That Gemini key was not accepted.')
    expect(gemini.said()).toEqual(['wrong-key'])
  })

  it('speaks with a backup key when the voice key in Settings was never set', async () => {
    const voice = service(['backup-one'])
    const made = await voice.note('One.', '')
    expect(made.ok).toBe(true)
    expect(gemini.said()).toEqual(['backup-one'])
  })

  it('never puts a key in what it returns', async () => {
    const voice = service(['backup-one'])
    voice.setKey('main-key')
    gemini.state.set('main-key', 'day')
    gemini.state.set('backup-one', 'day')
    const made = await voice.note('One.', '')
    expect(JSON.stringify(made)).not.toContain('main-key')
    expect(JSON.stringify(made)).not.toContain('backup-one')
  })
})

describe('the keys themselves', () => {
  it('takes the Vault items named for voice-note backups, in the Vault order', () => {
    const secrets = new Map<string, string>()
    const vault = new VaultStore({ get: (n) => secrets.get(n) ?? null, set: (n, v) => void secrets.set(n, v), delete: (n) => void secrets.delete(n) })
    vault.save({ name: `${BACKUP_PREFIX} (first account)`, kind: 'api_key', fields: { key: 'key-one' } })
    vault.save({ name: 'Gemini API key: something else entirely', kind: 'api_key', fields: { key: 'not-a-voice-key' } })
    vault.save({ name: `${BACKUP_PREFIX} (second account)`, kind: 'api_key', fields: { key: 'key-two' } })
    vault.save({ name: `${BACKUP_PREFIX} (empty one)`, kind: 'api_key', fields: { key: '   ' } })

    expect(vaultBackupKeys(vault)).toEqual(['key-one', 'key-two'])
  })

  it('remembers a resting key by a fingerprint, never by the key', () => {
    expect(fingerprint('secret-key')).toHaveLength(16)
    expect(fingerprint('secret-key')).not.toContain('secret')
    expect(fingerprint(' secret-key ')).toBe(fingerprint('secret-key'))
  })

  it('orders the voice key first, then the backups, and skips one that is resting', () => {
    let now = 1_000
    const ring = new VoiceKeyring({ primary: () => 'main', backups: () => ['b1', 'b2', 'main'], now: () => now })
    expect(ring.keys()).toEqual(['main', 'b1', 'b2'])

    ring.exhausted('main', now + 60_000)
    expect(ring.keys()).toEqual(['b1', 'b2'])
    expect(ring.freeAt()).toBe(now + 60_000)

    now += 60_000
    expect(ring.keys()).toEqual(['main', 'b1', 'b2'])
    expect(ring.freeAt()).toBeNull()
  })

  it('knows when Google\'s day turns over in California', () => {
    // 22:45 UTC on 27 Nov is 14:45 in Los Angeles: the next midnight there is 08:00 UTC on 28 Nov.
    expect(new Date(nextPacificMidnight(Date.UTC(2026, 10, 27, 22, 45))).toISOString()).toBe('2026-11-28T08:00:00.000Z')
    // Just after that midnight it is a day later again.
    expect(new Date(nextPacificMidnight(Date.UTC(2026, 10, 28, 8, 30))).toISOString()).toBe('2026-11-29T08:00:00.000Z')
    // Daylight saving: 8 March 2026 starts it (02:00 PST becomes 03:00 PDT), 1 November 2026 ends it.
    expect(new Date(nextPacificMidnight(Date.UTC(2026, 2, 8, 5, 0))).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(new Date(nextPacificMidnight(Date.UTC(2026, 2, 9, 8, 0))).toISOString()).toBe('2026-03-10T07:00:00.000Z')
    expect(new Date(nextPacificMidnight(Date.UTC(2026, 10, 1, 6, 0))).toISOString()).toBe('2026-11-01T07:00:00.000Z')
  })

  it('reads a refusal as a daily or a per-minute quota and keeps what it said to wait', () => {
    expect(quotaOf(200, 'anything')).toBeNull()
    expect(quotaOf(400, DAILY)).toBeNull()
    expect(quotaOf(429, DAILY)?.quota).toBe('day')
    expect(quotaOf(429, PER_MINUTE)?.quota).toBe('minute')
    // An exhaustion with no period named rests briefly rather than for the rest of the day.
    expect(quotaOf(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')?.quota).toBe('minute')
    expect(quotaOf(429, '{"error":{"details":[{"retryDelay":"33s"}]}}')?.retryAfterMs).toBe(33_000)
    expect(quotaOf(429, DAILY)?.retryAfterMs).toBe(9 * 3_600_000 + 29 * 60_000 + 19_000)
  })

  it('rests a key until the reset it is owed, and no longer', () => {
    const now = Date.UTC(2026, 10, 27, 22, 45)
    expect(restUntil('day', now)).toBe(nextPacificMidnight(now))
    expect(restUntil('minute', now)).toBe(now + SHORT_REST_MS)
    expect(restUntil('minute', now, 33_000)).toBe(now + 33_000)
    // A provider asking for an hour is not believed: a per-minute limit is a minute's wait, not an hour's silence.
    expect(restUntil('minute', now, 3_600_000)).toBe(now + MAX_REST_MS)
  })
})
