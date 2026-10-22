/**
 * The pairing link's addresses come best first (a VPN address before a LAN one, a virtual switch last), and a
 * joining node tries the ones that answer first, so an unreachable LAN or container address never stalls pairing.
 * Checked on the live copy, 22 Oct 2026: the Windows Tailscale adapter's addresses are advertised by themselves.
 */
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { addressRank, advertisedUrls } from '../src/main/devices/config'
import { fingerprintOf, makeSelfSignedCert } from '../src/main/devices/cert'
import { reachableFirst } from '../src/headless/pair'

const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

const entry = (address: string, family: 'IPv4' | 'IPv6') => ({ address, family, internal: false, netmask: '', mac: '', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}) })

describe('the addresses a node advertises', () => {
  it('puts the VPN ranges first, then the LAN, then other private ranges, and a virtual switch last', () => {
    const interfaces = {
      'vEthernet (Default Switch)': [entry('172.20.16.1', 'IPv4')],
      docker0: [entry('172.17.0.1', 'IPv4')],
      Ethernet: [entry('192.168.1.35', 'IPv4'), entry('fe80::1', 'IPv6')],
      Tailscale: [entry('fd7a:115c:a1e0::4733:376c', 'IPv6'), entry('100.84.55.108', 'IPv4')],
      'Wi-Fi': [entry('10.0.0.7', 'IPv4')],
    } as unknown as Parameters<typeof advertisedUrls>[1]
    const config = { enabled: true, port: 7787, listen: '0.0.0.0', extraUrls: [], shareGroups: {} }
    expect(advertisedUrls(config, interfaces)).toEqual([
      'https://100.84.55.108:7787',
      'https://[fd7a:115c:a1e0::4733:376c]:7787',
      'https://192.168.1.35:7787',
      'https://10.0.0.7:7787',
      'https://172.20.16.1:7787',
      'https://172.17.0.1:7787',
    ])
    // The person's own address still goes first.
    expect(advertisedUrls({ ...config, extraUrls: ['https://my-node.example.net:7787'] }, interfaces)[0]).toBe('https://my-node.example.net:7787')
    expect(addressRank('100.64.0.1', false)).toBeLessThan(addressRank('192.168.0.2', false))
    expect(addressRank('100.128.0.1', false)).toBeGreaterThan(addressRank('10.1.1.1', false))
    expect(addressRank('192.168.0.2', false, 'docker0')).toBeGreaterThan(addressRank('203.0.113.9', false))
    expect(addressRank('2001:db8::1', true)).toBeGreaterThan(addressRank('fd00::1', true))
  })
})

describe('a joining node tries the addresses that answer first', () => {
  it('probes every address at once with a short timeout and keeps the advertised order among those that answer', async () => {
    const cert = makeSelfSignedCert('Test node')
    const server = createServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    closers.push(() => server.close())
    const port = (server.address() as AddressInfo).port
    // 192.0.2.1 is TEST-NET-1: never answers, the kind of address that used to stall pairing for 15 s.
    const dead = 'https://192.0.2.1:7787'
    const refused = 'https://127.0.0.1:1'
    const live = `https://127.0.0.1:${port}`
    const started = Date.now()
    const order = await reachableFirst([dead, refused, live], fingerprintOf(cert.certDer), 1500)
    expect(order).toEqual([live, dead, refused])
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
