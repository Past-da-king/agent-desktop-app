import { expect, it } from 'vitest'
import { compareDeviceOrder, hasTiedPriorities } from '@agent/core'
import { rankedBrains } from '../src/main/runtime/turns'
it('uses the displayed pairing order for a tie on every node, independent of mutable names and input order', async () => {
 const rows = [{ id: 'z', name: 'PC', priority: 0, pairedAt: 1, roles: ['brain'], revoked: false }, { id: 'a', name: 'impetix', priority: 0, pairedAt: 2, roles: ['brain'], revoked: false }]
 expect(hasTiedPriorities(rows)).toBe(true)
 expect([...rows].reverse().sort(compareDeviceOrder).map(r=>r.id)).toEqual(['z','a'])
 const ranked = await rankedBrains({list: async()=>rows} as never)
 expect(ranked.map(r=>r.id)).toEqual(['z','a'])
})
