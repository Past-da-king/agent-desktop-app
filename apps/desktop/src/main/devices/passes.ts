/**
 * Device passes (protocol s1): a 256-bit bearer secret per paired device. Only sha256(pass) is kept, in the
 * secrets module, never in rows or settings. The plain pass exists once: in the pair answer.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { PassTable, PairingAuthority, DeviceRole } from './types'

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

  set(deviceId: string, hash: string, pairedAt = Date.now()): void {
    const authority = this.authority()
    const old = authority[deviceId]
    // A pass older than the known pairing would never validate: move it just past instead of dropping it without a word.
    if (old && pairedAt <= old.deniedAt) return
    if (old && pairedAt < old.pairedAt) pairedAt = old.pairedAt + 1
    authority[deviceId] = {
      pairedAt,
      deniedAt: old?.deniedAt ?? -1,
      roles: old?.roles ?? [],
    }
    this.writeAuthority(authority)
    this.write({ ...this.all(), [deviceId]: hash })
  }

  remove(deviceId: string, deniedAt?: number): void {
    const authority = this.authority(),
      old = authority[deviceId]
    // Repeated row refreshes must neither move the deny forward nor rewrite secrets.
    if (
      deniedAt === undefined &&
      old &&
      old.deniedAt >= old.pairedAt &&
      !this.all()[deviceId]
    )
      return
    // A local forget or revoke always wins, even when another brain's clock ran ahead of ours.
    // A replicated deny older than a later pairing belongs to the earlier pairing and is ignored.
    const at = deniedAt ?? Math.max(Date.now(), old?.pairedAt ?? 0)
    if (old && at < old.pairedAt) return
    authority[deviceId] = {
      pairedAt: old?.pairedAt ?? 0,
      deniedAt: Math.max(at, old?.deniedAt ?? 0),
      roles: [],
    }
    const next = this.all()
    delete next[deviceId]
    this.writeAuthority(authority)
    this.write(next)
  }

  replaceAll(
    table: Record<string, string>,
    incoming: Record<string, PairingAuthority> = {},
  ): void {
    const authority = this.authority(),
      current = this.all(),
      clean: Record<string, string> = {}
    for (const id of new Set([
      ...Object.keys(authority),
      ...Object.keys(table),
      ...Object.keys(incoming),
    ])) {
      const local = authority[id],
        remote = incoming[id]
      const valid =
        remote &&
        Number.isFinite(remote.pairedAt) &&
        Number.isFinite(remote.deniedAt) &&
        Array.isArray(remote.roles)
      const newest =
        valid && (!local || remote.pairedAt > local.pairedAt) ? remote : local
      const deniedAt = Math.max(
        local?.deniedAt ?? -1,
        valid ? remote.deniedAt : -1,
      )
      if (newest)
        authority[id] = {
          pairedAt: newest.pairedAt,
          deniedAt,
          roles: newest.roles.filter((role) =>
            ['brain', 'hands', 'screen'].includes(role),
          ),
        }
      const useRemote = valid
        ? !local || remote.pairedAt >= local.pairedAt
        : !local
      // A pass the incoming bundle neither lists nor versions is dropped: a bundle can remove a pass.
      // A newer local pairing still wins over an older incoming entry.
      const hash = !valid && table[id] === undefined ? undefined : useRemote ? table[id] : current[id]
      if (
        hash &&
        /^[0-9a-f]{64}$/.test(hash) &&
        (!authority[id] || authority[id]!.pairedAt > deniedAt)
      )
        clean[id] = hash
    }
    this.writeAuthority(authority)
    this.write(clean)
  }

  /** Authority versions survive database reset and travel with the pass bundle. */
  authority(): Record<string, PairingAuthority> {
    const rawAuthority = this.secrets.get('devicePairingAuthority') ?? '{}',
      rawLegacy = this.secrets.get('devicePairingRoles') ?? '{}'
    // Parsed again only when a stored value changed: this runs on every request.
    if (
      this.authorityCache &&
      this.authorityCache.rawAuthority === rawAuthority &&
      this.authorityCache.rawLegacy === rawLegacy
    )
      return { ...this.authorityCache.value }
    const value = this.parseAuthority(rawAuthority, rawLegacy)
    this.authorityCache = { rawAuthority, rawLegacy, value }
    return { ...value }
  }
  private authorityCache: {
    rawAuthority: string
    rawLegacy: string
    value: Record<string, PairingAuthority>
  } | null = null
  private parseAuthority(
    rawAuthority: string,
    rawLegacy: string,
  ): Record<string, PairingAuthority> {
    try {
      const parsed = JSON.parse(rawAuthority)
      const clean: Record<string, PairingAuthority> = {}
      for (const [id, value] of Object.entries(parsed)) {
        const v = value as PairingAuthority
        if (
          v &&
          Number.isFinite(v.pairedAt) &&
          Number.isFinite(v.deniedAt) &&
          Array.isArray(v.roles)
        )
          clean[id] = v
      }
      // Migrate the earlier unversioned deny conservatively once.
      const legacy = JSON.parse(rawLegacy)
      for (const [id, roles] of Object.entries(legacy))
        if (!clean[id])
          clean[id] = {
            pairedAt: 0,
            deniedAt: roles === null ? 1 : -1,
            roles: Array.isArray(roles)
              ? roles.filter((role): role is DeviceRole =>
                  ['brain', 'hands', 'screen'].includes(role),
                )
              : [],
          }
      return clean
    } catch {
      return {}
    }
  }
  rolesFor(deviceId: string): DeviceRole[] | null {
    if (!this.all()[deviceId] || this.isRevoked(deviceId)) return null
    // A pass whose roles were never learned (no row yet) knows nothing: the caller then falls back to knownPeer or refuses.
    const roles = this.authority()[deviceId]?.roles
    return roles && roles.length > 0 ? roles : null
  }
  isRevoked(deviceId: string): boolean {
    const state = this.authority()[deviceId]
    return !!state && state.deniedAt >= state.pairedAt
  }
  rememberRoles(
    deviceId: string,
    roles: DeviceRole[] | null,
    pairedAt?: number,
  ): void {
    if (roles === null) {
      this.remove(deviceId)
      return
    }
    const authority = this.authority(),
      old = authority[deviceId]
    const at = pairedAt ?? old?.pairedAt ?? 0
    if (old && at <= old.deniedAt) return
    authority[deviceId] = {
      pairedAt: Math.max(at, old?.pairedAt ?? 0),
      deniedAt: old?.deniedAt ?? -1,
      roles,
    }
    this.writeAuthority(authority)
  }
  private writeAuthority(authority: Record<string, PairingAuthority>): void {
    const value = JSON.stringify(authority)
    if (this.secrets.get('devicePairingAuthority') !== value)
      this.secrets.set('devicePairingAuthority', value)
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
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return {}
      const out: Record<string, string> = {}
      for (const [id, hash] of Object.entries(
        parsed as Record<string, unknown>,
      ))
        if (typeof hash === 'string') out[id] = hash
      return out
    } catch {
      return {}
    }
  }

  private write(table: Record<string, string>): void {
    if (JSON.stringify(this.all()) === JSON.stringify(table)) return
    this.cache = { ...table }
    if (Object.keys(table).length === 0) this.secrets.delete(PASS_SECRET)
    else this.secrets.set(PASS_SECRET, JSON.stringify(table))
  }
}
