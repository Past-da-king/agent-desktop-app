/**
 * HTTPS by default. Plain http:// is only allowed to this computer itself (loopback) or when the
 * user has explicitly opted in for a self-hosted server on a network they trust.
 */
import { ProviderException } from './model'

export const NEEDS_OPT_IN =
  'This server uses plain HTTP, which does not encrypt your requests or API key. Use an https:// address, or tick "Allow unencrypted HTTP for this server".'

export function isHttp(url: string): boolean {
  return url.trim().toLowerCase().startsWith('http://')
}

/** True for http(s)://localhost, 127.x.x.x and [::1]. */
export function isLoopback(url: string): boolean {
  let host: string
  try {
    host = new URL(url.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/** Null if the URL may be used; otherwise a message the user can act on. */
export function blockReason(url: string, allowHttp: boolean): string | null {
  const u = url.trim()
  if (u.toLowerCase().startsWith('https://')) return null
  if (isHttp(u)) {
    return allowHttp || isLoopback(u) ? null : NEEDS_OPT_IN
  }
  return 'The base URL must start with https:// (or http:// with the opt-in).'
}

export function check(url: string, allowHttp: boolean): void {
  const reason = blockReason(url, allowHttp)
  if (reason !== null) throw new ProviderException(reason)
}
