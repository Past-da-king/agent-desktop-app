/**
 * Round 12 review follow-ups for the pairing authority kept with the device passes: a local revoke always wins,
 * a pass is never silently dropped, and a deny belongs to the pairing it was issued for.
 */
import { expect, it } from 'vitest'

import { PairingOffers, handlePair } from '../src/main/devices/pairing'
import { SecretPassTable, hashPass } from '../src/main/devices/passes'

function table(): { passes: SecretPassTable; data: Map<string, string> } {
  const data = new Map<string, string>()
  const passes = new SecretPassTable({
    get: n => data.get(n) ?? null,
    set: (n, v) => void data.set(n, v),
    delete: n => void data.delete(n),
  })
  return { passes, data }
}

it('R13 m2 a local forget wins when the pairing came from a brain with a faster clock', () => {
  const { passes } = table()
  const ahead = Date.now() + 60_000
  passes.set('dev_x', hashPass('pass'), ahead)
  passes.rememberRoles('dev_x', ['brain'], ahead)
  passes.remove('dev_x')
  expect(passes.isRevoked('dev_x')).toBe(true)
  expect(passes.rolesFor('dev_x')).toBeNull()
})

it('R13 m2 a pass older than the known pairing is moved past it, not dropped', () => {
  const { passes } = table()
  passes.set('dev_x', hashPass('one'), 2000)
  passes.set('dev_x', hashPass('two'), 1500)
  expect(passes.authority()['dev_x']?.pairedAt).toBe(2001)
  expect(passes.all()['dev_x']).toBe(hashPass('two'))
})

it('R13 m1 a deny for a known pairing leaves a later pairing alone', () => {
  const { passes } = table()
  passes.set('dev_x', hashPass('one'), 1000)
  passes.remove('dev_x', 1000)
  expect(passes.isRevoked('dev_x')).toBe(true)
  passes.set('dev_x', hashPass('two'), 1001)
  expect(passes.isRevoked('dev_x')).toBe(false)
  expect(passes.all()['dev_x']).toBe(hashPass('two'))
})

it('R13 n1 an incoming entry with no local one is not read as revoked', () => {
  const { passes } = table()
  passes.replaceAll({ dev_n: hashPass('x') }, { dev_n: { pairedAt: 0, deniedAt: -1, roles: ['hands'] } })
  expect(passes.isRevoked('dev_n')).toBe(false)
  expect(passes.all()['dev_n']).toBe(hashPass('x'))
})

it('R13 n5 the authority is read again when a stored value changes', () => {
  const { passes, data } = table()
  passes.set('dev_x', hashPass('one'), 1000)
  expect(passes.authority()['dev_x']?.pairedAt).toBe(1000)
  data.set('devicePairingAuthority', JSON.stringify({ dev_x: { pairedAt: 5, deniedAt: 9, roles: [] } }))
  expect(passes.isRevoked('dev_x')).toBe(true)
})

it('R13 m2 pairing never issues a pass older than a pairing it already knows', async () => {
  const { passes } = table()
  passes.set('dev_repair_computer', hashPass('one'), 5000)
  const offers = new PairingOffers(() => 1000), offer = offers.create()
  let saved: { pairedAt?: number } | null = null
  const result = await handlePair(
    { code: offer.secret, nodeId: 'dev_repair_computer', wantRoles: ['hands'], device: { kind: 'desktop', platform: 'linux', fingerprint: 'f'.repeat(43) } },
    { offers, passes, meshId: 'mesh_fixture', node: { id: 'node_other', name: 'N' }, now: () => 1000, nextPriority: async () => 0, brains: async () => [],
      saveDevice: async row => { saved = row } },
  )
  expect(result.status).toBe(200)
  expect(saved!.pairedAt).toBeGreaterThan(5000)
  if (result.status === 200) expect(passes.deviceFor(result.json.pass)).toBe('dev_repair_computer')
})

it('R13 a pass with no known roles grants nothing', () => {
  const { passes } = table()
  passes.set('dev_nobody_known', hashPass('pass'), 1000)
  expect(passes.rolesFor('dev_nobody_known')).toBeNull()
  passes.rememberRoles('dev_nobody_known', ['hands'], 1000)
  expect(passes.rolesFor('dev_nobody_known')).toEqual(['hands'])
})
