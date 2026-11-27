import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TransferInbox, type TransferChunk, type TransferReply } from './file-transfer'

interface RelayJob {
  id: string
  target: string
  status: 'uploading' | 'queued' | 'sending' | 'delivered' | 'failed'
  reason?: string
}
export class TransferRelay {
  private ticking = false
  constructor(private readonly root: string, private readonly phone: (target: string, chunk: TransferChunk) => Promise<TransferReply>) {}

  private ownerDir(owner: string): string {
    return join(this.root, createHash('sha256').update(owner).digest('hex'))
  }
  private jobPath(ownerDir: string, id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid transfer id')
    return join(ownerDir, id + '.json')
  }
  private async write(path: string, job: RelayJob): Promise<void> {
    const temp = path + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(job), { mode: 0o600 })
    await rename(temp, path)
  }

  async receive(owner: string, target: string, chunk: TransferChunk): Promise<{ status: string; nextIndex?: number }> {
    if (owner === '' || target === '') throw new Error('Missing transfer owner or target')
    const dir = this.ownerDir(owner)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = this.jobPath(dir, chunk.transferId)
    let job: RelayJob
    try { job = JSON.parse(await readFile(path, 'utf8')) as RelayJob }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || chunk.index !== 0) throw error
      job = { id: chunk.transferId, target, status: 'uploading' }
      await this.write(path, job)
    }
    if (job.target !== target) throw new Error('Transfer target changed')
    if (job.status === 'delivered') return { status: 'delivered' }
    if (job.status === 'failed') return { status: 'failed' }
    if (job.status === 'queued' || job.status === 'sending') return { status: job.status }
    const result = await new TransferInbox(join(dir, 'inbox')).receive(chunk)
    if (result.status === 'hash_mismatch') {
      job.status = 'failed'
      job.reason = 'File hash mismatch'
      await this.write(path, job)
      return { status: 'failed' }
    }
    if (result.status === 'partial') return result
    job.status = 'queued'
    delete job.reason
    await this.write(path, job)
    return { status: 'queued' }
  }

  async status(owner: string, id: string): Promise<RelayJob | null> {
    try { return JSON.parse(await readFile(this.jobPath(this.ownerDir(owner), id), 'utf8')) as RelayJob }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      let owners: string[]
      try { owners = await readdir(this.root) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const owner of owners) {
        if (!/^[0-9a-f]{64}$/.test(owner)) continue
        const dir = join(this.root, owner)
        for (const file of await readdir(dir)) {
          if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue
          const path = join(dir, file)
          const job = JSON.parse(await readFile(path, 'utf8')) as RelayJob
          if (job.status !== 'queued' && job.status !== 'sending') continue
          job.status = 'sending'
          await this.write(path, job)
          try {
            const result = await new TransferInbox(join(dir, 'inbox')).deliver(job.id, (chunk) => this.phone(job.target, chunk))
            if (result.status !== 'received') throw new Error('Phone did not confirm receipt')
            job.status = 'delivered'
            delete job.reason
          } catch (error) {
            job.reason = error instanceof Error ? error.message : String(error)
            job.status = job.reason === 'Phone reported a hash mismatch' ? 'failed' : 'queued'
          }
          await this.write(path, job)
        }
      }
    } finally { this.ticking = false }
  }
}

export function registerTransferRelayRoutes(host: import('./types').DevicesHost, relay: TransferRelay): void {
  host.addRoute({
    method: 'GET', path: '/v1/file-relay/presence', auth: 'node',
    async handle(req) {
      const target = req.query.get('target') ?? ''
      return { status: 200, json: { connected: target !== '' && host.isConnected(target) } }
    },
  })
  host.addRoute({
    method: 'POST', path: '/v1/file-relay/chunk', auth: 'node',
    async handle(req) {
      if (req.deviceId === null || typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return { status: 400, json: { error: 'Invalid chunk' } }
      const body = req.body as Record<string, unknown>
      const chunk = body['chunk']
      if (typeof body['target'] !== 'string' || typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return { status: 400, json: { error: 'Invalid chunk' } }
      try {
        return { status: 200, json: await relay.receive(req.deviceId, body['target'], chunk as TransferChunk) }
      } catch (error) {
        return { status: 400, json: { error: error instanceof Error ? error.message : 'Invalid chunk' } }
      }
    },
  })
  host.addRoute({
    method: 'GET', path: '/v1/file-relay/status', auth: 'node',
    async handle(req) {
      if (req.deviceId === null) return { status: 401, json: { error: 'Not paired' } }
      try {
        const result = await relay.status(req.deviceId, req.query.get('id') ?? '')
        return result === null ? { status: 404, json: { error: 'Transfer not found' } } : { status: 200, json: result }
      } catch { return { status: 400, json: { error: 'Invalid transfer id' } } }
    },
  })
}
