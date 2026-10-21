/**
 * A tiny real WebSocket server on 127.0.0.1 standing in for the Gemini Live endpoint, so the transcriber is
 * tested over a real socket with Node's own WebSocket client (the one the app uses). Text frames only.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

export interface LiveConnection {
  url: string
  received: Array<Record<string, unknown>>
  send(message: unknown): void
  close(code?: number): void
}

export interface FakeLive {
  url: string
  connections: LiveConnection[]
  close(): Promise<void>
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** Reads whole client frames (always masked) from the buffer; returns what is left. */
function readFrames(buffer: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {
  let rest = buffer
  while (rest.length >= 2) {
    const opcode = (rest[0] ?? 0) & 0x0f
    let length = (rest[1] ?? 0) & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) break
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) break
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    if (rest.length < offset + 4 + length) break
    const mask = rest.subarray(offset, offset + 4)
    const payload = Buffer.from(rest.subarray(offset + 4, offset + 4 + length))
    for (let index = 0; index < payload.length; index += 1) payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
    onFrame(opcode, payload)
    rest = rest.subarray(offset + 4 + length)
  }
  return rest
}

export async function startFakeLive(onMessage: (connection: LiveConnection, message: Record<string, unknown>) => void): Promise<FakeLive> {
  const connections: LiveConnection[] = []
  const sockets = new Set<Duplex>()
  const server: Server = createServer((_request, response) => {
    response.writeHead(426)
    response.end()
  })
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const key = String(request.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    )
    let open = true
    const connection: LiveConnection = {
      url: request.url ?? '',
      received: [],
      send: (message) => {
        if (open) socket.write(frame(typeof message === 'string' ? message : JSON.stringify(message)))
      },
      close: (code = 1000) => {
        if (!open) return
        open = false
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(code, 0)
        socket.write(Buffer.concat([Buffer.from([0x88, 2]), payload]))
        socket.end()
      },
    }
    connections.push(connection)
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = readFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
        if (opcode === 0x8) {
          if (open) {
            open = false
            socket.write(Buffer.from([0x88, 0]))
            socket.end()
          }
          return
        }
        if (opcode !== 0x1) return
        const message = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
        connection.received.push(message)
        onMessage(connection, message)
      })
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    connections,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
