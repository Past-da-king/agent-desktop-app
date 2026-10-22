/**
 * The smallest WebSocket (RFC 6455) this node needs, server side, plus a client for tests and node-to-node calls.
 * Text and binary messages, fragmentation, ping/pong and close. No extensions, no compression. `ws` is not in the
 * tree, and this is about two hundred lines.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const MAX_MESSAGE = 48 * 1024 * 1024

export const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** One frame. Clients must mask (`mask` true); servers must not. */
export function encodeFrame(opcode: number, payload: Buffer, mask = false, fin = true): Buffer {
  const len = payload.length
  const head: number[] = [(fin ? 0x80 : 0) | opcode]
  const maskBit = mask ? 0x80 : 0
  if (len < 126) head.push(maskBit | len)
  else if (len < 65536) head.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff)
  else {
    head.push(maskBit | 127)
    const big = Buffer.alloc(8)
    big.writeBigUInt64BE(BigInt(len))
    head.push(...big)
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload])
  const key = randomBytes(4)
  const body = Buffer.alloc(len)
  for (let i = 0; i < len; i += 1) body[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0)
  return Buffer.concat([Buffer.from(head), key, body])
}

export interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
  masked: boolean
}

/** Feeds bytes in, gives whole frames out. Throws on a frame bigger than `max`. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly max = MAX_MESSAGE) {}

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === null) break
      frames.push(frame)
    }
    return frames
  }

  private next(): Frame | null {
    const b = this.buffer
    if (b.length < 2) return null
    const first = b[0] ?? 0
    const second = b[1] ?? 0
    const masked = (second & 0x80) !== 0
    let len = second & 0x7f
    let offset = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = b.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(this.max)) throw new Error('Frame too large')
      len = Number(big)
      offset = 10
    }
    if (len > this.max) throw new Error('Frame too large')
    const keyLen = masked ? 4 : 0
    if (b.length < offset + keyLen + len) return null
    const key = masked ? b.subarray(offset, offset + 4) : null
    const start = offset + keyLen
    const payload = Buffer.from(b.subarray(start, start + len))
    if (key !== null) for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0)
    this.buffer = b.subarray(start + len)
    return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload, masked }
  }
}

export type SocketMessage = { text: string } | { binary: Buffer }

/** One open WebSocket over a raw socket (either side). */
export class WsConnection {
  private readonly reader: FrameReader
  private parts: Buffer[] = []
  private partsOpcode = 0
  private partsSize = 0
  private closed = false
  private readonly messageListeners = new Set<(message: SocketMessage) => void>()
  private readonly closeListeners = new Set<(code: number) => void>()

  constructor(
    private readonly socket: Duplex,
    /** Client side masks what it sends and expects unmasked frames back. */
    private readonly isClient: boolean,
    max = MAX_MESSAGE,
  ) {
    this.reader = new FrameReader(max)
    socket.on('data', (chunk: Buffer) => this.feed(chunk))
    socket.on('close', () => this.finish(1006))
    socket.on('error', () => this.finish(1006))
  }

  get isOpen(): boolean {
    return !this.closed
  }

  onMessage(listener: (message: SocketMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (code: number) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  sendText(text: string): void {
    this.write(OP.text, Buffer.from(text, 'utf8'))
  }

  ping(): void {
    this.write(OP.ping, Buffer.alloc(0))
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this.write(OP.close, body)
    this.finish(code)
    this.socket.end()
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(encodeFrame(opcode, payload, this.isClient))
  }

  /** Bytes read off the socket (or left over from the upgrade request). */
  feed(chunk: Buffer): void {
    let frames: Frame[]
    try {
      frames = this.reader.push(chunk)
    } catch {
      this.close(1009, 'too big')
      return
    }
    for (const frame of frames) {
      // A server must refuse unmasked client frames (RFC 6455 5.1).
      if (!this.isClient && !frame.masked) {
        this.close(1002, 'unmasked')
        return
      }
      if (frame.opcode === OP.ping) this.write(OP.pong, frame.payload)
      else if (frame.opcode === OP.pong) continue
      else if (frame.opcode === OP.close) {
        if (!this.closed) {
          this.write(OP.close, frame.payload.subarray(0, 2))
          this.finish(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005)
          this.socket.end()
        }
        return
      } else this.onDataFrame(frame)
    }
  }

  private onDataFrame(frame: Frame): void {
    if (frame.opcode !== OP.cont) {
      this.parts = []
      this.partsSize = 0
      this.partsOpcode = frame.opcode
    }
    this.parts.push(frame.payload)
    this.partsSize += frame.payload.length
    if (this.partsSize > MAX_MESSAGE) {
      this.close(1009, 'too big')
      return
    }
    if (!frame.fin) return
    const whole = Buffer.concat(this.parts)
    this.parts = []
    this.partsSize = 0
    const message: SocketMessage = this.partsOpcode === OP.binary ? { binary: whole } : { text: whole.toString('utf8') }
    for (const listener of this.messageListeners) listener(message)
  }

  private finish(code: number): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(code)
    this.messageListeners.clear()
    this.closeListeners.clear()
  }
}

/** Answers an upgrade request. Null (and the socket is refused) when it is not a valid WebSocket request. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
  const key = req.headers['sec-websocket-key']
  const upgrade = String(req.headers['upgrade'] ?? '').toLowerCase()
  if (typeof key !== 'string' || key === '' || upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return null
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  )
  const connection = new WsConnection(socket, false)
  if (head.length > 0) connection.feed(head)
  return connection
}
