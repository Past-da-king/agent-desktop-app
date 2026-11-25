import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/main/db'
import { VoiceService } from '../src/main/voice/service'
import { registerVoiceIpc } from '../src/main/voice/ipc'
import { CHANNELS } from '../src/shared/channels'
import { DEFAULT_SETTINGS } from '@agent/core'
import { peerNoteAudio, type NoteMesh } from '../src/main/voice/peer-audio'
import { wavOf } from '../src/main/voice/gemini'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function fixture() {
  const store = new Store(':memory:'); stores.push(store)
  const calls: unknown[][] = []
  const audio = wavOf(Buffer.alloc(4800))
  const mesh: NoteMesh = {
    enabled: () => true,
    self: () => ({ id: 'self', facts: { name: 'test', kind: 'desktop', platform: 'linux', appVersion: 'test', screen: { width: 0, height: 0 }, canOpenLinks: false, canReceiveFiles: false, fingerprint: '', urls: [] } }),
    pass: () => 'test-pass',
    call: async (...args) => { calls.push(args); return { $b64: audio.toString('base64') } },
  }
  return { store, mesh, calls, audio }
}
it('retrieves a synced note from its producing device using a local-only RPC', async () => {
  const h = fixture()
  await h.store.upsert('device', { id: 'source', name: 'Source', kind: 'server', platform: 'linux', roles: ['brain'], urls: ['https://source.example'], fp: 'pin', revoked: false })
  await h.store.upsert('chat_item', { kind: 'voice_note', text: 'Hi.', meta: JSON.stringify({ file: 'note-1.wav', audioDevice: 'source' }) })
  expect(await peerNoteAudio(h.store, 'note-1.wav', h.mesh)).toEqual(h.audio)
  expect(h.calls[0]?.slice(0,3)).toEqual(['https://source.example','pin','test-pass'])
  expect(h.calls[0]?.slice(4,6)).toEqual(['voice.noteAudio',['note-1.wav',true]])
})
it('never relays unknown notes, path traversal or notes from revoked devices', async () => {
  const h = fixture()
  await h.store.upsert('device', { id: 'source', name: 'Source', kind: 'server', platform: 'linux', roles: ['brain'], urls: ['https://source.example'], fp: 'pin', revoked: true })
  await h.store.upsert('chat_item', { kind: 'voice_note', text: 'Hi.', meta: JSON.stringify({ file: 'note-1.wav', audioDevice: 'source' }) })
  expect(await peerNoteAudio(h.store, '../secret.wav', h.mesh)).toBeNull()
  expect(await peerNoteAudio(h.store, 'unknown.wav', h.mesh)).toBeNull()
  expect(await peerNoteAudio(h.store, 'note-1.wav', h.mesh)).toBeNull()
  expect(h.calls).toHaveLength(0)
})
it('does not contact any peer while Devices is off', async () => {
  const h = fixture(); h.mesh.enabled = () => false
  expect(await peerNoteAudio(h.store, 'note-1.wav', h.mesh)).toBeNull()
  expect(h.calls).toHaveLength(0)
})

it('rechecks revocation after the reply arrives', async () => {
  const h = fixture()
  await h.store.upsert('device', { id: 'source', name: 'Source', kind: 'server', platform: 'linux', roles: ['brain'], urls: ['https://source.example'], fp: 'pin', revoked: false })
  await h.store.upsert('chat_item', { kind: 'voice_note', text: 'Hi.', meta: JSON.stringify({ file: 'note-1.wav', audioDevice: 'source' }) })
  h.mesh.call = async () => { await h.store.upsert('device', { id: 'source', revoked: true }); return { $b64: h.audio.toString('base64') } }
  expect(await peerNoteAudio(h.store, 'note-1.wav', h.mesh)).toBeNull()
})

it('a paired RPC marked local-only never forwards it again', async () => {
  const h = fixture()
  let forwarded = 0
  const voice = new VoiceService({
    secrets: { get: () => null, set: () => {}, delete: () => {} },
    settings: { get: () => DEFAULT_SETTINGS, save: () => {} }, store: h.store,
    runner: { send: async () => {}, state: () => ({ running: false, waiting: [] }) }, emit: () => {},
    remoteNoteAudio: async () => { forwarded++; return h.audio },
  })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerVoiceIpc(voice, { handle: (channel, listener) => { handlers.set(channel, listener) } })
  const get = handlers.get(CHANNELS.voice.noteAudio)!
  expect(await get(null, 'note-1.wav', true)).toBeNull()
  expect(forwarded).toBe(0)
  expect(await get(null, 'note-1.wav')).toEqual(new Uint8Array(h.audio))
  expect(forwarded).toBe(1)
  expect(await get(null, '../secret.wav')).toBeNull()
  expect(forwarded).toBe(1)
})
