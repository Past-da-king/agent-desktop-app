/**
 * Calls one method on another node over its /v1/rpc WebSocket (protocol s5.1), on a TLS connection pinned to the
 * node's certificate before the pass is sent. Used by the headless node to ask a paired computer for things only it
 * can do (fetching a page over its own connection: relay.fetch).
 */
import { randomBytes } from 'node:crypto'

import { WsConnection } from '../main/devices/ws'
import type { DeviceFacts } from '../main/devices/types'
import { pinnedSocket } from './pinned'

export async function callNode(
  base: string,
  fp: string,
  pass: string,
  hello: DeviceFacts,
  method: string,
  args: unknown[],
  timeoutMs = 60_000,
): Promise<unknown> {
  const target = new URL(base)
  const socket = await pinnedSocket(target, fp, 15_000)
  const key = randomBytes(16).toString('base64')
  socket.write(
    [
      'GET /v1/rpc HTTP/1.1',
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${pass}`,
      '',
      '',
    ].join('\r\n'),
  )

  // The answer's headers, then whatever frames came with them.
  const leftover = await new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('The other device did not answer.')), 15_000)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > 16 * 1024) fail(new Error('The other device sent a bad answer.'))
        return
      }
      const head = buffered.subarray(0, end).toString('latin1')
      cleanup()
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)
      if (status !== 101) {
        socket.destroy()
        reject(new Error(status === 401 ? 'The other device does not know this one any more (pair again).' : `The other device said ${status}.`))
        return
      }
      resolve(buffered.subarray(end + 4))
    }
    const fail = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
    }
    socket.on('data', onData)
    socket.once('error', fail)
  })

  const ws = new WsConnection(socket, true)
  return new Promise((resolve, reject) => {
    const id = '1'
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`No answer from the other device in ${Math.round(timeoutMs / 1000)} s.`))
    }, timeoutMs)
    ws.onClose((code) => {
      clearTimeout(timer)
      reject(new Error(`The other device closed the connection (${code}).`))
    })
    ws.onMessage((message) => {
      if (!('text' in message)) return
      let frame: { type?: string; id?: string; ok?: boolean; value?: unknown; error?: string }
      try {
        frame = JSON.parse(message.text) as typeof frame
      } catch {
        return
      }
      if (frame.type !== 'result' || frame.id !== id) return
      clearTimeout(timer)
      // Settle first: closing runs the close listener, which would otherwise answer "closed".
      if (frame.ok === true) resolve(frame.value)
      else reject(new Error(frame.error ?? 'The other device said no.'))
      ws.close()
    })
    if (leftover.length > 0) ws.feed(leftover)
    ws.sendText(JSON.stringify({ type: 'hello', device: hello }))
    ws.sendText(JSON.stringify({ type: 'call', id, method, args }))
  })
}
