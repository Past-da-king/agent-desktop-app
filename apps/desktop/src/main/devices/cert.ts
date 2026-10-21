/**
 * A self-signed ECDSA P-256 X.509 certificate made in-process (protocol s2). Node's crypto makes keys and signs but
 * has no certificate writer, so this file carries the few DER pieces a certificate needs. No dependency.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

// ---- DER ----

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let rest = n
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content])
}

export const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 + n, inner)

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const first = parts[0] ?? 0
  const second = parts[1] ?? 0
  const bytes: number[] = [first * 40 + second]
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f]
    let rest = Math.floor(part / 128)
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80)
      rest = Math.floor(rest / 128)
    }
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** A non-negative INTEGER from big-endian bytes. */
export function integer(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1
  let body = bytes.subarray(start)
  if (((body[0] ?? 0) & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body])
  return tlv(0x02, body)
}

const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'))
const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]))
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes)
const boolTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]))

/** UTCTime before 2050, GeneralizedTime from then on (RFC 5280 4.1.2.5). */
export function time(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const year = date.getUTCFullYear()
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  if (year < 2050) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, 'ascii'))
  return tlv(0x18, Buffer.from(`${year}${rest}`, 'ascii'))
}

// ---- the certificate ----

const ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const COMMON_NAME = '2.5.4.3'
const BASIC_CONSTRAINTS = '2.5.29.19'
const KEY_USAGE = '2.5.29.15'
const EXT_KEY_USAGE = '2.5.29.37'
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

export interface NodeCert {
  /** PKCS#8 PEM of the private key. Lives only in the node's devices folder. */
  keyPem: string
  certPem: string
  certDer: Buffer
}

export function makeSelfSignedCert(commonName: string, now: Date = new Date(), years = 20): NodeCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return certFor(privateKey, publicKey, commonName, now, years)
}

function certFor(privateKey: KeyObject, publicKey: KeyObject, commonName: string, now: Date, years: number): NodeCert {
  const algorithm = seq(oid(ECDSA_SHA256))
  const name = seq(set(seq(oid(COMMON_NAME), utf8(commonName))))
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  const notAfter = new Date(now.getTime())
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years)
  const serial = randomBytes(16)
  serial[0] = (serial[0] ?? 0) & 0x7f
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  // digitalSignature only (bit 0): an ECDHE-ECDSA server key signs the handshake.
  const keyUsage = tlv(0x03, Buffer.from([0x07, 0x80]))
  const extensions = seq(
    seq(oid(BASIC_CONSTRAINTS), boolTrue(), octetString(seq())),
    seq(oid(KEY_USAGE), boolTrue(), octetString(keyUsage)),
    seq(oid(EXT_KEY_USAGE), octetString(seq(oid(SERVER_AUTH), oid(CLIENT_AUTH)))),
  )
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    explicit(3, extensions),
  )
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const certDer = seq(tbs, algorithm, bitString(signature))
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem: toPem(certDer, 'CERTIFICATE'),
    certDer,
  }
}

export function toPem(der: Buffer, label: string): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

export function derFromPem(pem: string): Buffer {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

/** fp = base64url(sha256(cert DER)) (protocol s2). */
export function fingerprintOf(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url')
}
