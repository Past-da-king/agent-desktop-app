/**
 * The running node's local control line: a Unix socket in the data folder (0600, so only this user), one JSON
 * request and one JSON answer per connection. The CLI uses it for what Settings > Devices does on a desktop:
 * make a pairing offer, list, reorder and revoke devices. Nothing on the network can reach it.
 */
import { chmodSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { join } from 'node:path'

import { DEVICES_CHANNELS } from '../shared/devices-channels'
import type { HandlerTable } from './runtime'

/** What the control line may call: the Devices settings, nothing else. */
const ALLOWED: ReadonlySet<string> = new Set([
  DEVICES_CHANNELS.status,
  DEVICES_CHANNELS.offer,
  DEVICES_CHANNELS.cancelOffer,
  DEVICES_CHANNELS.list,
  DEVICES_CHANNELS.setRoles,
  DEVICES_CHANNELS.move,
  DEVICES_CHANNELS.revoke,
  DEVICES_CHANNELS.setExtraUrls,
  // The overlay network (agent-node net); the key arrives over this owner-only local socket, never argv.
  DEVICES_CHANNELS.setNetwork,
])

export function controlPath(dataDir: string): string {
  return join(dataDir, 'control.sock')
}

export async function startControl(dataDir: string, ipc: HandlerTable): Promise<Server> {
  const path = controlPath(dataDir)
  rmSync(path, { force: true })
  const server = createServer((socket) => {
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      text += chunk
      if (text.length > 64 * 1024) socket.destroy()
      const end = text.indexOf('\n')
      if (end < 0) return
      void (async () => {
        let answer: unknown
        try {
          const request = JSON.parse(text.slice(0, end)) as { channel?: unknown; args?: unknown }
          const channel = typeof request.channel === 'string' ? request.channel : ''
          if (!ALLOWED.has(channel)) throw new Error('not available here')
          const args = Array.isArray(request.args) ? request.args : []
          answer = { ok: true, value: await ipc.invoke(channel, args, 'control') }
        } catch (error) {
          answer = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        socket.end(`${JSON.stringify(answer)}\n`)
      })()
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  chmodSync(path, 0o600)
  return server
}

export function callControl(dataDir: string, channel: string, args: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath(dataDir))
    let text = ''
    socket.setEncoding('utf8')
    socket.setTimeout(15_000, () => socket.destroy(new Error('The node did not answer.')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ channel, args })}\n`))
    socket.on('data', (chunk: string) => (text += chunk))
    socket.on('end', () => {
      try {
        const answer = JSON.parse(text) as { ok?: boolean; value?: unknown; error?: string }
        if (answer.ok === true) resolve(answer.value)
        else reject(new Error(answer.error ?? 'The node said no.'))
      } catch {
        reject(new Error('The node gave no answer.'))
      }
    })
    socket.on('error', (error) => reject(new Error(`The node is not running here (${error.message}).`)))
  })
}

/** A QR code for a terminal: two rows per line in half blocks, dark on the terminal's light, with a quiet zone. */
export function terminalQr(matrix: boolean[][]): string {
  const size = matrix.length
  const pad = 2
  const at = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < size && c < size && matrix[r]?.[c] === true
  const lines: string[] = []
  for (let r = -pad; r < size + pad; r += 2) {
    let line = ''
    for (let c = -pad; c < size + pad; c++) {
      const top = at(r, c)
      const bottom = at(r + 1, c)
      // Inverted so it scans on a dark terminal: a dark module is drawn as a space.
      line += top ? (bottom ? ' ' : '▄') : bottom ? '▀' : '█'
    }
    lines.push(line)
  }
  return lines.join('\n')
}
