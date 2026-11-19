/**
 * Instant send on the headless node (20 Nov 2026): a phone linked to agent-node, not to the PC app, gets the same
 * behaviour: its dictated message is in the chat at once, voice.takeAudio is accepted, the agent's turn waits for the
 * clean text, a failed pass gives the caption plus the note and a Retry, and a take left on disk is finished after a
 * restart. The Gemini pass is replaced here (VoiceService.transcribe); the real one is proven on a throwaway node.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAIN_CHAT, providerFor } from '@agent/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { FAILED_NOTE } from '../src/main/dictation/pending'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { startHeadlessRuntime, type HeadlessRuntime } from '../src/headless/runtime'
import { CHANNELS } from '../src/shared/channels'
import { VoiceService } from '../src/main/voice/service'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const temps: string[] = []
const closers: Array<() => Promise<void> | void> = []
let fake: FakeAi | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
  await fake?.close()
  fake = null
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot(dataDir: string): Promise<HeadlessRuntime> {
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  settings.save({ hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false })
  new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key'))).set('apiKey', 'test-key')
  const runtime = await startHeadlessRuntime({
    dataDir,
    appDir: root,
    version: '9.9.9',
    quiet: true,
    chromium: null,
    providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
  })
  closers.push(() => runtime.stop(0))
  return runtime
}

const dataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'node-instant-'))
  temps.push(dir)
  return dir
}
const pcm = (): Uint8Array => new Uint8Array(32_000 * 5).fill(1)
const userRow = async (runtime: HeadlessRuntime) => (await runtime.store.list('chat_item')).find((item) => item.kind === 'user')!
const call = (runtime: HeadlessRuntime, channel: string, ...args: unknown[]): Promise<unknown> => runtime.ipcMain.invoke(channel, args, 'phone')

describe('agent-node instant send', () => {
  it('accepts voice.takeAudio, and the agent reads the clean text, not the caption', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    let release: (text: string) => void = () => undefined
    vi.spyOn(VoiceService.prototype, 'transcribe').mockImplementation(() => new Promise((resolve) => (release = (text) => resolve({ ok: true, text }))))
    const runtime = await boot(dataDir())
    await call(runtime, CHANNELS.chat.send, 'construction head the the', [], MAIN_CHAT, { dictation: { id: 'take-a', pending: true, caption: 'construction head the the' } })
    const first = await userRow(runtime)
    expect(JSON.parse(first.meta).dictation).toEqual({ id: 'take-a', pending: true })
    const ack = (await call(runtime, CHANNELS.voice.takeAudio, { id: 'take-a', chat: MAIN_CHAT, caption: 'construction head the the', audio: pcm(), names: ['Mthashana'], languages: ['zu-ZA'] })) as { ok: boolean; state?: string; error?: string }
    expect(ack.error).toBeUndefined()
    expect(ack.ok).toBe(true)
    await sleep(300)
    expect(fake.requests.length).toBe(0) // the agent waits for the clean text
    release('The letterhead, because Strat Edge has its own.')
    await waitFor(() => fake!.requests.length > 0, 10_000)
    expect((await userRow(runtime)).text).toBe('The letterhead, because Strat Edge has its own.')
    const prompt = JSON.stringify(fake.requests)
    expect(prompt).toContain('The letterhead, because Strat Edge has its own.')
    expect(prompt).not.toContain('construction head')
  })

  it('a failed pass gives the agent the caption plus the note, and the row says Sent as heard', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    vi.spyOn(VoiceService.prototype, 'transcribe').mockResolvedValue({ ok: false, error: 'quota' })
    const runtime = await boot(dataDir())
    await call(runtime, CHANNELS.chat.send, 'the live caption', [], MAIN_CHAT, { dictation: { id: 'take-b', pending: true, caption: 'the live caption' } })
    await call(runtime, CHANNELS.voice.takeAudio, { id: 'take-b', chat: MAIN_CHAT, caption: 'the live caption', audio: pcm() })
    await waitFor(() => fake!.requests.length > 0, 15_000)
    expect(JSON.stringify(fake.requests)).toContain(FAILED_NOTE)
    expect(JSON.parse((await userRow(runtime)).meta).dictation).toEqual({ id: 'take-b', pending: false, failed: true })
  })

  it('a take left on disk when the node stopped is written down at the next start', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    const dir = dataDir()
    vi.spyOn(VoiceService.prototype, 'transcribe').mockImplementation(() => new Promise(() => undefined))
    const first = await boot(dir)
    await call(first, CHANNELS.chat.send, 'half heard', [], MAIN_CHAT, { dictation: { id: 'take-c', pending: true, caption: 'half heard' } })
    await call(first, CHANNELS.voice.takeAudio, { id: 'take-c', chat: MAIN_CHAT, caption: 'half heard', audio: pcm() })
    expect(readdirSync(join(dir, 'voice-notes', 'pending-takes')).sort()).toEqual(['take-c.json', 'take-c.pcm'])
    await closers.pop()!()
    vi.restoreAllMocks()
    vi.spyOn(VoiceService.prototype, 'transcribe').mockResolvedValue({ ok: true, text: 'Half heard, now whole.' })
    const second = await boot(dir)
    await waitFor(async () => (await userRow(second)).text === 'Half heard, now whole.', 10_000)
    expect(JSON.parse((await userRow(second)).meta).dictation).toEqual({ id: 'take-c', pending: false, final: true })
    await waitFor(() => readFileSync(join(dir, 'voice-notes', 'pending-takes', 'take-c.json'), 'utf8').includes('"state":"done"'), 5_000)
  })
})
