import { readdir } from 'node:fs/promises'
import { TransferStore, type FileTransfer, type TransferReply, type TransferChunk } from './file-transfer'

class TransferFailure extends Error {}

interface Peer { id: string; urls: string[]; fp: string }
interface SenderDeps {
  directory: string
  peers: () => Promise<Peer[]>
  pass: () => string | null
  fetchFor: (peer: Peer) => typeof fetch
  local?: {
    connected: (target: string) => boolean
    receive: (target: string, chunk: TransferChunk) => Promise<{ status: string; nextIndex?: number }>
    status: (id: string) => Promise<{ status: string; reason?: string } | null>
  }
}
type SenderRow = FileTransfer & { relayId?: string; relayUrl?: string }
export class TransferSender {
  private readonly store: TransferStore
  private ticking = false
  constructor(private readonly deps: SenderDeps) { this.store = new TransferStore(deps.directory) }

  enqueue(path: string, target: string, name: string): Promise<FileTransfer> { return this.store.create(path, target, name) }
  status(id: string): Promise<FileTransfer> { return this.store.get(id) }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      let files: string[]
      try { files = await readdir(this.deps.directory) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const file of files) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue
        let row = await this.store.get(file.slice(0, -5)) as SenderRow
        if (row.status === 'delivered' || row.status === 'failed') continue
        const pass = this.deps.pass()
        if (pass === null || pass === '') continue
        const peers = await this.deps.peers()
        let peer = row.relayId === '__local__' ? { id: '__local__', urls: [], fp: '' } : peers.find((p) => p.id === row.relayId)
        let url = row.relayUrl
        if (row.relayId === undefined) {
          if (this.deps.local?.connected(row.target) === true) {
            peer = { id: '__local__', urls: [], fp: '' }
            url = 'local'
          }
          for (const candidate of peer === undefined ? peers : []) {
            for (const base of candidate.urls) {
              try {
                const response = await this.deps.fetchFor(candidate)(base.replace(/\/$/, '') + '/v1/file-relay/presence?target=' + encodeURIComponent(row.target), { headers: { authorization: 'Bearer ' + pass }, signal: AbortSignal.timeout(5000) })
                if (response.ok && (await response.json() as { connected?: boolean }).connected === true) { peer = candidate; url = base; break }
              } catch { /* another address may answer */ }
            }
            if (peer !== undefined) break
          }
          if (peer === undefined || url === undefined) continue
          row.relayId = peer.id
          row.relayUrl = url
          await this.store.save(row)
        }
        if (peer === undefined || url === undefined) continue
        const endpoint = url.replace(/\/$/, '')
        const local = this.deps.local
        const fetchPeer: typeof fetch = peer.id !== '__local__' || local === undefined ? this.deps.fetchFor(peer) : async (input, init) => {
          const address = String(input)
          if (address.includes('/chunk')) {
            const payload = JSON.parse(String(init?.body)) as { target: string; chunk: TransferChunk }
            return Response.json(await local.receive(payload.target, payload.chunk))
          }
          const id = new URL(address.replace(/^local/, 'http://local')).searchParams.get('id') ?? ''
          const result = await local.status(id)
          return Response.json(result ?? {}, { status: result === null ? 404 : 200 })
        }
        try {
          if (row.nextIndex < Math.max(1, Math.ceil(row.size / row.chunkSize))) {
            const total = Math.max(1, Math.ceil(row.size / row.chunkSize))
            row = await this.store.send(row.id, async (chunk): Promise<TransferReply> => {
              const response = await fetchPeer(endpoint + '/v1/file-relay/chunk', {
                method: 'POST', headers: { authorization: 'Bearer ' + pass, 'content-type': 'application/json' },
                body: JSON.stringify({ target: row.target, chunk }), signal: AbortSignal.timeout(70000),
              })
              if (!response.ok) {
                if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new TransferFailure('Relay rejected a chunk')
                throw new Error('Relay unavailable')
              }
              const result = await response.json() as { status?: string; nextIndex?: number }
              if (result.status === 'partial' && typeof result.nextIndex === 'number') return { status: 'partial', nextIndex: result.nextIndex }
              if (result.status === 'queued' || result.status === 'sending' || result.status === 'delivered') return { status: 'partial', nextIndex: total }
              if (result.status === 'failed') throw new TransferFailure('Relay rejected the file, likely a hash mismatch')
              throw new Error('Relay reported ' + String(result.status))
            }) as SenderRow
          }
          if (row.nextIndex >= Math.max(1, Math.ceil(row.size / row.chunkSize))) {
            const response = await fetchPeer(endpoint + '/v1/file-relay/status?id=' + encodeURIComponent(row.id), { headers: { authorization: 'Bearer ' + pass }, signal: AbortSignal.timeout(5000) })
            if (!response.ok) throw new Error('Cannot read relay status')
            const result = await response.json() as { status?: string; reason?: string }
            if (result.status === 'delivered') { row.status = 'delivered'; delete row.reason }
            else if (result.status === 'failed') { row.status = 'failed'; row.reason = result.reason ?? 'Relay failed' }
            else row.status = 'sending'
            await this.store.save(row)
          }
        } catch (error) {
          row = await this.store.get(row.id) as SenderRow
          row.status = error instanceof TransferFailure || (error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && error.message === 'Source file changed during transfer') ? 'failed' : 'queued'
          row.reason = error instanceof Error ? error.message : String(error)
          await this.store.save(row)
        }
      }
    } finally { this.ticking = false }
  }
}
