/**
 * HTTPS to another node, pinned by certificate fingerprint (protocol s2). The TLS handshake finishes and the peer's
 * certificate is checked BEFORE a single byte of the request (a pairing code, a pass) is written. With no pin
 * (pairing by short code), the certificate is trusted on first use and its fingerprint is returned to be stored.
 */
// Plain http over the TLS socket that was already checked: the request can never open a second, unchecked connection.
import { request } from 'node:http'
import { connect, type TLSSocket } from 'node:tls'

import { fingerprintOf } from './node-config'

export interface PinnedReply {
  status: number
  json: unknown
  /** The fingerprint the peer presented. */
  fp: string
}

export interface PinnedOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** Expected fingerprint; '' or undefined trusts on first use. */
  fp?: string
  pass?: string
  timeoutMs?: number
}

export async function pinnedJson(url: string, options: PinnedOptions = {}): Promise<PinnedReply> {
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error('Nodes only talk over https.')
  const port = target.port === '' ? 443 : Number(target.port)
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const timeoutMs = options.timeoutMs ?? 15_000

  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const isName = !/^[\d.]+$/.test(host) && !host.includes(':')
    const tls = connect({ host, port, rejectUnauthorized: false, ...(isName ? { servername: host } : {}) })
    const timer = setTimeout(() => {
      tls.destroy()
      reject(new Error(`No answer from ${target.host} in ${Math.round(timeoutMs / 1000)} s.`))
    }, timeoutMs)
    tls.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(tls)
    })
    tls.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  const peer = socket.getPeerCertificate(false)
  const fp = peer.raw === undefined ? '' : fingerprintOf(peer.raw)
  const expected = options.fp ?? ''
  if (fp === '' || (expected !== '' && fp !== expected)) {
    socket.destroy()
    throw new Error('The other device showed a different certificate than the one in the pairing code. Nothing was sent.')
  }

  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8')
  return new Promise<PinnedReply>((resolve, reject) => {
    const req = request(
      {
        method: options.method ?? (payload === undefined ? 'GET' : 'POST'),
        host,
        port,
        path: `${target.pathname}${target.search}`,
        createConnection: () => socket,
        headers: {
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
          ...(options.pass === undefined ? {} : { authorization: `Bearer ${options.pass}` }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = null
          try {
            json = text === '' ? null : (JSON.parse(text) as unknown)
          } catch {
            json = { error: text.slice(0, 300) }
          }
          resolve({ status: res.statusCode ?? 0, json, fp })
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`No answer from ${target.host}.`)))
    req.on('error', reject)
    req.end(payload)
  })
}
