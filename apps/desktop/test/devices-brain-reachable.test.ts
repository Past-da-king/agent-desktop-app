import { describe, expect, it } from 'vitest'

import { brainReachable } from '../src/main/devices/offload-wire'

describe('brainReachable', () => {
  it('counts a server that only dialled in to us as up', () => {
    expect(brainReachable([], (id) => id === 'dev_srv', 'dev_srv')).toBe(true)
  })
  it('counts a good replication link as up', () => {
    expect(brainReachable([{ peer: 'dev_srv', ok: true }], () => false, 'dev_srv')).toBe(true)
  })
  it('is down with a failing link and no connection', () => {
    expect(brainReachable([{ peer: 'dev_srv', ok: false }], () => false, 'dev_srv')).toBe(false)
    expect(brainReachable([{ peer: 'dev_other', ok: true }], (id) => id === 'dev_other', 'dev_srv')).toBe(false)
  })
})
