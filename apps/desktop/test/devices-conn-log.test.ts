/**
 * 22 Oct 2026: a phone reconnected to the node about 15 times a second and main.log said nothing. The node now says
 * why it refuses a link (in the log and in the answer), and counts repeats instead of flooding the log.
 */
import { request } from 'node:https'

import { afterEach, describe, expect, it } from 'vitest'

import { makeSelfSignedCert } from '../src/main/devices/cert'
import { ConnectionLog, STORM_LINKS, WINDOW_MS, peerOf } from '../src/main/devices/conn-log'
import { DevicesServer } from '../src/main/devices/server'
import type { DeviceFacts } from '../src/main/devices/types'

type Line = { message: string; detail?: Record<string, unknown> }

describe('connection log', () => {
  it('logs the first of a kind in a minute, then sums up the repeats', () => {
    const lines: Line[] = []
    let now = 1_000
    const log = new ConnectionLog((message, detail) => lines.push({ message, detail }), () => now)
    for (let i = 0; i < 50; i += 1) log.note('ws-401:unknown-pass:1.2.3.4', 'Devices link refused', { reason: 'unknown-pass' })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toEqual({ reason: 'unknown-pass' })
    now += WINDOW_MS
    log.flush()
    expect(lines).toHaveLength(2)
    expect(lines[1]?.message).toBe('Devices link refused (repeats)')
    expect(lines[1]?.detail?.['repeats']).toBe(49)
    log.stop()
  })

  it('says when one device keeps opening short links', () => {
    const lines: Line[] = []
    let now = 0
    const log = new ConnectionLog((message, detail) => lines.push({ message, detail }), () => now)
    for (let i = 0; i < STORM_LINKS + 5; i += 1) {
      now += 70
      log.linkEnded('dev_phone', 40, { code: 1000 })
    }
    const storm = lines.filter((l) => l.message === 'Device reconnecting fast')
    expect(storm).toHaveLength(1)
    expect(storm[0]?.detail?.['device']).toBe('dev_phone')
    // The closes themselves: one line, the rest counted.
    expect(lines.filter((l) => l.message === 'Device link closed')).toHaveLength(1)
    log.stop()
  })

  it('names the far end by address only', () => {
    expect(peerOf({ remoteAddress: '::ffff:192.168.1.42' })).toBe('192.168.1.42')
    expect(peerOf({ remoteAddress: undefined })).toBe('unknown')
  })
})

const PHONE: DeviceFacts = { name: 'A35', kind: 'phone', platform: 'android', appVersion: '0.14.5', screen: { width: 400, height: 800 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }

function upgrade(port: number, pass: string | null): Promise<{ status: number; body: string; refused: string | undefined }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    if (pass !== null) headers['Authorization'] = `Bearer ${pass}`
    const req = request({ host: '127.0.0.1', port, path: '/v1/rpc', headers, rejectUnauthorized: false })
    req.on('response', (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, refused: res.headers['x-agent-refused'] as string | undefined }))
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 101, body: '', refused: undefined })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the node says why it refuses a link', () => {
  let server: DevicesServer | null = null
  afterEach(async () => {
    await server?.stop()
    server = null
  })

  it('answers 401 with a reason, logs it once, and lets a paired device in', async () => {
    const cert = makeSelfSignedCert('test-node')
    const lines: Line[] = []
    server = new DevicesServer({
      keyPem: cert.keyPem,
      certPem: cert.certPem,
      deviceForPass: (pass) => (pass === 'good' ? 'dev_phone' : pass === 'gone' ? 'dev_old' : null),
      rolesOf: (id) => (id === 'dev_phone' ? ['screen'] : null),
      self: () => ({ id: 'dev_node', facts: { ...PHONE, kind: 'desktop', name: 'node' } }),
      callRpc: async () => null,
      log: (message, detail) => lines.push({ message, detail }),
    })
    await server.start('127.0.0.1', 0)
    const port = server.port()

    const unknown = await upgrade(port, 'old-pass-from-before')
    expect(unknown.status).toBe(401)
    expect(unknown.refused).toBe('unknown-pass')
    expect(JSON.parse(unknown.body)).toMatchObject({ reason: 'unknown-pass' })
    await upgrade(port, 'old-pass-from-before')
    await upgrade(port, 'old-pass-from-before')
    const refused = lines.filter((l) => l.message === 'Devices link refused')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.detail).toMatchObject({ reason: 'unknown-pass', from: '127.0.0.1' })
    // Never the pass itself.
    expect(JSON.stringify(lines)).not.toContain('old-pass-from-before')

    const revoked = await upgrade(port, 'gone')
    expect(revoked.refused).toBe('revoked')
    expect(lines.some((l) => l.message === 'Devices link refused' && l.detail?.['reason'] === 'revoked' && l.detail?.['device'] === 'dev_old')).toBe(true)

    const none = await upgrade(port, null)
    expect(none.refused).toBe('no-pass')

    const ok = await upgrade(port, 'good')
    expect(ok.status).toBe(101)
    expect(lines.some((l) => l.message === 'Device connected' && l.detail?.['device'] === 'dev_phone')).toBe(true)
  })
})
