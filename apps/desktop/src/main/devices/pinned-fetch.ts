/**
 * A `fetch` for talking to another node: HTTPS to a self-signed certificate, accepted only when its fingerprint is
 * the one we paired with (docs/devices-protocol.md s2: fp = base64url(sha256(cert DER))). No CA is involved, so the
 * usual chain check is off and the fingerprint check is the whole of the trust. The request (headers with the pass,
 * and the body) is not written until the fingerprint has been checked, so a pass never reaches a server we did not
 * pair with.
 *
 * Connections are kept open and reused per address (socks.ts keptAgent): a new TCP and TLS handshake for every
 * replication request over a relayed VPN path timed out often enough to drop the link (29 Oct 2026). The pin is
 * checked on every request, on a reused socket too, and a request whose reused socket was closed by the other side
 * before any answer goes once more on a fresh one.
 */
import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'

import { keptAgent } from './socks'

export function fingerprintOf(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url')
}

export class PinMismatch extends Error {
  constructor() {
    super('The other device answered with a certificate we did not pair with.')
    this.name = 'PinMismatch'
  }
}

/** Errors a kept-alive socket gives when the other side closed it while it sat idle: worth one more try. */
const STALE_SOCKET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])

/** Only what SyncClient and the health probe use: method, headers, a string body, a signal. */
export function pinnedFetch(fp: string, timeoutMs = 70_000): typeof fetch {
  const wanted = fp.trim()
  const once = (url: URL, init: RequestInit, retry: boolean): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
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
      let answered = false
      const fail = (error: Error & { code?: string }): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        // A kept socket the other side had closed: nothing was answered, so the request goes once more on a new one.
        if (retry && !answered && req.reusedSocket && signal?.aborted !== true && (STALE_SOCKET.has(error.code ?? '') || error.message === 'socket hang up')) {
          once(url, init, false).then(resolve, reject)
          return
        }
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
          // Kept open and reused per address; through the devices proxy when one is set (devices/socks.ts).
          agent: keptAgent(url.hostname),
          timeout: timeoutMs,
        },
        (res) => {
          answered = true
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
      // Nothing is sent until the pin is checked: the headers go out with the first write. A reused socket finished its
      // handshake long ago, so its certificate is checked straight away; a new one once its handshake is done.
      req.on('socket', (socket) => {
        const tls = socket as TLSSocket
        const check = (): void => {
          const cert = tls.getPeerCertificate()
          const raw: unknown = cert !== null && typeof cert === 'object' ? cert.raw : undefined
          if (!(raw instanceof Buffer) || wanted === '' || fingerprintOf(raw) !== wanted) {
            req.destroy(new PinMismatch())
            return
          }
          req.end(body)
        }
        if (req.reusedSocket) check()
        else socket.once('secureConnect', check)
      })
      const onAbort = (): void => {
        req.destroy(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.on('timeout', () => req.destroy(new Error('The other device did not answer in time.')))
      req.on('error', fail)
    })
  const impl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== 'https:') return Promise.reject(new Error('Devices only talk over https.'))
    return once(url, init, true)
  }
  return impl as typeof fetch
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
