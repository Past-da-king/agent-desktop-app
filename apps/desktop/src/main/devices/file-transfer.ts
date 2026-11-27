import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TRANSFER_CHUNK_SIZE = 512 * 1024
export interface FileTransfer {
  id: string
  source: string
  target: string
  name: string
  size: number
  sha256: string
  chunkSize: number
  nextIndex: number
  status: 'queued' | 'sending' | 'delivered' | 'failed'
  reason?: string
  relayId?: string
  relayUrl?: string
}

export interface TransferChunk { transferId: string; index: number; dataBase64: string; name?: string; size?: number; sha256?: string; total?: number }
export type TransferReply = { status: 'partial'; nextIndex: number } | { status: 'received'; bytes: number; path: string } | { status: 'hash_mismatch' }

export class TransferStore {
  constructor(private readonly directory: string) {}

  async create(source: string, target: string, name: string): Promise<FileTransfer> {
    const info = await stat(source)
    if (!info.isFile()) throw new Error('Source is not a file')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(source)) hash.update(chunk as Buffer)
    const row: FileTransfer = {
      id: randomUUID(), source, target, name, size: info.size, sha256: hash.digest('hex'),
      chunkSize: TRANSFER_CHUNK_SIZE, nextIndex: 0, status: 'queued',
    }
    await this.save(row)
    return row
  }

  async get(id: string): Promise<FileTransfer> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid transfer id')
    return JSON.parse(await readFile(join(this.directory, id + '.json'), 'utf8')) as FileTransfer
  }

  async send(id: string, receiver: (chunk: TransferChunk) => Promise<TransferReply>): Promise<FileTransfer> {
    const row = await this.get(id)
    const total = Math.max(1, Math.ceil(row.size / row.chunkSize))
    const file = await open(row.source, 'r')
    try {
      row.status = 'sending'
      delete row.reason
      await this.save(row)
      while (row.nextIndex < total) {
        const index = row.nextIndex
        const length = Math.min(row.chunkSize, Math.max(0, row.size - index * row.chunkSize))
        const buffer = Buffer.alloc(length)
        const read = await file.read(buffer, 0, length, index * row.chunkSize)
        if (read.bytesRead !== length) throw new Error('Source file changed during transfer')
        const chunk: TransferChunk = { transferId: id, index, dataBase64: buffer.toString('base64'),
          ...(index === 0 ? { name: row.name, size: row.size, sha256: row.sha256, total } : {}) }
        const answer = await receiver(chunk)
        if (answer.status === 'hash_mismatch') throw new Error('Receiver reported a hash mismatch')
        if (answer.status === 'received') {
          if (answer.bytes !== row.size) throw new Error('Receiver reported the wrong size')
          row.nextIndex = total
          row.status = 'delivered'
          await this.save(row)
          return row
        }
        if (!Number.isInteger(answer.nextIndex) || answer.nextIndex <= index || answer.nextIndex > total) throw new Error('Invalid receiver progress')
        row.nextIndex = answer.nextIndex
        await this.save(row)
      }
      return row
    } catch (error) {
      row.status = 'queued'
      row.reason = error instanceof Error ? error.message : String(error)
      await this.save(row)
      throw error
    } finally {
      await file.close()
    }
  }

  async save(row: FileTransfer): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(row.id)) throw new Error('Invalid transfer id')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, row.id + '.json')
    const temp = path + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(row), { mode: 0o600 })
    await rename(temp, path)
  }
}


async function writeOnce(path: string, bytes: Buffer): Promise<void> {
  const temp = path + '.' + randomUUID() + '.tmp'
  await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
  try {
    try { await link(temp, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await readFile(path)).equals(bytes)) throw new Error('Chunk differs from previous upload')
    }
  } finally { await unlink(temp).catch(() => undefined) }
}

interface InboxMeta { name: string; size: number; sha256: string; total: number }
export class TransferInbox {
  constructor(private readonly directory: string) {}

  async deliver(id: string, receiver: (chunk: TransferChunk) => Promise<TransferReply>): Promise<TransferReply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid transfer id')
    const dir = join(this.directory, id)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as InboxMeta
    const progressPath = join(dir, 'phone-progress.json')
    let progress: { nextIndex: number; result?: TransferReply } = { nextIndex: 0 }
    try { progress = JSON.parse(await readFile(progressPath, 'utf8')) as typeof progress }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (progress.result?.status === 'received') return progress.result
    while (progress.nextIndex < meta.total) {
      const index = progress.nextIndex
      const data = await readFile(join(dir, String(index)))
      const chunk: TransferChunk = { transferId: id, index, dataBase64: data.toString('base64'),
        ...(index === 0 ? { name: meta.name, size: meta.size, sha256: meta.sha256, total: meta.total } : {}) }
      const result = await receiver(chunk)
      if (result.status === 'hash_mismatch') throw new Error('Phone reported a hash mismatch')
      if (result.status === 'received') {
        if (result.bytes !== meta.size) throw new Error('Invalid phone receipt')
        progress = { nextIndex: meta.total, result }
      } else {
        if (!Number.isSafeInteger(result.nextIndex) || result.nextIndex <= index || result.nextIndex >= meta.total) throw new Error('Invalid phone progress')
        progress = { nextIndex: result.nextIndex }
      }
      const temp = progressPath + '.' + randomUUID() + '.tmp'
      await writeFile(temp, JSON.stringify(progress), { mode: 0o600 })
      await rename(temp, progressPath)
      if (progress.result !== undefined) return progress.result
    }
    throw new Error('Phone did not confirm delivery')
  }

  async receive(chunk: TransferChunk): Promise<TransferReply> {
    if (!/^[0-9a-f-]{36}$/.test(chunk.transferId) || !Number.isSafeInteger(chunk.index) || chunk.index < 0) throw new Error('Invalid transfer chunk')
    const dir = join(this.directory, chunk.transferId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const metaPath = join(dir, 'meta.json')
    let meta: InboxMeta
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as InboxMeta
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || chunk.index !== 0 || typeof chunk.name !== 'string' || !Number.isSafeInteger(chunk.size) || (chunk.size ?? -1) < 0 || typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256) || !Number.isSafeInteger(chunk.total) || (chunk.total ?? 0) < 1) throw new Error('Missing or invalid transfer metadata')
      meta = { name: chunk.name, size: chunk.size as number, sha256: chunk.sha256, total: chunk.total as number }
      await writeOnce(metaPath, Buffer.from(JSON.stringify(meta)))
    }
    if (chunk.index >= meta.total) throw new Error('Invalid chunk index')
    const bytes = Buffer.from(chunk.dataBase64, 'base64')
    if (bytes.length > TRANSFER_CHUNK_SIZE) throw new Error('Chunk is too large')
    const path = join(dir, String(chunk.index))
    await writeOnce(path, bytes)
    for (let index = 0; index < meta.total; index++) {
      try { await stat(join(dir, String(index))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return { status: 'partial', nextIndex: index }
      }
    }
    const hash = createHash('sha256')
    let size = 0
    for (let index = 0; index < meta.total; index++) {
      const part = await readFile(join(dir, String(index)))
      size += part.length
      hash.update(part)
    }
    if (size !== meta.size || hash.digest('hex') !== meta.sha256) return { status: 'hash_mismatch' }
    return { status: 'received', bytes: size, path: dir }
  }
}
