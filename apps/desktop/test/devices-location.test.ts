import { describe, expect, it } from 'vitest'

import { DEFAULT_SHARE, TOOL_GROUPS, cleanTools as cleanToolsHub } from '../src/main/devices/device-tools'
import { cleanTools as cleanToolsFacts } from '../src/main/devices/facts'

// 29 Oct 2026 (Ayanda): agents must be able to get his phone's location. The phone lends phone_location in its own
// "location" group (phone 0.15.3+); the computer keeps that group instead of filing it under "other".
const hello = [{ name: 'phone_location', description: 'Where the phone is', params: { type: 'object', properties: { max_age: { type: 'integer' } } }, group: 'location', readOnly: true }]

describe('phone location group', () => {
  it('keeps the location group from a phone hello on both paths', () => {
    expect(TOOL_GROUPS).toContain('location')
    expect(DEFAULT_SHARE.location).toBe(true)
    for (const clean of [cleanToolsHub, cleanToolsFacts]) {
      const [tool] = clean(hello)
      expect(tool?.name).toBe('phone_location')
      expect(tool?.group).toBe('location')
      expect(tool?.readOnly).toBe(true)
    }
  })
})
