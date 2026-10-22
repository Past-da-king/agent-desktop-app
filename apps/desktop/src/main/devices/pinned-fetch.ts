/**
 * A `fetch` for talking to another node: HTTPS to a self-signed certificate, accepted only when its fingerprint is
 * the one we paired with (docs/devices-protocol.md s2: fp = base64url(sha256(cert DER))). No CA is involved, so the
 * usual chain check is off and the fingerprint check is the whole of the trust. The request (headers with the pass,
 * and the body) is not written until the fingerprint has been checked, so a pass never reaches a server we did not
 * pair with.
 */
import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'

import { proxyAgent } from './socks'

export function fingerprintOf(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url')
}

export class PinMismatch extends Error {
  constructor() {
    super('The other device answered with a certificate we did not pair with.')
    this.name = 'PinMismatch'
  }
}

/** Only what SyncClient and the health probe use: method, headers, a string body, a signal. */
export function pinnedFetch(fp: string, timeoutMs = 70_000): typeof fetch {
  const wanted = fp.trim()
  const impl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.protocol !== 'https:') {
        reject(new Error('Devices only talk over https.'))
        return
      }
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
      const body = typeof init.body === 'string' ? init.body : undefined
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
      const signal = init.signal ?? null
      if (signal?.aborted === true) {
        reject(abortError())
        return
      }
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
      const req = httpsRequest(
        {
          protocol: 'https:',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          // The chain is not checked (self-signed by design); the pin below is.
          rejectUnauthorized: false,
          // Through the devices proxy when one is set (devices/socks.ts), else direct as before.
          agent: proxyAgent(),
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            const status = res.statusCode ?? 0
            const text = Buffer.concat(chunks).toString('utf8')
            // Response refuses a body for these statuses.
            const empty = status === 204 || status === 304
            resolve(new Response(empty ? null : text, { status: status < 200 || status > 599 ? 502 : status }))
          })
          res.on('error', fail)
        },
      )
      // Nothing is sent until the pin is checked: the headers go out with the first write.
      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          const cert = (socket as TLSSocket).getPeerCertificate()
          const raw: unknown = cert !== null && typeof cert === 'object' ? cert.raw : undefined
          if (!(raw instanceof Buffer) || wanted === '' || fingerprintOf(raw) !== wanted) {
            req.destroy(new PinMismatch())
            return
          }
          req.end(body)
        })
      })
      const onAbort = (): void => {
        req.destroy(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.on('timeout', () => req.destroy(new Error('The other device did not answer in time.')))
      req.on('error', fail)
    })
  return impl as typeof fetch
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
