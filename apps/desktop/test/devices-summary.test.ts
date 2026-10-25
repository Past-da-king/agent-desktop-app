/**
 * Where the app says how far the agent reaches (account line, title bar, Home, Connections) it reads the real linked
 * devices, not "This computer only" or a "Coming soon" machine that already exists.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { DeviceRow, DevicesStatus } from '@agent/core'

import { summarizeDevices } from '../src/renderer/lib/devices-summary'

function status(extra: Partial<DevicesStatus> = {}): DevicesStatus {
  return {
    enabled: true, running: true, port: 7787, urls: [], extraUrls: [], nodeId: 'self', viewer: 'self', nodeName: 'PC', fp: '', fpWords: '',
    connected: [], error: '', shareGroups: { browser: true, files: true, notifications: true, approval: true, shell: false },
    firewall: 'allowed', servingTo: '', ...extra,
  }
}

function device(id: string, extra: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id, createdAt: 1, name: id, kind: 'desktop', platform: 'windows', roles: ['brain', 'hands'], priority: 1, urls: [], fp: '',
    facts: { name: id, kind: 'desktop', platform: 'windows', appVersion: '0', screen: { width: 0, height: 0 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] },
    pairedAt: 1, lastSeen: 1, revoked: false, ...extra,
  }
}

describe('the linked devices in one line', () => {
  it('counts the other devices, not this one and not a taken-out one', () => {
    const rows = [device('self'), device('server', { kind: 'server' }), device('phone', { kind: 'phone', roles: ['screen'] }), device('old', { revoked: true }), device('pc2')]
    const sum = summarizeDevices(status({ connected: ['server'] }), rows)
    expect(sum.count).toBe(3)
    expect(sum.line).toBe('3 devices linked')
    expect(sum.online).toBe(1)
    expect(sum.brains.map((d) => d.id)).toEqual(['server', 'pc2'])
    expect(sum.brains[0]?.online).toBe(true)
    expect(sum.brains[1]?.online).toBe(false)
  })

  it('counts a device this computer reaches by its own replication link as online (a server it dials)', () => {
    const sum = summarizeDevices(status({ connected: [], linked: ['server'] }), [device('self'), device('server', { kind: 'server' })])
    expect(sum.brains[0]?.online).toBe(true)
    expect(sum.online).toBe(1)
  })

  it('says one device in the singular', () => {
    expect(summarizeDevices(status(), [device('self'), device('server')]).line).toBe('1 device linked')
  })

  it('is this computer only when Devices is off, unread, or nothing else is linked', () => {
    expect(summarizeDevices(status({ enabled: false }), [device('server')]).line).toBe('This computer only')
    expect(summarizeDevices(null, [device('server')]).count).toBe(0)
    expect(summarizeDevices(status(), [device('self')]).line).toBe('This computer only')
  })

  it('lists brains first tried first', () => {
    const sum = summarizeDevices(status(), [device('b', { priority: 2 }), device('a', { priority: 1 })])
    expect(sum.brains.map((d) => d.id)).toEqual(['a', 'b'])
  })
})

describe('no "Coming soon" for machines that can already be linked', () => {
  const read = (file: string): string => fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')

  it('Home and Connections draw the real linked machines', () => {
    for (const file of ['views/Home.tsx', 'views/Connections.tsx']) {
      const src = read(file)
      expect(src).toMatch(/<Machines look=/)
      expect(src).not.toMatch(/Another machine/)
      expect(src).not.toMatch(/Coming soon/)
    }
    expect(read('views/Connections.tsx')).not.toMatch(/comingSoon/)
  })

  it('the account line and the title bar read the linked devices', () => {
    expect(read('shell/Rail.tsx')).not.toMatch(/'This computer only'/)
    expect(read('shell/TitleBar.tsx')).not.toMatch(/'This computer only'/)
  })
})
