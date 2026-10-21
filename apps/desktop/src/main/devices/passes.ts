/**
 * Device passes (protocol s1): a 256-bit bearer secret per paired device. Only sha256(pass) is kept, in the
 * secrets module, never in rows or settings. The plain pass exists once: in the pair answer.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { PassTable } from './types'

/** What the secrets module gives this file (main/secrets.ts Secrets). */
export interface SecretsLike {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
}

export const PASS_SECRET = 'devicePasses'

export function newPass(): string {
  return randomBytes(32).toString('base64url')
}

export function hashPass(pass: string): string {
  return createHash('sha256').update(pass, 'utf8').digest('hex')
}

/** Constant-time compare of two hex hashes of equal length. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export class SecretPassTable implements PassTable {
  private cache: Record<string, string> | null = null

  constructor(private readonly secrets: SecretsLike) {}

  all(): Record<string, string> {
    if (this.cache === null) this.cache = this.read()
    return { ...this.cache }
  }

  set(deviceId: string, hash: string): void {
    this.write({ ...this.all(), [deviceId]: hash })
  }

  remove(deviceId: string): void {
    const next = this.all()
    delete next[deviceId]
    this.write(next)
  }

  replaceAll(table: Record<string, string>): void {
    const clean: Record<string, string> = {}
    for (const [id, hash] of Object.entries(table)) {
      if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && id !== '') clean[id] = hash
    }
    this.write(clean)
  }

  /** The device a pass belongs to, or null. */
  deviceFor(pass: string): string | null {
    if (pass === '' || pass.length > 200) return null
    const hash = hashPass(pass)
    let found: string | null = null
    // Every entry is compared so the time taken does not say which one matched.
    for (const [id, stored] of Object.entries(this.all())) {
      if (sameHash(stored, hash)) found = id
    }
    return found
  }

  private read(): Record<string, string> {
    const raw = this.secrets.get(PASS_SECRET)
    if (raw === null || raw === '') return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [id, hash] of Object.entries(parsed as Record<string, unknown>)) if (typeof hash === 'string') out[id] = hash
      return out
    } catch {
      return {}
    }
  }

  private write(table: Record<string, string>): void {
    this.cache = { ...table }
    if (Object.keys(table).length === 0) this.secrets.delete(PASS_SECRET)
    else this.secrets.set(PASS_SECRET, JSON.stringify(table))
  }
}
