import { describe, expect, it } from 'vitest'

import type { DeviceRow } from '@agent/core'

import { mergePeers } from '../src/main/devices/replicate'

function row(over: Partial<DeviceRow> & { id: string }): DeviceRow {
  return {
    name: over.id,
    kind: 'desktop',
    platform: 'windows',
    roles: ['brain', 'hands'],
    priority: 0,
    urls: [],
    fp: 'fp_pc',
    facts: null,
    pairedAt: 1,
    lastSeen: 1,
    revoked: false,
    tools: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as unknown as DeviceRow
}

describe('mergePeers', () => {
  const vpn = 'https://100.64.0.1:7787'
  const lan = 'https://192.168.1.35:7787'

  it('keeps trying the paired addresses when a stale row only has a LAN address', () => {
    const peers = mergePeers([row({ id: 'dev_pc', urls: [lan] })], [{ id: 'dev_pc', name: 'PC', urls: [vpn, lan], fp: 'fp_pc' }], 'dev_srv')
    expect(peers).toEqual([{ id: 'dev_pc', name: 'dev_pc', urls: [lan, vpn], fp: 'fp_pc' }])
  })

  it('uses the paired addresses for a row with none', () => {
    expect(mergePeers([row({ id: 'dev_pc' })], [{ id: 'dev_pc', name: 'PC', urls: [vpn], fp: 'fp_pc' }], 'dev_srv')[0]?.urls).toEqual([vpn])
  })

  it('never brings back a revoked row, and ignores addresses for a different key', () => {
    expect(mergePeers([row({ id: 'dev_pc', revoked: true, urls: [lan] })], [{ id: 'dev_pc', name: 'PC', urls: [vpn], fp: 'fp_pc' }], 'dev_srv')).toEqual([])
    expect(mergePeers([row({ id: 'dev_pc', urls: [lan] })], [{ id: 'dev_pc', name: 'PC', urls: [vpn], fp: 'other' }], 'dev_srv')[0]?.urls).toEqual([lan])
  })

  it('adds a paired peer whose row has not arrived, and skips itself', () => {
    const peers = mergePeers([row({ id: 'dev_srv', urls: [lan] })], [{ id: 'dev_pc', name: 'PC', urls: [vpn], fp: 'fp_pc' }], 'dev_srv')
    expect(peers.map((p) => p.id)).toEqual(['dev_pc'])
  })
})
