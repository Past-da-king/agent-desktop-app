/**
 * Pairing (protocol s3): an offer valid 10 minutes, single use, 5 wrong tries; the agent://pair URI the QR code
 * carries; the 8-character short code; and POST /v1/pair, which issues a device id and a pass.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { cleanFacts, cleanRoles } from './facts'
import { newId } from './identity'
import { hashPass, newPass } from './passes'
import type { BrainRef, DeviceFacts, DeviceRecord, DeviceRole, PassTable } from './types'

export const OFFER_MS = 10 * 60 * 1000
export const MAX_WRONG = 5
/** No 0/O and no 1/I, so it reads back without doubt. */
export const SHORT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function makeShortCode(random: (n: number) => Buffer = randomBytes): string {
  // 32 letters: the low five bits of a byte pick one evenly.
  return [...random(8)].map((b) => SHORT_ALPHABET[b & 31] ?? 'A').join('')
}

export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`
}

/** What a person typed, as the bare code: capitals, no dash or spaces. */
export function normaliseShortCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export interface PairingOffer {
  /** 128-bit secret, base64url (the QR's `c`). */
  secret: string
  shortCode: string
  createdAt: number
  expiresAt: number
}

export type ConsumeResult = { ok: true } | { ok: false; reason: 'none' | 'expired' | 'wrong' }

export class PairingOffers {
  private offer: PairingOffer | null = null
  private wrong = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** A new offer; the one before it stops working. */
  create(): PairingOffer {
    const at = this.now()
    this.offer = { secret: randomBytes(16).toString('base64url'), shortCode: makeShortCode(), createdAt: at, expiresAt: at + OFFER_MS }
    this.wrong = 0
    return { ...this.offer }
  }

  current(): PairingOffer | null {
    if (this.offer !== null && this.now() >= this.offer.expiresAt) this.offer = null
    return this.offer === null ? null : { ...this.offer }
  }

  cancel(): void {
    this.offer = null
    this.wrong = 0
  }

  /** Checks a code (the QR secret or the short code) and uses the offer up when it matches. */
  consume(code: string): ConsumeResult {
    const offer = this.offer
    if (offer === null) return { ok: false, reason: 'none' }
    if (this.now() >= offer.expiresAt) {
      this.offer = null
      return { ok: false, reason: 'expired' }
    }
    const clean = code.trim()
    const matches = sameText(clean, offer.secret) || sameText(normaliseShortCode(clean), offer.shortCode)
    if (matches) {
      this.offer = null
      this.wrong = 0
      return { ok: true }
    }
    this.wrong += 1
    if (this.wrong >= MAX_WRONG) this.cancel()
    return { ok: false, reason: 'wrong' }
  }
}

export interface PairUriParts {
  meshId: string
  nodeId: string
  name: string
  urls: string[]
  fp: string
  secret: string
}

export function pairUri(parts: PairUriParts): string {
  const e = encodeURIComponent
  return (
    `agent://pair?v=1&mesh=${e(parts.meshId)}&node=${e(parts.nodeId)}&name=${e(parts.name)}` +
    `&u=${parts.urls.map(e).join(',')}&fp=${e(parts.fp)}&c=${e(parts.secret)}`
  )
}

export function parsePairUri(uri: string): PairUriParts | null {
  if (!uri.startsWith('agent://pair?')) return null
  const query = uri.slice('agent://pair?'.length)
  const values = new Map<string, string>()
  for (const part of query.split('&')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    values.set(part.slice(0, at), part.slice(at + 1))
  }
  if (values.get('v') !== '1') return null
  try {
    const d = (key: string): string => decodeURIComponent(values.get(key) ?? '')
    const urls = (values.get('u') ?? '').split(',').filter((u) => u !== '').map((u) => decodeURIComponent(u))
    const parts = { meshId: d('mesh'), nodeId: d('node'), name: d('name'), urls, fp: d('fp'), secret: d('c') }
    if (parts.meshId === '' || parts.nodeId === '' || parts.fp === '' || parts.secret === '') return null
    return parts
  } catch {
    return null
  }
}

export interface PairDeps {
  offers: PairingOffers
  passes: PassTable
  meshId: string
  node: { id: string; name: string }
  /** Writes (or rewrites) the new device's row. */
  saveDevice(row: DeviceRecord): Promise<void>
  /** Every brain the new device may try, this node included, by priority. */
  brains(): Promise<BrainRef[]>
  /** The next priority number for a new brain (after the last one). */
  nextPriority(): Promise<number>
  now?: () => number
}

export type PairAnswer =
  | { status: 200; json: { deviceId: string; pass: string; meshId: string; node: { id: string; name: string }; brains: BrainRef[] } }
  | { status: 400 | 403 | 410; json: { error: string } }

const NODE_ID = /^dev_[A-Za-z0-9_-]{8,64}$/

/** POST /v1/pair. Checks the code first so a wrong body never burns the offer's tries for nothing. */
export async function handlePair(body: unknown, deps: PairDeps): Promise<PairAnswer> {
  const value = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const facts: DeviceFacts | null = cleanFacts(value['device'])
  if (facts === null) return { status: 400, json: { error: 'Say what kind of device this is.' } }
  const code = typeof value['code'] === 'string' ? value['code'].slice(0, 200) : ''
  if (code === '') return { status: 400, json: { error: 'The pairing code is missing.' } }
  const checked = deps.offers.consume(code)
  if (!checked.ok) {
    if (checked.reason === 'wrong') return { status: 403, json: { error: 'That code does not match. Check it on the computer and try again.' } }
    return { status: 410, json: { error: 'That code has run out. Make a new one on the computer.' } }
  }
  let roles: DeviceRole[] = cleanRoles(value['wantRoles'])
  if (roles.length === 0) roles = ['screen']
  const now = (deps.now ?? Date.now)()
  // A node (it shows a certificate) keeps the id it already has, so every node in the mesh knows it by one name.
  const asked = typeof value['nodeId'] === 'string' ? value['nodeId'] : ''
  const deviceId = facts.fingerprint !== '' && NODE_ID.test(asked) && asked !== deps.node.id ? asked : newId('dev_')
  const pass = newPass()
  deps.passes.set(deviceId, hashPass(pass))
  const priority = roles.includes('brain') ? await deps.nextPriority() : 0
  await deps.saveDevice({
    id: deviceId,
    name: facts.name,
    kind: facts.kind,
    platform: facts.platform,
    roles,
    priority,
    urls: facts.urls,
    fp: facts.fingerprint,
    facts,
    pairedAt: now,
    lastSeen: now,
    revoked: false,
  })
  return { status: 200, json: { deviceId, pass, meshId: deps.meshId, node: deps.node, brains: await deps.brains() } }
}
