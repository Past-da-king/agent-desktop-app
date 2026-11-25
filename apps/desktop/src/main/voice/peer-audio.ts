/** Retrieve only a replicated voice note from a still-trusted paired brain. Never relay a relay. */
import type { DeviceFacts } from '../devices/types'
import type { DataStore } from '../runtime/data'
import { listWhere } from '../runtime/data'
import { getDevicesService } from '../devices/service'
import { callNode } from '../../headless/rpc-client'
import { decodeWire } from '../../shared/rpc-methods'

export interface NoteMesh {
  enabled(): boolean
  self(): { id: string; facts: DeviceFacts } | null
  pass(): string | null
  call: typeof callNode
}

const mesh: NoteMesh = {
  enabled: () => getDevicesService()?.isEnabled() === true,
  self: () => getDevicesService()?.host().self() ?? null,
  pass: () => getDevicesService()?.peerPass() ?? null,
  call: callNode,
}

export async function peerNoteAudio(store: DataStore, file: string, link: NoteMesh = mesh): Promise<Buffer | null> {
  if (!/^[\w-]+\.wav$/.test(file) || file.length > 120 || !link.enabled()) return null
  const self = link.self()
  const pass = link.pass()
  if (self === null || pass === null || pass === '') return null
  // Merely knowing a filename must not let a caller probe the other computers' note folders.
  const rows = await listWhere(store, 'chat_item', { kind: 'voice_note' })
  let origin: string | null = null
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.meta) as Record<string, unknown>
      if (meta['file'] === file) { origin = typeof meta['audioDevice'] === 'string' ? meta['audioDevice'] : ''; break }
    } catch { /* An old malformed chat row cannot authorize a fetch. */ }
  }
  if (origin === null || origin === self.id) return null
  const peers = (await store.list('device')).filter(p => !p.revoked && p.id !== self.id && p.roles.includes('brain') && p.fp !== '' && (origin === '' || p.id === origin))
  for (const peer of peers.slice(0, 8)) {
    for (const url of peer.urls.filter(u => u.startsWith('https://')).slice(0, 2)) {
      if (!link.enabled()) return null
      const current = await store.get('device', peer.id)
      if (current === null || current.revoked || !current.roles.includes('brain') || current.fp !== peer.fp || !current.urls.includes(url)) break
      try {
        // The second argument forbids forwarding, including when a legacy note has no producing-device id.
        const result = await link.call(url, peer.fp, pass, self.facts, 'voice.noteAudio', [file, true], origin === '' ? 5_000 : 60_000)
        const bytes = decodeWire(result)
        if (!(bytes instanceof Uint8Array) || bytes.length < 44 || bytes.length > 64 * 1024 * 1024) continue
        const audio = Buffer.from(bytes)
        if (audio.subarray(0, 4).toString('ascii') !== 'RIFF') continue
        const after = await store.get('device', peer.id)
        if (!link.enabled() || after === null || after.revoked || !after.roles.includes('brain') || after.fp !== peer.fp || !after.urls.includes(url)) return null
        return audio
      } catch { /* Offline, old, or refusing peers are not a reason to expose another path or secret. */ }
    }
  }
  return null
}
