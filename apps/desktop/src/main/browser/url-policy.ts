/**
 * What the agent's browser may open. Ported from the spirit of the phone browser: only real web
 * pages, never local files, browser internals or script addresses. Private network addresses are
 * allowed only when the person typed the address themselves, because the model must not be able to
 * wander into the machine's own network on its own.
 */

export interface UrlPolicyOptions {
  /** True when a human supplied the address (taking over the browser), false for the agent. */
  personTyped?: boolean
}

export type UrlPolicyResult =
  | { ok: true; url: string }
  | { ok: false; reason: string }

const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** Validates and normalises a web address. A bare domain becomes https://domain. */
export function checkBrowserUrl(raw: string, options: UrlPolicyOptions = {}): UrlPolicyResult {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'Pass a web address.' }

  const candidate = SCHEME.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' }
  }

  if (!WEB_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'Only web addresses (http and https) can be opened.' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'Addresses with a username or password built in are not allowed.' }
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '') return { ok: false, reason: 'That address has no website in it.' }

  if (options.personTyped !== true) {
    const privateReason = privateHostReason(host)
    if (privateReason !== null) {
      return {
        ok: false,
        reason: `${privateReason} Only you can open that address, not the agent on its own.`,
      }
    }
  }

  return { ok: true, url: url.toString() }
}

/** Null when the host is on the public internet; otherwise a short plain-words reason. */
export function privateHostReason(host: string): string | null {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (clean === '') return 'That address has no website in it.'
  if (clean === 'localhost' || clean.endsWith('.localhost')) return 'That address is this computer.'
  if (clean.endsWith('.local') || clean.endsWith('.internal') || clean.endsWith('.lan') || clean.endsWith('.home.arpa')) {
    return 'That address is on a private network.'
  }
  // A name with no dot is a local machine name, never a website on the public internet.
  if (!clean.includes('.') && !clean.includes(':')) return 'That address is a local name.'
  if (clean === '0.0.0.0') return 'That address is this computer.'

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return privateIpv4(clean)
  if (clean.includes(':')) return privateIpv6(clean)
  return null
}

function privateIpv4(address: string): string | null {
  const parts = address.split('.').map((part) => Number(part))
  const a = parts[0]
  const b = parts[1]
  if (a === undefined || b === undefined) return null
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null

  if (a === 0 || a === 10 || a === 127) return 'That address is this computer or its network.'
  if (a === 169 && b === 254) return 'That address is a link-local address.'
  if (a === 172 && b >= 16 && b <= 31) return 'That address is on a private network.'
  if (a === 192 && b === 168) return 'That address is on a private network.'
  if (a === 100 && b >= 64 && b <= 127) return 'That address is on a carrier network.'
  if (a === 198 && (b === 18 || b === 19)) return 'That address is reserved for testing.'
  if (a >= 224) return 'That address is not a normal website.'
  return null
}

function privateIpv6(address: string): string | null {
  const clean = address.toLowerCase()
  if (clean === '::1') return 'That address is this computer.'
  if (clean === '::' || clean === '') return 'That address is not a normal website.'
  if (clean.startsWith('fc') || clean.startsWith('fd')) return 'That address is on a private network.'
  if (/^fe[89ab]/.test(clean)) return 'That address is a link-local address.'
  const mapped = clean.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped !== null && mapped[1] !== undefined) return privateIpv4(mapped[1])
  const mappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex !== null && mappedHex[1] !== undefined && mappedHex[2] !== undefined) {
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return null
}
