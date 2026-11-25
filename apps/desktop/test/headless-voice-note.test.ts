import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/main/db'
import { CHANNELS } from '../src/shared/channels'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { VoiceService } from '../src/main/voice/service'
import { DEFAULT_SETTINGS } from '@agent/core'
import { testContext, toolNamed } from './support'
import { startHeadlessRuntime, type HeadlessRuntime } from '../src/headless/runtime'

const dirs: string[] = []
const stores: Store[] = []
let runtime: HeadlessRuntime | undefined
afterEach(async () => {
  await runtime?.stop(0)
  runtime = undefined
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() { const dir = mkdtempSync(join(tmpdir(), 'node-voice-')); dirs.push(dir); return dir }
function service(key: string | null) {
  const store = new Store(':memory:'); stores.push(store)
  let requests = 0
  const voice = new VoiceService({
    secrets: { get: (name) => name === 'geminiKey' ? key : null, set: () => {}, delete: () => {} },
    settings: { get: () => DEFAULT_SETTINGS, save: () => {} }, store,
    runner: { send: async () => {}, state: () => ({ running: false, waiting: [] }) },
    emit: () => {}, notesDir: temp(), noteDevice: () => 'source',
    fetchImpl: (async (url: string) => {
      requests++
      if (url.includes('/models')) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }] }))
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.alloc(4800).toString('base64') }] }] }))
    }) as typeof fetch,
  })
  return { store, voice, requests: () => requests }
}
it('the actual headless composition exposes voice notes to main and helpers without a key', async () => {
  runtime = await startHeadlessRuntime({ dataDir: temp(), appDir: process.cwd(), version: 'test', quiet: true, chromium: null })
  for (const tools of [runtime.mainTools, runtime.devicesHooks.localTools()]) {
    const note = toolNamed(tools, 'voice_note')
    expect(await note.run({ script: 'Hello.' }, testContext())).toContain('Gemini key')
  }
})
for (const [name, build] of [['main', buildToolset], ['helper', buildWorkerToolset]] as const) {
  it(`${name} renders a playable voice-note row in the calling chat`, async () => {
    const h = service('fake-key')
    const tools = build({ store: h.store, voiceNotes: () => h.voice })
    expect(tools.filter(t => t.spec.name === 'voice_note')).toHaveLength(1)
    await toolNamed(tools, 'voice_note').run({ script: 'Hello.', style: 'calm' }, testContext({ chat: 'project-test' }))
    const rows = await h.store.list('chat_item')
    const row = rows.find(r => r.kind === 'voice_note')!
    expect(row).toBeDefined()
    expect(JSON.parse(row.meta as string).chat).toBe('project-test')
    const meta = JSON.parse(row.meta as string) as { file: string; durationMs: number }
    expect(meta.durationMs).toBe(100)
    expect(JSON.parse(row.meta as string).audioDevice).toBe('source')
    expect(h.voice.noteAudio(meta.file)?.subarray(0, 4).toString()).toBe('RIFF')
    expect(h.requests()).toBeGreaterThan(0)
  })
}
it('missing configured key does not call TTS or create a message', async () => {
  const h = service(null)
  const result = await toolNamed(buildToolset({ store: h.store, voiceNotes: () => h.voice }), 'voice_note').run({ script: 'Hello.' }, testContext())
  expect(result).toContain('Gemini key')
  expect(h.requests()).toBe(0)
  expect(await h.store.list('chat_item')).toHaveLength(0)
})
it('desktop helper composition supplies the shared voice service', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const helper = source.slice(source.indexOf('const helperToolset = buildWorkerToolset'), source.indexOf('// What registerDevicesSync needs'))
  expect(helper).toContain('voiceNotes:')
})

it('node main and helper expose safe media and git tools', async () => {
  runtime = await startHeadlessRuntime({ dataDir: temp(), appDir: process.cwd(), version: 'test', quiet: true, chromium: null })
  for (const tools of [runtime.mainTools, runtime.devicesHooks.localTools()]) {
    for (const name of ['show_media', 'git_status_report', 'git_autocommit_log']) expect(tools.map(t => t.spec.name)).toContain(name)
  }
})

it('headless TTS writes a synced voice-note row and serves WAV bytes through the phone RPC', async () => {
  runtime = await startHeadlessRuntime({ dataDir: temp(), appDir: process.cwd(), version: 'test', quiet: true, chromium: null })
  runtime.secrets.set('geminiKey', 'fake-voice-key')
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('generativelanguage.googleapis.com')
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('fake-voice-key')
    calls++
    if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash-preview-tts' }] }))
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.alloc(4800).toString('base64') }] }] }))
  }) as typeof fetch
  try {
    await toolNamed(runtime.mainTools, 'voice_note').run({ script: 'A proper voice note.', style: 'calm' }, testContext({ chat: 'project-test' }))
    const replica = new Store(':memory:'); stores.push(replica)
    await replica.applyRemote(await runtime.store.localChanges(null), 'node-test')
    const row = (await replica.list('chat_item')).find(r => r.kind === 'voice_note')!
    expect(row.text).toBe('A proper voice note.')
    const meta = JSON.parse(row.meta as string) as { file: string; chat: string }
    expect(meta.chat).toBe('project-test')
    const audio = await runtime.ipc.invoke(CHANNELS.voice.noteAudio, [meta.file]) as Uint8Array
    expect(Buffer.from(audio).subarray(0, 4).toString()).toBe('RIFF')
    expect(audio.length).toBe(4844)
    expect(calls).toBe(2)
  } finally { globalThis.fetch = originalFetch }
})
